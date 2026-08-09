import { clearTokens, setAccessToken } from './token-store';

export type AuthPhase = 'signedOut' | 'opening' | 'active' | 'closing';

export interface AuthTicket {
  sessionGeneration: number;
  credentialRevision: number;
}

export interface AuthPair {
  access: string;
  refresh: string;
}

export interface AuthLifecycleSnapshot extends AuthTicket {
  phase: AuthPhase;
  access: string | null;
}

export type AuthCloseReason =
  | 'user'
  | 'refreshFailure'
  | 'restoreFailure'
  | 'credentialFailure';

export interface AuthCloseContext {
  reason: AuthCloseReason;
  source: AuthTicket;
  closingGeneration: number;
}

export interface AuthCloseEffects {
  /** Runs after token invalidation and before lifecycle subscribers are notified. */
  onClosing?: (context: AuthCloseContext) => void;
  /** Runs after lifecycle subscribers, still in the synchronous front half. */
  onClosingPublished?: (context: AuthCloseContext) => void;
  /** Drains protected network work after credential activity and before revoke. */
  beforeRevoke?: (context: AuthCloseContext) => Promise<void>;
  /** Best-effort server revocation. Local credential clearing always follows. */
  revoke?: (pair: AuthPair, context: AuthCloseContext) => Promise<void>;
}

export interface CredentialActivity {
  readonly ticket: AuthTicket;
  /**
   * Makes a server-issued pair visible to close handoff before persistence.
   * A stale ticket is ignored.
   */
  recordCandidate(pair: AuthPair, ticket?: AuthTicket): boolean;
  /** Idempotently releases this activity from the close barrier. */
  finish(): void;
}

interface PairCandidate {
  pair: AuthPair;
  ticket: AuthTicket;
  sequence: number;
}

interface ActivityRecord {
  sourceGeneration: number;
  settled: Promise<void>;
  resolve: () => void;
}

type LifecycleListener = (snapshot: AuthLifecycleSnapshot) => void;

let phase: AuthPhase = 'signedOut';
let sessionGeneration = 0;
let credentialRevision = 0;
let publishedAccess: string | null = null;
let activePair: PairCandidate | null = null;
let latestCandidate: PairCandidate | null = null;
let closingSource: AuthTicket | null = null;
let closingHandoff: PairCandidate | null = null;
let candidateSequence = 0;

let closeEffects: AuthCloseEffects | null = null;
let closePromise: Promise<void> | null = null;
let closeResolve: (() => void) | null = null;

const listeners = new Set<LifecycleListener>();
const activities = new Set<ActivityRecord>();

const TOKEN_CLEAR_RETRY_INITIAL_DELAY_MS = 100;
const TOKEN_CLEAR_RETRY_MAX_DELAY_MS = 5_000;

function sameTicket(left: AuthTicket, right: AuthTicket): boolean {
  return (
    left.sessionGeneration === right.sessionGeneration &&
    left.credentialRevision === right.credentialRevision
  );
}

function currentTicket(): AuthTicket {
  return { sessionGeneration, credentialRevision };
}

function sourceTicketIsCurrent(ticket: AuthTicket): boolean {
  if (phase === 'opening' || phase === 'active') {
    return sameTicket(ticket, currentTicket());
  }
  return phase === 'closing' && closingSource !== null && sameTicket(ticket, closingSource);
}

function setPublishedAccess(access: string | null): void {
  publishedAccess = access;
  setAccessToken(access);
}

function publishLifecycle(): void {
  const snapshot = getAuthSnapshot();
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch {
      // Closing is a security boundary. One consumer must not prevent the rest
      // from observing it because its own cleanup callback threw.
    }
  }
}

function newerCandidate(
  current: PairCandidate | null,
  candidate: PairCandidate | null,
): PairCandidate | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  if (candidate.ticket.credentialRevision !== current.ticket.credentialRevision) {
    return candidate.ticket.credentialRevision > current.ticket.credentialRevision
      ? candidate
      : current;
  }
  return candidate.sequence > current.sequence ? candidate : current;
}

function makeCandidate(ticket: AuthTicket, pair: AuthPair): PairCandidate {
  candidateSequence += 1;
  // Copy only the credential fields. Callers may hold a wider server payload
  // (for example `token_type`); handoff must remain the minimal secret pair.
  return {
    pair: { access: pair.access, refresh: pair.refresh },
    ticket: { ...ticket },
    sequence: candidateSequence,
  };
}

