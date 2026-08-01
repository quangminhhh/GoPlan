jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
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

// eslint-disable-next-line import/first
import * as SecureStore from 'expo-secure-store';
// eslint-disable-next-line import/first
import {
  __resetAuthSessionLifecycleForTests,
  activateAuthSession,
  beginAuthSessionOpening,
  getAuthSnapshot,
  publishAuthPair,
  requestAuthSessionClose,
  setAuthCloseEffects,
  waitForAuthClose,
} from '../authSessionLifecycle';
// eslint-disable-next-line import/first
import {
  __resetRefreshForTests,
  REFRESH_TIMEOUT_MS,
  refreshHttp,
  refreshTokens,
  rotateTokens,
  setOnRefreshFailed,
} from '../refresh';
// eslint-disable-next-line import/first
import { getAccessToken, getRefreshToken, setRefreshToken } from '../token-store';

const secureStore = (SecureStore as unknown as { __store: Map<string, string> }).__store;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  return {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => resolvePromise(value),
    reject: (error) => rejectPromise(error),
  };
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

async function activate(pair = { access: 'access-1', refresh: 'refresh-1' }) {
  const ticket = await beginAuthSessionOpening();
  await setRefreshToken(pair.refresh);
  publishAuthPair(ticket, pair);
  activateAuthSession(ticket);
  return ticket;
}

