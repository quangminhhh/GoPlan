/**
 * Abort and general-temp purge barriers for private-media flows (D20).
 *
 * The problem this solves is narrow and specific. Protected assets, photo list,
 * upload and delete all authenticate, so all of them can trigger a token
 * refresh — `fetchProtectedResponse` directly, the Axios calls through the
 * response interceptor in `shared/api/client.ts`. A refresh that settles after
 * `clearTokens()` writes a fresh access token back into a store the user just
 * signed out of, and a purge queued by the old session deletes files the new one
 * has already staged.
 *
 * Global credential publication/retry safety lives in
 * `shared/api/authSessionLifecycle.ts`; this registry is not an auth-session
 * barrier by itself. Private-media operations still register their *whole*
 * promise here so background/sign-out can abort network work and coordinate the
 * general protected-cache/upload-temp purge independently from credential close
 * and the dedicated PhotoKit commit fence.
 *
 * No native module is imported here: purgers register themselves, so this module
 * never needs to know what a file is.
 */

import { ProtectedAssetError } from './protectedAssetTypes';

/** Fixed, typed set. A purger is never addressed by a caller-supplied path. */
export type PrivateMediaPurgerName = 'protected-assets' | 'upload-temp';

const SESSION_CLOSED_MESSAGE = 'This session is no longer active.';

const purgers = new Map<PrivateMediaPurgerName, () => Promise<void>>();
const controllers = new Set<AbortController>();
const activity = new Set<Promise<unknown>>();
const generationListeners = new Set<() => void>();
const transferLeaseIdleWaiters = new Set<() => void>();

let sessionActive = false;
let acquisitionOpen = false;
let sessionEpoch = 0;
/** Invalidates stale async start/resume continuations across foreground/session ABA transitions. */
let activationVersion = 0;
let generation = 0;
let transferLeases = 0;
let purgeDeferred = false;
let protectedAssetPurgeTail: Promise<void> = Promise.resolve();
let uploadTempPurgeTail: Promise<void> = Promise.resolve();
/**
 * Moves synchronously whenever work is appended to either namespace queue.
 *
 * Promise settlement alone is not a sufficient hand-off barrier: another
 * microtask can enqueue cleanup after `flushPrivateMediaPurge()` has observed
 * settled tails but before an awaiting start/resume continuation runs. Openers
 * compare this revision immediately before opening the gate, closing that gap.
 */
let purgeRevision = 0;
/** Last AppState intent, including events that arrive while startup purge runs. */
let foregroundDesired = true;

/**
 * Registered at module scope by each namespace owner. Keeping the list here
 * rather than passing purge callbacks around means a background purge cleans
 * both the protected-asset staging directory and the upload temp directory
 * without either module knowing the other exists.
 */
export function registerPrivateMediaPurger(
  name: PrivateMediaPurgerName,
  purge: () => Promise<void>,
): void {
  purgers.set(name, purge);
}

export function isPrivateMediaSessionOpen(): boolean {
  return acquisitionOpen;
}

/**
 * Incremented synchronously by every invalidation front half, before any file is
 * deleted. A staged download compares the epoch it started under against this
 * value before committing, so a response that arrives after sign-out discards
 * its file instead of recreating private bytes in a signed-out app.
 */
export function getPrivateMediaEpoch(): number {
  return sessionEpoch;
}

export function getPrivateMediaGeneration(): number {
  return generation;
}

/**
 * Mounted images subscribe to drop their local URI the moment a purge starts and
 * to reacquire once the gate is open again. The generation is published twice
 * per background round trip — once in the front half, once after resume — which
 * is what keeps a component from re-fetching while the app is still in the
 * background.
 */
export function subscribeToPrivateMediaGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => {
    generationListeners.delete(listener);
  };
}

function publishGeneration(): void {
  generation += 1;
  for (const listener of Array.from(generationListeners)) {
    try {
      listener();
    } catch {
      // A subscriber that throws must not stop the abort loop that follows this
      // call, which is the part that actually protects the session boundary.
    }
  }
}

export function createSessionClosedError(): ProtectedAssetError {
  return new ProtectedAssetError('cancelled', SESSION_CLOSED_MESSAGE);
}

/**
 * Runs `operation` as tracked private-network activity.
 *
 * Registration is synchronous: by the time this returns, sign-out can already
 * see and abort the operation. The promise leaves the registry only after
 * everything nested inside it has settled, so an Axios 401 retry counts as part
 * of the operation that started it rather than as untracked work.
 */
export function trackPrivateOperation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!acquisitionOpen) {
    return Promise.reject(createSessionClosedError());
  }

  const controller = new AbortController();
  controllers.add(controller);

  let operation: Promise<T>;
  try {
    operation = run(controller.signal);
  } catch (error) {
    controllers.delete(controller);
    return Promise.reject(error);
  }

  activity.add(operation);
  const settle = (): void => {
    controllers.delete(controller);
    activity.delete(operation);
  };
  // Both handlers are supplied, so this derived promise can never surface as an
  // unhandled rejection; the caller still owns the original.
  operation.then(settle, settle);

  return operation;
}