/** Atomic auth state used by request interceptors and long-running features. */
export function getAuthSnapshot(): AuthLifecycleSnapshot {
  return {
    phase,
    sessionGeneration,
    credentialRevision,
    access: publishedAccess,
  };
}

/** Captures only a generation in which new authenticated work is allowed. */
export function captureAuthTicket(): AuthTicket | null {
  if (phase !== 'opening' && phase !== 'active') {
    return null;
  }
  return currentTicket();
}

export function isAuthTicketCurrent(ticket: AuthTicket): boolean {
  return (
    (phase === 'opening' || phase === 'active') &&
    sameTicket(ticket, currentTicket())
  );
}

export function subscribeAuthLifecycle(listener: LifecycleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAuthCloseEffects(effects: AuthCloseEffects | null): void {
  closeEffects = effects;
}

/** Waits for a shared close already in progress; it never starts one. */
export async function waitForAuthClose(): Promise<void> {
  await closePromise;
}

/**
 * Starts a credential-opening generation after the previous close has drained.
 * The generation moves before publication so stale callbacks fail immediately.
 */
export async function beginAuthSessionOpening(): Promise<AuthTicket> {
  await waitForAuthClose();

  if (phase === 'opening') {
    return currentTicket();
  }
  if (phase !== 'signedOut') {
    throw new Error('An auth session is already active.');
  }

  sessionGeneration += 1;
  credentialRevision = 0;
  phase = 'opening';
  publishedAccess = null;
  activePair = null;
  latestCandidate = null;
  closingSource = null;
  closingHandoff = null;
  publishLifecycle();
  return currentTicket();
}

/**
 * Registers an operation before its first await/send. Close refuses new
 * registrations and drains every operation from its source generation.
 */
export function beginCredentialActivity(ticket: AuthTicket): CredentialActivity | null {
  if (!isAuthTicketCurrent(ticket)) {
    return null;
  }

  let resolveSettled: () => void = () => undefined;
  const record: ActivityRecord = {
    sourceGeneration: ticket.sessionGeneration,
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve;
    }),
    resolve: () => undefined,
  };
  record.resolve = resolveSettled;
  activities.add(record);
  let finished = false;

  return {
    ticket: { ...ticket },
    recordCandidate: (pair, candidateTicket = ticket) =>
      recordAuthPairCandidate(candidateTicket, pair),
    finish: () => {
      if (finished) return;
      finished = true;
      activities.delete(record);
      record.resolve();
    },
  };
}

/** Records a response pair without publishing it to request callers. */
export function recordAuthPairCandidate(ticket: AuthTicket, pair: AuthPair): boolean {
  if (!sourceTicketIsCurrent(ticket)) {
    return false;
  }

  const candidate = makeCandidate(ticket, pair);
  latestCandidate = newerCandidate(latestCandidate, candidate);
  if (phase === 'closing') {
    closingHandoff = newerCandidate(closingHandoff, candidate);
  }
  return true;
}

/**
 * Advances the password-rotation revision as soon as the HTTP response exists.
 * Old refresh completions become stale before the new SecureStore write begins.
 */
export function beginAuthCredentialRotation(
  source: AuthTicket,
  pair: AuthPair,
): AuthTicket | null {
  if (!sourceTicketIsCurrent(source)) {
    return null;
  }

  credentialRevision += 1;
  const rotated: AuthTicket = {
    sessionGeneration: source.sessionGeneration,
    credentialRevision,
  };
  if (phase === 'closing') {
    closingSource = rotated;
  }
  recordAuthPairCandidate(rotated, pair);
  publishLifecycle();
  return rotated;
}

/**
 * Publishes only after the matching refresh token has durably persisted.
 * `opening` publication is intentionally allowed so restore can call `/me`.
 */
export function publishAuthPair(ticket: AuthTicket, pair: AuthPair): boolean {
  if (!isAuthTicketCurrent(ticket)) {
    return false;
  }

  const candidate = makeCandidate(ticket, pair);
  activePair = candidate;
  latestCandidate = newerCandidate(latestCandidate, candidate);
  setPublishedAccess(pair.access);
  publishLifecycle();
  return true;
}

