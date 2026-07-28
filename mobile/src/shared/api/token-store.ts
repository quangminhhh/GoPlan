import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'goplan.refresh_token';

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

/** Tail of the queue below; null whenever no write is in flight. */
let writeTail: Promise<void> | null = null;

async function persistRefreshToken(token: string | null): Promise<void> {
  if (token === null) {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    return;
  }
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/**
 * Writes are serialized, because four callers can target this one key at the
 * same time: refresh rotation, password-change rotation, sign-in and sign-out.
 *
 * A SecureStore write is an async native call, so two overlapping writes settle
 * in an order the callers cannot observe or control — whichever finishes last
 * wins. Left unordered, a refresh token the server has already revoked can land
 * on top of the pair a password change just stored, and the user is signed out
 * on the next request; a sign-out can likewise be undone by a write that was
 * already in flight.
 *
 * When the queue is idle the write starts synchronously rather than a microtask
 * later, so a caller that checks a condition and immediately writes keeps that
 * pair atomic: nothing can run between the check and the enqueue.
 */
export function setRefreshToken(token: string | null): Promise<void> {
  const queued = writeTail;
  const write = queued === null ? persistRefreshToken(token) : queued.then(() => persistRefreshToken(token));

  // A rejected write releases the queue instead of blocking every later one.
  const tail = write.then(releaseTail, releaseTail);
  writeTail = tail;
  return write;

  function releaseTail(): void {
    if (writeTail === tail) {
      writeTail = null;
    }
  }
}

export async function clearTokens(): Promise<void> {
  setAccessToken(null);
  await setRefreshToken(null);
}
