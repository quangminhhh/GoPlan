import * as SecureStore from 'expo-secure-store';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from '../token-store';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    // Exposed so a test can hold one write open and still let it commit later.
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

const secureStore = (SecureStore as unknown as { __store: Map<string, string> }).__store;

/**
 * Replaces the next SecureStore write with one that only commits when the
 * returned function is called, so a later write can be issued while it is open.
 */
function holdNextWrite(): () => void {
  let commit: (() => void) | null = null;
  (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
    (key: string, value: string) =>
      new Promise<void>((resolve) => {
        commit = () => {
          secureStore.set(key, value);
          resolve();
        };
      }),
  );
  return () => commit?.();
}

describe('token store', () => {
  beforeEach(async () => {
    await clearTokens();
    jest.clearAllMocks();
  });

  it('keeps the access token in memory only', () => {
    setAccessToken('access-1');
    expect(getAccessToken()).toBe('access-1');
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('persists the refresh token via SecureStore under the goplan key', async () => {
    await setRefreshToken('refresh-1');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('goplan.refresh_token', 'refresh-1');
    await expect(getRefreshToken()).resolves.toBe('refresh-1');
  });

  it('deletes the stored token when set to null', async () => {
    await setRefreshToken('refresh-1');
    await setRefreshToken(null);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('goplan.refresh_token');
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('clearTokens wipes both tokens', async () => {
    setAccessToken('access-1');
    await setRefreshToken('refresh-1');
    await clearTokens();
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('releases the write queue so a failed deletion can be retried', async () => {
    setAccessToken('access-1');
    await setRefreshToken('refresh-1');
    (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(
      new Error('keychain unavailable'),
    );

    await expect(clearTokens()).rejects.toThrow('keychain unavailable');
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBe('refresh-1');

    await clearTokens();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  describe('overlapping writes', () => {
    it('commits in call order even when the earlier write is the slower one', async () => {
      const commitFirst = holdNextWrite();

      const first = setRefreshToken('refresh-first');
      const second = setRefreshToken('refresh-second');
      commitFirst();
      await Promise.all([first, second]);

      await expect(getRefreshToken()).resolves.toBe('refresh-second');
    });

    it('does not let a write already in flight survive a sign-out', async () => {
      const commitWrite = holdNextWrite();

      const write = setRefreshToken('refresh-1');
      const signOut = clearTokens();
      commitWrite();
      await Promise.all([write, signOut]);

      await expect(getRefreshToken()).resolves.toBeNull();
    });

    it('serves later writes after one of them fails', async () => {
      (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain unavailable'));

      await expect(setRefreshToken('doomed')).rejects.toThrow('keychain unavailable');
      await setRefreshToken('refresh-2');

      await expect(getRefreshToken()).resolves.toBe('refresh-2');
    });
  });
});
