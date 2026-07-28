import { create } from 'axios';
import { getApiBaseUrl } from './base-url';
import { clearTokens, getAccessToken, getRefreshToken, setAccessToken, setRefreshToken } from './token-store';

interface RefreshResponse {
  access: string;
  refresh: string;
}

// Bare instance: must NOT share apiClient's interceptors, or a failing
// refresh would recursively trigger another refresh.
export const refreshHttp = create();

let inFlight: Promise<string | null> | null = null;
let onRefreshFailed: (() => void) | null = null;

/**
 * Bumped every time the token pair is replaced wholesale (password change).
 * A refresh that started before the bump belongs to a chain the server has
 * already revoked; its result — success or failure — must not touch the store.
 */
let tokenGeneration = 0;
let rotationInFlight: Promise<void> | null = null;

export function setOnRefreshFailed(handler: (() => void) | null): void {
  onRefreshFailed = handler;
}

export function refreshTokens(): Promise<string | null> {
  if (!inFlight) {
    inFlight = doRefresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * A refresh from an older generation calls this instead of reading the current
 * access token immediately. That token stays revoked until the barrier settles,
 * so returning it early would hand the interceptor a token the server rejects.
 */
async function accessAfterSupersedingRotation(): Promise<string | null> {
  const pending = rotationInFlight;
  if (!pending) {
    return getAccessToken();
  }
  try {
    await pending;
  } catch {
    return null;
  }
  return getAccessToken();
}

/**
 * Atomically adopt a server-issued token pair after an operation that revoked
 * every previous token (POST /auth/password/change).
 *
 * The refresh token is written to SecureStore first — it is the only step that
 * can fail. The opposite order would leave memory holding a valid access token
 * while disk still holds a revoked refresh token, so a kill at that point would
 * make the next restore fail with no durable record of the partial adoption.
 */
export async function rotateTokens(tokens: { access: string; refresh: string }): Promise<void> {
  tokenGeneration += 1;
  const pending = (async () => {
    await setRefreshToken(tokens.refresh);
    setAccessToken(tokens.access);
  })();
  rotationInFlight = pending;

  try {
    await pending;
  } catch (error) {
    // The server has already revoked this access token. Never let a superseded
    // refresh or request retry observe it while rotateSession signs out locally.
    setAccessToken(null);
    throw error;
  } finally {
    if (rotationInFlight === pending) {
      rotationInFlight = null;
    }
  }
}

async function doRefresh(): Promise<string | null> {
  const generationAtStart = tokenGeneration;
  const refresh = await getRefreshToken();
  if (tokenGeneration !== generationAtStart) {
    // Do not send a token read from a generation superseded during SecureStore
    // access: backend refresh rotation could blacklist the newly stored token.
    return accessAfterSupersedingRotation();
  }
  if (!refresh) {
    return null;
  }
  try {
    const { data } = await refreshHttp.post<RefreshResponse>(`${getApiBaseUrl()}/auth/refresh`, { refresh });
    if (tokenGeneration !== generationAtStart) {
      return accessAfterSupersedingRotation();
    }
    setAccessToken(data.access);
    // Backend rotates refresh tokens (ROTATE_REFRESH_TOKENS): persist the new one.
    // Enqueued with no await since the generation check above, so a rotation
    // starting from here on is guaranteed to write after this one and win.
    await setRefreshToken(data.refresh);
    if (tokenGeneration !== generationAtStart) {
      // A rotation landed while that write was in flight. It has superseded both
      // tokens, so this access token is revoked even though the write succeeded.
      return accessAfterSupersedingRotation();
    }
    return data.access;
  } catch {
    if (tokenGeneration !== generationAtStart) {
      // This refresh used a token the password change revoked. That failure is
      // expected and must not sign the user out.
      return accessAfterSupersedingRotation();
    }
    await clearTokens();
    onRefreshFailed?.();
    return null;
  }
}