/**
 * One controller fed by several signals. `AbortSignal.any` is not dependable
 * across the RN and Jest runtimes this code has to run in, and the linkage is a
 * few lines.
 */
export function linkAbortSignals(signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  for (const source of signals) {
    if (!source) {
      continue;
    }
    if (source.aborted) {
      controller.abort();
      break;
    }
    const forward = (): void => controller.abort();
    source.addEventListener('abort', forward);
    cleanups.push(() => source.removeEventListener('abort', forward));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

/**
 * Tracked private-network activity for a caller that has its own abort signal —
 * the shape every photo API function needs. The run receives a signal that fires
 * when either the caller or the session boundary says stop.
 */
export function trackPrivateRequest<T>(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return trackPrivateOperation(async (lifecycleSignal) => {
    const linked = linkAbortSignals([callerSignal, lifecycleSignal]);
    try {
      return await run(linked.signal);
    } finally {
      linked.dispose();
    }
  });
}

/**
 * Waits for private-network activity that already exists. It never starts a
 * request or a refresh of its own — sign-out must not be able to extend the
 * lifetime of the credentials it is about to revoke.
 */
export async function waitForPrivateNetworkIdle(): Promise<void> {
  while (activity.size > 0) {
    await Promise.allSettled(Array.from(activity));
  }
}

/**
 * Marks a preprocess/upload flow that owns a general temporary file.
 * Backgrounding defers that namespace's purge until the last lease releases so
 * the OS does not delete a file mid-transfer. Photos save uses its dedicated
 * current-file commit fence; mobile no longer stages/shares a ZIP. Sign-out
 * still aborts work synchronously, but the upload-temp purger waits for the
 * active native/request lease to settle before deleting its exact inputs.
 *
 * @throws ProtectedAssetError `cancelled` when the gate is already closed.
 */
export function acquirePrivateTransferLease(): () => void {
  if (!acquisitionOpen) {
    throw createSessionClosedError();
  }

  transferLeases += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    transferLeases -= 1;
    if (transferLeases === 0) {
      const waiters = Array.from(transferLeaseIdleWaiters);
      transferLeaseIdleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
    if (transferLeases === 0 && purgeDeferred) {
      if (sessionActive && foregroundDesired) {
        // Foreground intent wins even when the async resume continuation has not
        // run yet. A later suspend flips `foregroundDesired` back to false, so a
        // lease released for the genuinely backgrounded state still purges.
        purgeDeferred = false;
      } else {
        runInvalidationFrontHalf();
      }
    }
  };
}

export function getPrivateTransferLeaseCount(): number {
  return transferLeases;
}

async function waitForTransferLeasesToSettle(): Promise<void> {
  if (transferLeases === 0) return;
  await new Promise<void>((resolve) => {
    transferLeaseIdleWaiters.add(resolve);
    // Lease release and waiter registration are synchronous, but retain this
    // re-check so future native lease adapters cannot introduce a lost wake-up.
    if (transferLeases === 0 && transferLeaseIdleWaiters.delete(resolve)) {
      resolve();
    }
  });
}

async function runPurger(name: PrivateMediaPurgerName): Promise<void> {
  const purge = purgers.get(name);
  if (!purge) return;
  try {
    await purge();
  } catch {
    // Cleanup is best effort by contract: a file the OS refuses to delete must
    // not leave the queue jammed for the session that comes next.
  }
}

function enqueuePurge(): Promise<void> {
  purgeRevision += 1;

  // Protected cache files are not upload request bodies. Purge them on the
  // boundary immediately, even while an upload-temp lease is still active.
  protectedAssetPurgeTail = protectedAssetPurgeTail.then(
    () => runPurger('protected-assets'),
    () => runPurger('protected-assets'),
  );

  // Upload-temp files may still be read by native preprocessing or Axios. The
  // namespace purge therefore owns a separate queue and cannot run until every
  // lease that existed when the gate closed has settled. Because the gate is
  // already closed, no new lease can appear behind this fence.
  uploadTempPurgeTail = uploadTempPurgeTail.then(
    async () => {
      await waitForTransferLeasesToSettle();
      await runPurger('upload-temp');
    },
    async () => {
      await waitForTransferLeasesToSettle();
      await runPurger('upload-temp');
    },
  );

  return Promise.allSettled([protectedAssetPurgeTail, uploadTempPurgeTail]).then(
    () => undefined,
  );
}

/**
 * Drains the purge queue, including work enqueued while this was awaiting. The
 * loop matters: a session that starts while the previous session's cleanup is
 * still running must not open its gate until that cleanup is finished, or the
 * old purge deletes files the new session has already staged.
 */
export async function flushPrivateMediaPurge(): Promise<void> {
  let awaitedProtected: Promise<void> | null = null;
  let awaitedUpload: Promise<void> | null = null;
  while (
    awaitedProtected !== protectedAssetPurgeTail ||
    awaitedUpload !== uploadTempPurgeTail
  ) {
    awaitedProtected = protectedAssetPurgeTail;
    awaitedUpload = uploadTempPurgeTail;
    await Promise.allSettled([awaitedProtected, awaitedUpload]);
  }
}

/**
 * The synchronous half of every session boundary.
 *
 * Order is the whole point. The epoch moves and the registry is cleared before
 * anything is aborted and long before a file is deleted, so there is no window
 * in which an in-flight completion can observe the old epoch and commit.
 */
function runInvalidationFrontHalf(): void {
  acquisitionOpen = false;
  purgeDeferred = false;
  sessionEpoch += 1;

  const aborted = Array.from(controllers);
  controllers.clear();

  publishGeneration();

  for (const controller of aborted) {
    controller.abort();
  }

  void enqueuePurge();
}

/**
 * Call at the very start of sign-out, before the logout request — the caller
 * then awaits `waitForPrivateNetworkIdle()` before reading the refresh token.
 */
export function beginPrivateMediaShutdown(): void {
  activationVersion += 1;
  sessionActive = false;
  runInvalidationFrontHalf();
}

/** Sign-out barrier as one call, for the paths that do not interleave a logout. */
export async function endPrivateMediaSession(): Promise<void> {
  beginPrivateMediaShutdown();
  await waitForPrivateNetworkIdle();
  await flushPrivateMediaPurge();
}

/**
 * Opens only from the latest foreground/session activation and only after a
 * stable purge-tail hand-off.
 *
 * `flushPrivateMediaPurge()` follows work appended while it is awaiting, but an
 * enqueue can still land after that function's final tail comparison and before
 * this continuation resumes. The revision comparison catches exactly that
 * microtask window. No await separates the final comparison from opening the
 * gate, so cleanup cannot be appended between the check and the state change.
 */
async function openAfterStablePurge(activationAtStart: number): Promise<void> {
  for (;;) {
    const revisionBeforeDrain = purgeRevision;
    await flushPrivateMediaPurge();

    if (
      activationVersion !== activationAtStart ||
      !sessionActive ||
      !foregroundDesired
    ) {
      return;
    }
    if (revisionBeforeDrain !== purgeRevision) {
      continue;
    }

    purgeDeferred = false;
    acquisitionOpen = true;
    publishGeneration();
    return;
  }
}

/**
 * Opens a clean session. Cleanup owned by any previous session is drained first
 * and this session's own purge is awaited second, so the gate only opens once
 * the staging namespaces are known to be empty.
 */
export async function startPrivateMediaSession(startInForeground = true): Promise<void> {
  const activationAtStart = ++activationVersion;
  sessionActive = true;
  acquisitionOpen = false;
  foregroundDesired = startInForeground;

  // Append this session's cleanup before the first await. AppState can deliver a
  // suspend followed by a resume in the same turn; if enqueueing happened after
  // an initial flush, that resume could otherwise open on the old settled tail
  // while this purge was only just being appended.
  void enqueuePurge();
  await openAfterStablePurge(activationAtStart);
}

/**
 * App moved to background. New work is refused either way; whether the purge
 * runs now or waits depends on an active transfer holding files it still needs.
 */
export function suspendPrivateMediaSession(): void {
  foregroundDesired = false;
  activationVersion += 1;
  if (!sessionActive || !acquisitionOpen) {
    return;
  }
  acquisitionOpen = false;
  if (transferLeases > 0) {
    purgeDeferred = true;
    return;
  }
  runInvalidationFrontHalf();
}

/**
 * App returned to foreground. Deferred and queued purges settle, then the gate
 * opens, and only then is the generation published — mounted images must not be
 * able to issue a request in the window between those steps.
 */
export async function resumePrivateMediaSession(): Promise<void> {
  foregroundDesired = true;
  if (!sessionActive || acquisitionOpen) {
    return;
  }
  const activationAtStart = ++activationVersion;
  await openAfterStablePurge(activationAtStart);
}

/**
 * Resets singleton state between Jest suites. Registered purgers survive: they
 * are installed at module import, which happens once per module registry.
 */
export function __resetPrivateMediaLifecycleForTests(): void {
  controllers.clear();
  activity.clear();
  generationListeners.clear();
  sessionActive = false;
  acquisitionOpen = false;
  sessionEpoch = 0;
  activationVersion = 0;
  generation = 0;
  transferLeases = 0;
  for (const resolve of Array.from(transferLeaseIdleWaiters)) resolve();
  transferLeaseIdleWaiters.clear();
  purgeDeferred = false;
  protectedAssetPurgeTail = Promise.resolve();
  uploadTempPurgeTail = Promise.resolve();
  purgeRevision = 0;
  foregroundDesired = true;
}

/** Test-only registry view for cold-start bootstrap coverage. */
export function __getPrivateMediaPurgerNamesForTests(): PrivateMediaPurgerName[] {
  return Array.from(purgers.keys());
}

/** Test-only isolation helper; production registration is process-lifetime. */
export function __clearPrivateMediaPurgersForTests(): void {
  purgers.clear();
}
