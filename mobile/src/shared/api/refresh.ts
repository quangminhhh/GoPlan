import { create } from 'axios';
import {
  beginAuthCredentialRotation,
  beginCredentialActivity,
  captureAuthTicket,
  getAuthSnapshot,
  isAuthTicketCurrent,
  publishAuthPair,
  requestAuthSessionClose,
  type AuthPair,
  type AuthTicket,
} from './authSessionLifecycle';
import { getApiBaseUrl } from './base-url';
import { getRefreshToken, setRefreshToken } from './token-store';

interface RefreshResponse {
  access: string;
  refresh: string;
}

interface RawRefreshResult {
  access: string | null;
  hardFailure: boolean;
}

interface RefreshFlight {
  ticket: AuthTicket;
  promise: Promise<RawRefreshResult>;
}

interface RotationFlight {
  ticket: AuthTicket;
  promise: Promise<boolean>;
}

export const REFRESH_TIMEOUT_MS = 15_000;

// Bare instance: it must never share apiClient's interceptors, otherwise a
// failing refresh recursively attempts to refresh itself.
export const refreshHttp = create({ timeout: REFRESH_TIMEOUT_MS });

const refreshFlights = new Map<string, RefreshFlight>();
let rotationInFlight: RotationFlight | null = null;
let onRefreshFailed: (() => void) | null = null;

function ticketKey(ticket: AuthTicket): string {
  return `${ticket.sessionGeneration}:${ticket.credentialRevision}`;
}

function sameSession(left: AuthTicket, right: AuthTicket): boolean {
  return left.sessionGeneration === right.sessionGeneration;
}

export function setOnRefreshFailed(handler: (() => void) | null): void {
  onRefreshFailed = handler;
}

async function accessAfterRotation(source: AuthTicket): Promise<string | null> {
  const rotation = rotationInFlight;
  if (rotation && sameSession(rotation.ticket, source)) {
    try {
      await rotation.promise;
    } catch {
      return null;
    }
  }

  const snapshot = getAuthSnapshot();
  if (
    (snapshot.phase === 'opening' || snapshot.phase === 'active') &&
    snapshot.sessionGeneration === source.sessionGeneration &&
    snapshot.credentialRevision >= source.credentialRevision
  ) {
    return snapshot.access;
  }
  return null;
}

/**
 * Single-flight is scoped to the exact auth ticket. An old generation can
 * never join a new session's flight and receive its access token.
 */
export function refreshTokens(expectedTicket: AuthTicket | null = captureAuthTicket()): Promise<string | null> {
  if (expectedTicket === null) {
    return Promise.resolve(null);
  }

  const rotation = rotationInFlight;
  if (rotation && sameSession(rotation.ticket, expectedTicket)) {
    return accessAfterRotation(expectedTicket);
  }

  if (!isAuthTicketCurrent(expectedTicket)) {
    return accessAfterRotation(expectedTicket);
  }

  const key = ticketKey(expectedTicket);
  let flight = refreshFlights.get(key);
  if (!flight) {
    const activity = beginCredentialActivity(expectedTicket);
    if (activity === null) {
      return Promise.resolve(null);
    }

    const promise = doRefresh(expectedTicket, activity.recordCandidate)
      .then((result) => {
        activity.finish();
        if (result.hardFailure) {
          // The activity has left the registry before close starts, so close can
          // wait for all raw attempts without waiting on the promise that is
          // currently requesting close (self-deadlock).
          void requestAuthSessionClose('refreshFailure');
          try {
            onRefreshFailed?.();
          } catch {
            // A legacy observer is informational; the lifecycle owns closing.
          }
        }
        return result;
      }, (error: unknown) => {
        activity.finish();
        throw error;
      })
      .finally(() => {
        const current = refreshFlights.get(key);
        if (current?.promise === promise) {
          refreshFlights.delete(key);
        }
      });

    flight = { ticket: { ...expectedTicket }, promise };
    refreshFlights.set(key, flight);
  }

  return flight.promise.then(async ({ access }) => {
    if (isAuthTicketCurrent(expectedTicket)) {
      return access;
    }
    return accessAfterRotation(expectedTicket);
  });
}

async function doRefresh(
  ticket: AuthTicket,
  recordCandidate: (pair: AuthPair, ticket?: AuthTicket) => boolean,
): Promise<RawRefreshResult> {
  const refresh = await getRefreshToken();
  if (!isAuthTicketCurrent(ticket)) {
    return { access: await accessAfterRotation(ticket), hardFailure: false };
  }
  if (!refresh) {
    return { access: null, hardFailure: false };
  }

  try {
    // No sign-out signal is attached. A request sent before close is allowed to
    // settle so its rotated pair can become the authoritative revoke handoff.
    const { data } = await refreshHttp.post<RefreshResponse>(
      `${getApiBaseUrl()}/auth/refresh`,
      { refresh },
    );
    const pair = { access: data.access, refresh: data.refresh };

    // This is deliberately before the first persistence await. Close crossing
    // the native write can now see A2/R2 even though it must not publish A2.
    if (!recordCandidate(pair, ticket)) {
      return { access: await accessAfterRotation(ticket), hardFailure: false };
    }
    if (!isAuthTicketCurrent(ticket)) {
      return { access: null, hardFailure: false };
    }

    // The queue call itself is synchronous. A close that begins after this line
    // sees the raw attempt in its activity registry and deletes only after the
    // pending native write has settled.
    await setRefreshToken(pair.refresh);
    if (!isAuthTicketCurrent(ticket)) {
      return { access: null, hardFailure: false };
    }
    if (!publishAuthPair(ticket, pair)) {
      return { access: null, hardFailure: false };
    }
    return { access: pair.access, hardFailure: false };
  } catch {
    if (!isAuthTicketCurrent(ticket)) {
      // Password rotation or close superseded this chain. Its expected failure
      // is not evidence that the current credentials are invalid.
      return { access: await accessAfterRotation(ticket), hardFailure: false };
    }
    return { access: null, hardFailure: true };
  }
}

/**
 * Adopts a password-change pair. Revision changes before persistence; refresh
 * callers arriving during the native write await this barrier and make zero
 * refresh HTTP calls.
 */
export async function rotateTokens(
  tokens: AuthPair,
  source: AuthTicket | null = captureAuthTicket(),
): Promise<boolean> {
  if (source === null) return false;

  const rotatedTicket = beginAuthCredentialRotation(source, tokens);
  if (rotatedTicket === null) return false;

  // A password response that crossed close is already in the authoritative
  // handoff. Closing forbids starting a new persistence write.
  if (!isAuthTicketCurrent(rotatedTicket)) {
    return false;
  }

  const activity = beginCredentialActivity(rotatedTicket);
  if (activity === null) return false;

  const pending = (async () => {
    await setRefreshToken(tokens.refresh);
    if (!isAuthTicketCurrent(rotatedTicket)) {
      return false;
    }
    return publishAuthPair(rotatedTicket, tokens);
  })();
  rotationInFlight = { ticket: rotatedTicket, promise: pending };

  try {
    return await pending;
  } catch (error) {
    // The old family is already revoked server-side and the new refresh could
    // not be persisted. Close owns local cleanup and best-effort handoff revoke.
    throw error;
  } finally {
    activity.finish();
    if (rotationInFlight?.promise === pending) {
      rotationInFlight = null;
    }
  }
}

export function __resetRefreshForTests(): void {
  refreshFlights.clear();
  rotationInFlight = null;
  onRefreshFailed = null;
}