beforeEach(() => {
  __resetAuthSessionLifecycleForTests();
  __resetRefreshForTests();
  secureStore.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('refreshTokens lifecycle', () => {
  it('uses a 15-second timeout on the bare no-interceptor client', () => {
    expect(REFRESH_TIMEOUT_MS).toBe(15_000);
    expect(refreshHttp.defaults.timeout).toBe(15_000);
  });

  it('returns null without HTTP when an opening session has no refresh token', async () => {
    const ticket = await beginAuthSessionOpening();
    const post = jest.spyOn(refreshHttp, 'post');

    await expect(refreshTokens(ticket)).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('persists the rotated refresh before publishing access', async () => {
    await activate();
    const writeGate = deferred<void>();
    let committed = false;
    jest.spyOn(refreshHttp, 'post').mockResolvedValue({
      data: { access: 'access-2', refresh: 'refresh-2' },
    });
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      (key: string, value: string) => writeGate.promise.then(() => {
        secureStore.set(key, value);
        committed = true;
      }),
    );

    const refreshing = refreshTokens();
    await flushMicrotasks();
    expect(committed).toBe(false);
    expect(getAccessToken()).toBe('access-1');

    writeGate.resolve();
    await expect(refreshing).resolves.toBe('access-2');
    expect(getAccessToken()).toBe('access-2');
    await expect(getRefreshToken()).resolves.toBe('refresh-2');
  });

  it('coalesces concurrent calls only within the same auth ticket', async () => {
    await activate();
    const post = jest.spyOn(refreshHttp, 'post').mockResolvedValue({
      data: { access: 'access-2', refresh: 'refresh-2' },
    });

    const [first, second] = await Promise.all([refreshTokens(), refreshTokens()]);
    expect(first).toBe('access-2');
    expect(second).toBe('access-2');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('hands A2/R2 to close, never publishes late access, and clears both stores', async () => {
    await activate();
    const responseGate = deferred<{ data: { access: string; refresh: string } }>();
    jest.spyOn(refreshHttp, 'post').mockReturnValue(responseGate.promise as never);
    const revoke = jest.fn(async () => undefined);
    setAuthCloseEffects({ revoke });

    const refreshing = refreshTokens();
    await flushMicrotasks();
    const closing = requestAuthSessionClose('user');
    responseGate.resolve({ data: { access: 'access-2', refresh: 'refresh-2' } });

    await expect(refreshing).resolves.toBeNull();
    await closing;
    expect(revoke).toHaveBeenCalledWith(
      { access: 'access-2', refresh: 'refresh-2' },
      expect.any(Object),
    );
    expect(getAuthSnapshot()).toMatchObject({ phase: 'signedOut', access: null });
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('does not send refresh when close lands during the SecureStore read', async () => {
    await activate();
    const readGate = deferred<string | null>();
    (SecureStore.getItemAsync as jest.Mock).mockReturnValueOnce(readGate.promise);
    const post = jest.spyOn(refreshHttp, 'post');

    const refreshing = refreshTokens();
    const closing = requestAuthSessionClose('user');
    readGate.resolve('refresh-1');

    await expect(refreshing).resolves.toBeNull();
    await closing;
    expect(post).not.toHaveBeenCalled();
  });

  it('waits a pending R2 write and enqueues deletion after it', async () => {
    await activate();
    jest.spyOn(refreshHttp, 'post').mockResolvedValue({
      data: { access: 'access-2', refresh: 'refresh-2' },
    });
    const writeGate = deferred<void>();
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      (key: string, value: string) => writeGate.promise.then(() => secureStore.set(key, value)),
    );

    const refreshing = refreshTokens();
    await flushMicrotasks();
    const closing = requestAuthSessionClose('user');
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();
    expect(closeSettled).toBe(false);

    writeGate.resolve();
    await refreshing;
    await closing;
    expect(await getRefreshToken()).toBeNull();
    const setMock = SecureStore.setItemAsync as jest.Mock;
    const deleteMock = SecureStore.deleteItemAsync as jest.Mock;
    expect(setMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      deleteMock.mock.invocationCallOrder.at(-1)!,
    );
  });

  it.each(['success', 'failure'] as const)(
    'does not let an old refresh %s overwrite or close password-rotated credentials',
    async (outcome) => {
      const source = await activate();
      const responseGate = deferred<{ data: { access: string; refresh: string } }>();
      const post = jest.spyOn(refreshHttp, 'post').mockReturnValue(responseGate.promise as never);
      const failed = jest.fn();
      setOnRefreshFailed(failed);

      const refreshing = refreshTokens(source);
      await flushMicrotasks();
      await expect(
        rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' }, source),
      ).resolves.toBe(true);
      if (outcome === 'success') {
        responseGate.resolve({ data: { access: 'stale-access', refresh: 'stale-refresh' } });
      } else {
        responseGate.reject(new Error('old family revoked'));
      }

      await expect(refreshing).resolves.toBe('rotated-access');
      expect(post).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
      expect(getAuthSnapshot()).toMatchObject({
        phase: 'active',
        credentialRevision: 1,
        access: 'rotated-access',
      });
      await expect(getRefreshToken()).resolves.toBe('rotated-refresh');
    },
  );

  it('waits password persistence and returns rotated access with zero refresh HTTP', async () => {
    const source = await activate();
    const writeGate = deferred<void>();
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      (key: string, value: string) => writeGate.promise.then(() => secureStore.set(key, value)),
    );
    const post = jest.spyOn(refreshHttp, 'post');

    const rotation = rotateTokens(
      { access: 'rotated-access', refresh: 'rotated-refresh' },
      source,
    );
    const refreshing = refreshTokens();
    let refreshSettled = false;
    void refreshing.then(() => {
      refreshSettled = true;
    });
    await flushMicrotasks();
    expect(refreshSettled).toBe(false);
    expect(post).not.toHaveBeenCalled();

    writeGate.resolve();
    await expect(rotation).resolves.toBe(true);
    await expect(refreshing).resolves.toBe('rotated-access');
    expect(post).not.toHaveBeenCalled();
  });

  it('turns a hard refresh failure into one joinable close', async () => {
    await activate();
    jest.spyOn(refreshHttp, 'post').mockRejectedValue(new Error('timeout'));
    const revoke = jest.fn(async () => undefined);
    const failed = jest.fn();
    setAuthCloseEffects({ revoke });
    setOnRefreshFailed(failed);

    await expect(refreshTokens()).resolves.toBeNull();
    await waitForAuthClose();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(
      { access: 'access-1', refresh: 'refresh-1' },
      expect.any(Object),
    );
    expect(getAuthSnapshot().phase).toBe('signedOut');
    await expect(getRefreshToken()).resolves.toBeNull();
  });
});
