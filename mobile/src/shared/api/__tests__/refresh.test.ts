jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
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
import { AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import * as SecureStore from 'expo-secure-store';
// eslint-disable-next-line import/first
import { apiClient } from '../client';
// eslint-disable-next-line import/first
import { refreshHttp, refreshTokens, rotateTokens, setOnRefreshFailed } from '../refresh';
// eslint-disable-next-line import/first
import { clearTokens, getAccessToken, getRefreshToken, setAccessToken, setRefreshToken } from '../token-store';

describe('refreshTokens', () => {
  beforeEach(async () => {
    await clearTokens();
    setOnRefreshFailed(null);
    jest.restoreAllMocks();
  });

  it('returns null without calling the API when no refresh token is stored', async () => {
    const post = jest.spyOn(refreshHttp, 'post');
    await expect(refreshTokens()).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('stores the new access and rotated refresh token on success', async () => {
    await setRefreshToken('old-refresh');
    jest.spyOn(refreshHttp, 'post').mockResolvedValue({ data: { access: 'new-access', refresh: 'new-refresh' } });

    await expect(refreshTokens()).resolves.toBe('new-access');
    expect(refreshHttp.post).toHaveBeenCalledWith('http://testserver:8000/api/auth/refresh', { refresh: 'old-refresh' });
    expect(getAccessToken()).toBe('new-access');
    await expect(getRefreshToken()).resolves.toBe('new-refresh');
  });

  it('coalesces concurrent calls into one request', async () => {
    await setRefreshToken('old-refresh');
    const post = jest
      .spyOn(refreshHttp, 'post')
      .mockResolvedValue({ data: { access: 'new-access', refresh: 'new-refresh' } });

    const [a, b] = await Promise.all([refreshTokens(), refreshTokens()]);
    expect(a).toBe('new-access');
    expect(b).toBe('new-access');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('clears tokens and notifies on failure', async () => {
    await setRefreshToken('revoked');
    jest.spyOn(refreshHttp, 'post').mockRejectedValue(new Error('401'));
    const onFailed = jest.fn();
    setOnRefreshFailed(onFailed);

    await expect(refreshTokens()).resolves.toBeNull();
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

describe('rotateTokens', () => {
  beforeEach(async () => {
    await clearTokens();
    setOnRefreshFailed(null);
    jest.restoreAllMocks();
  });

  it('persists the refresh token before exposing the new access token', async () => {
    setAccessToken('old-access');
    let releaseWrite: () => void = () => undefined;
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseWrite = resolve; }),
    );

    const rotation = rotateTokens({ access: 'new-access', refresh: 'new-refresh' });
    expect(getAccessToken()).toBe('old-access');

    releaseWrite();
    await rotation;
    expect(getAccessToken()).toBe('new-access');
  });

  it('propagates a SecureStore failure and clears the revoked access token', async () => {
    setAccessToken('old-access');
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(rotateTokens({ access: 'new-access', refresh: 'new-refresh' })).rejects.toThrow();
    expect(getAccessToken()).toBeNull();
  });

  it('is the token the next authenticated request actually sends', async () => {
    await rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' });

    const originalAdapter = apiClient.defaults.adapter;
    let seenAuth: string | undefined;
    apiClient.defaults.adapter = async (config) => {
      seenAuth = new AxiosHeaders(config.headers).get('Authorization') as string | undefined;
      return { status: 200, statusText: 'OK', headers: {}, config, data: {} };
    };
    try {
      await apiClient.get('/auth/me');
    } finally {
      apiClient.defaults.adapter = originalAdapter;
    }

    expect(seenAuth).toBe('Bearer rotated-access');
    await expect(getRefreshToken()).resolves.toBe('rotated-refresh');
  });

  it('does not sign the user out when it supersedes a failing in-flight refresh', async () => {
    await setRefreshToken('revoked-refresh');
    setAccessToken('revoked-access');
    const onFailed = jest.fn();
    setOnRefreshFailed(onFailed);
    let rejectRefresh: (error: Error) => void = () => undefined;
    jest.spyOn(refreshHttp, 'post').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRefresh = reject; }),
    );

    const refreshing = refreshTokens();
    await rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' });
    rejectRefresh(new Error('401'));

    await expect(refreshing).resolves.toBe('rotated-access');
    expect(onFailed).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('rotated-access');
    await expect(getRefreshToken()).resolves.toBe('rotated-refresh');
  });

  it('does not let a late-succeeding refresh overwrite the rotated pair', async () => {
    await setRefreshToken('revoked-refresh');
    let resolveRefresh: (value: { data: { access: string; refresh: string } }) => void = () => undefined;
    jest.spyOn(refreshHttp, 'post').mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const refreshing = refreshTokens();
    await rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' });
    resolveRefresh({ data: { access: 'stale-access', refresh: 'stale-refresh' } });

    await expect(refreshing).resolves.toBe('rotated-access');
    expect(getAccessToken()).toBe('rotated-access');
    await expect(getRefreshToken()).resolves.toBe('rotated-refresh');
  });

  it('holds a stale refresh behind the barrier while the SecureStore write is pending', async () => {
    await setRefreshToken('revoked-refresh');
    setAccessToken('revoked-access');
    let resolveRefresh: (value: { data: { access: string; refresh: string } }) => void = () => undefined;
    jest.spyOn(refreshHttp, 'post').mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    let releaseWrite: () => void = () => undefined;
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseWrite = resolve; }),
    );

    const refreshing = refreshTokens();
    const rotation = rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' });
    resolveRefresh({ data: { access: 'stale-access', refresh: 'stale-refresh' } });

    let refreshSettled = false;
    void refreshing.then(() => { refreshSettled = true; });
    await Promise.resolve();
    expect(refreshSettled).toBe(false);
    expect(getAccessToken()).toBe('revoked-access');

    releaseWrite();
    await rotation;
    await expect(refreshing).resolves.toBe('rotated-access');
  });

  it('does not send a refresh read from a generation that was superseded during SecureStore access', async () => {
    let releaseRead: (value: string | null) => void = () => undefined;
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => { releaseRead = resolve; }),
    );
    const post = jest.spyOn(refreshHttp, 'post');

    const refreshing = refreshTokens();
    await rotateTokens({ access: 'rotated-access', refresh: 'rotated-refresh' });
    releaseRead('rotated-refresh');

    await expect(refreshing).resolves.toBe('rotated-access');
    expect(post).not.toHaveBeenCalled();
  });
});
