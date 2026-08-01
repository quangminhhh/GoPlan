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
jest.mock('../refresh', () => ({
  refreshTokens: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
// eslint-disable-next-line import/first
import {
  __resetAuthSessionLifecycleForTests,
  activateAuthSession,
  beginAuthSessionOpening,
  publishAuthPair,
  requestAuthSessionClose,
} from '../authSessionLifecycle';
// eslint-disable-next-line import/first
import { apiClient } from '../client';
// eslint-disable-next-line import/first
import { refreshTokens } from '../refresh';
// eslint-disable-next-line import/first
import { setRefreshToken } from '../token-store';
// eslint-disable-next-line import/first
import { authCloseHttp, logoutRequest } from '@/features/auth/api';

const mockRefreshTokens = refreshTokens as jest.MockedFunction<typeof refreshTokens>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (value) => resolvePromise(value),
  };
}

function axiosFailure(config: InternalAxiosRequestConfig, status: number): AxiosError {
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data: { detail: 'expired' },
  });
}

function installAdapter(
  handler: (
    config: InternalAxiosRequestConfig,
    attempt: number,
  ) => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>,
) {
  let attempts = 0;
  apiClient.defaults.adapter = async (config) => {
    attempts += 1;
    const { status, data } = await handler(config, attempts);
    if (status >= 400) throw axiosFailure(config, status);
    return { status, statusText: 'OK', headers: {}, config, data };
  };
  return () => attempts;
}

async function activate(pair: { access: string; refresh: string }) {
  const ticket = await beginAuthSessionOpening();
  await setRefreshToken(pair.refresh);
  publishAuthPair(ticket, pair);
  activateAuthSession(ticket);
  return ticket;
}

const originalAdapter = apiClient.defaults.adapter;
const originalCloseAdapter = authCloseHttp.defaults.adapter;

beforeEach(() => {
  __resetAuthSessionLifecycleForTests();
  mockRefreshTokens.mockReset();
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
  authCloseHttp.defaults.adapter = originalCloseAdapter;
});

describe('apiClient auth generation gate', () => {
  it('attaches the current bearer and stamps its generation', async () => {
    await activate({ access: 'access-1', refresh: 'refresh-1' });
    let seenAuth: string | null = null;
    let seenGeneration: number | undefined;
    let seenRevision: number | undefined;
    installAdapter((config) => {
      const authorization = new AxiosHeaders(config.headers).get('Authorization');
      seenAuth = typeof authorization === 'string' ? authorization : null;
      seenGeneration = (config as InternalAxiosRequestConfig & { authGeneration?: number }).authGeneration;
      seenRevision = (
        config as InternalAxiosRequestConfig & { authCredentialRevision?: number }
      ).authCredentialRevision;
      return { status: 200, data: {} };
    });

    await apiClient.get('/auth/me');

    expect(seenAuth).toBe('Bearer access-1');
    expect(seenGeneration).toBe(1);
    expect(seenRevision).toBe(0);
  });

  it('refreshes once and replays only while the stamped ticket is current', async () => {
    await activate({ access: 'stale', refresh: 'refresh-1' });
    mockRefreshTokens.mockResolvedValue('fresh');
    const attempts = installAdapter((config, attempt) => {
      if (attempt === 1) return { status: 401, data: {} };
      expect(new AxiosHeaders(config.headers).get('Authorization')).toBe('Bearer fresh');
      return { status: 200, data: { ok: true } };
    });

    await expect(apiClient.get('/auth/me')).resolves.toMatchObject({ data: { ok: true } });
    expect(attempts()).toBe(2);
    expect(mockRefreshTokens).toHaveBeenCalledWith({
      sessionGeneration: 1,
      credentialRevision: 0,
    });
  });

  it('does not replay a non-photo 401 after close starts', async () => {
    await activate({ access: 'access-a', refresh: 'refresh-a' });
    const attempts = installAdapter(() => {
      void requestAuthSessionClose('user');
      return { status: 401, data: {} };
    });

    await expect(apiClient.get('/trips')).rejects.toBeInstanceOf(AxiosError);
    expect(attempts()).toBe(1);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('does not let request A refresh with session B after its 401 resolves late', async () => {
    await activate({ access: 'access-a', refresh: 'refresh-a' });
    const responseGate = deferred<void>();
    const attempts = installAdapter(async () => {
      await responseGate.promise;
      return { status: 401, data: {} };
    });

    const requestA = apiClient.get('/trips').catch((error: unknown) => error);
    await Promise.resolve();
    await requestAuthSessionClose('user');
    await activate({ access: 'access-b', refresh: 'refresh-b' });
    responseGate.resolve();

    await expect(requestA).resolves.toBeInstanceOf(AxiosError);
    expect(attempts()).toBe(1);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('does not start refresh for a request whose close is already in progress', async () => {
    await activate({ access: 'access-a', refresh: 'refresh-a' });
    const responseGate = deferred<void>();
    installAdapter(async () => {
      await responseGate.promise;
      return { status: 401, data: {} };
    });

    const pending = apiClient.get('/trips').catch((error: unknown) => error);
    await Promise.resolve();
    const closing = requestAuthSessionClose('user');
    responseGate.resolve();

    await pending;
    await closing;
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('never sends logout through the refresh interceptor', async () => {
    authCloseHttp.defaults.adapter = async (config) => {
      throw axiosFailure(config, 401);
    };

    await expect(
      logoutRequest({ access: 'closing-access', refresh: 'closing-refresh' }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('honours skipAuthRefresh for authenticated endpoints with explicit semantics', async () => {
    await activate({ access: 'access-a', refresh: 'refresh-a' });
    installAdapter(() => ({ status: 401, data: {} }));

    await expect(
      apiClient.request({ url: '/auth/special', skipAuthRefresh: true } as never),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('reopens the gate for authenticated retry after restore A and after session B', async () => {
    await activate({ access: 'access-a', refresh: 'refresh-a' });
    mockRefreshTokens.mockResolvedValueOnce('fresh-a').mockResolvedValueOnce('fresh-b');

    let attempts = installAdapter((_config, attempt) => ({
      status: attempt % 2 === 1 ? 401 : 200,
      data: { ok: true },
    }));
    await apiClient.get('/auth/me');
    expect(attempts()).toBe(2);

    await requestAuthSessionClose('user');
    await activate({ access: 'access-b', refresh: 'refresh-b' });
    attempts = installAdapter((_config, attempt) => ({
      status: attempt === 1 ? 401 : 200,
      data: { ok: true },
    }));
    await apiClient.get('/auth/me');

    expect(attempts()).toBe(2);
    expect(mockRefreshTokens).toHaveBeenNthCalledWith(1, {
      sessionGeneration: 1,
      credentialRevision: 0,
    });
    expect(mockRefreshTokens).toHaveBeenNthCalledWith(2, {
      sessionGeneration: 3,
      credentialRevision: 0,
    });
  });

  it('does not attempt refresh for anonymous login failures', async () => {
    installAdapter(() => ({ status: 401, data: {} }));

    await expect(apiClient.post('/auth/login', {})).rejects.toBeInstanceOf(AxiosError);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });
});