export function activateAuthSession(ticket: AuthTicket): boolean {
  if (phase !== 'opening' || !sameTicket(ticket, currentTicket())) {
    return false;
  }
  if (activePair === null || !sameTicket(activePair.ticket, ticket)) {
    return false;
  }
  phase = 'active';
  publishLifecycle();
  return true;
}

async function drainCredentialActivities(sourceGeneration: number): Promise<void> {
  for (;;) {
    const pending = Array.from(activities)
      .filter((activity) => activity.sourceGeneration === sourceGeneration)
      .map((activity) => activity.settled);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

function waitForTokenClearRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Keeps the auth gate closed until SecureStore confirms deletion. A native
 * operation is never timed out: if it is still capable of committing an older
 * token, opening another session would let that late write overwrite session B.
 *
 * Rejected calls are retried with a bounded delay. Attempts intentionally have
 * no maximum count because treating repeated deletion failure as signed out
 * would leave a durable credential that cold restore could adopt again.
 */
async function clearTokensDurably(): Promise<void> {
  let retryDelayMs = TOKEN_CLEAR_RETRY_INITIAL_DELAY_MS;

  for (;;) {
    try {
      await clearTokens();
      return;
    } catch {
      await waitForTokenClearRetry(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, TOKEN_CLEAR_RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * Runs the one shared close workflow. State invalidation is synchronous; the
 * returned promise covers credential activity, revoke, and queued SecureStore
 * deletion. Concurrent callers receive this exact promise.
 */
export function requestAuthSessionClose(reason: AuthCloseReason): Promise<void> {
  if (closePromise !== null) {
    return closePromise;
  }
  if (phase === 'signedOut') {
    return Promise.resolve();
  }

  const source = currentTicket();
  const effectsAtStart = closeEffects;
  const context: AuthCloseContext = {
    reason,
    source,
    closingGeneration: sessionGeneration + 1,
  };

  // Install the shared promise before notifying subscribers. A synchronous
  // subscriber may itself request close and must join rather than recurse.
  closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const sharedClose = closePromise;

  closingSource = source;
  closingHandoff = newerCandidate(activePair, latestCandidate);
  phase = 'closing';
  sessionGeneration = context.closingGeneration;
  setPublishedAccess(null);
  try {
    effectsAtStart?.onClosing?.(context);
  } catch {
    // Local credential clearing remains mandatory even if UI/media cleanup has
    // its own defect.
  }
  publishLifecycle();
  try {
    effectsAtStart?.onClosingPublished?.(context);
  } catch {
    // UI publication is best effort and cannot weaken credential clearing.
  }

  void (async () => {
    await drainCredentialActivities(source.sessionGeneration);

    if (effectsAtStart?.beforeRevoke) {
      try {
        await effectsAtStart.beforeRevoke(context);
      } catch {
        // This is a local drain barrier, not a best-effort remote effect. Its
        // implementation owns recovery/cleanup, while credential deletion below
        // remains mandatory even if the drain itself reports a defect.
      }
    }

    const handoff = closingHandoff;
    if (
      handoff !== null &&
      handoff.ticket.sessionGeneration === source.sessionGeneration &&
      effectsAtStart?.revoke
    ) {
      try {
        await effectsAtStart.revoke(handoff.pair, context);
      } catch {
        // Revocation is best effort. Local sign-out must always finish.
      }
    }

    // Token-store writes are serialized. This delete is therefore queued after
    // every tracked persistence promise that just drained.
    await clearTokensDurably();

    activePair = null;
    latestCandidate = null;
    closingHandoff = null;
    closingSource = null;
    publishedAccess = null;
    phase = 'signedOut';
    publishLifecycle();

    const resolve = closeResolve;
    closeResolve = null;
    closePromise = null;
    resolve?.();
  })();

  return sharedClose;
}

/** Test-only state isolation. Every pending operation must be settled first. */
export function __resetAuthSessionLifecycleForTests(): void {
  phase = 'signedOut';
  sessionGeneration = 0;
  credentialRevision = 0;
  publishedAccess = null;
  activePair = null;
  latestCandidate = null;
  closingSource = null;
  closingHandoff = null;
  candidateSequence = 0;
  closeEffects = null;
  closePromise = null;
  closeResolve = null;
  listeners.clear();
  for (const activity of activities) {
    activity.resolve();
  }
  activities.clear();
  setAccessToken(null);
}

export function __getClosingAuthPairForTests(): AuthPair | null {
  return closingHandoff?.pair ?? null;
}
