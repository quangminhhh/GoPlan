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
jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(),
  rotateTokens: jest.fn(),
}));
jest.mock('@/shared/media/photoSaveTempStore', () => ({
  photoSaveTempCoordinator: {
    bootstrap: jest.fn(async () => undefined),
    activateSession: jest.fn(),
    suspend: jest.fn(),
    resume: jest.fn(),
  },
}));
jest.mock('../api', () => ({
  changePasswordRequest: jest.fn(),
  fetchMe: jest.fn(),
  logoutRequest: jest.fn(),
}));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import * as SecureStore from 'expo-secure-store';
// eslint-disable-next-line import/first
import type { PropsWithChildren } from 'react';
// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import {
  __resetAuthSessionLifecycleForTests,
  beginAuthCredentialRotation,
  getAuthSnapshot,
  isAuthTicketCurrent,
  publishAuthPair,
  requestAuthSessionClose,
  type AuthTicket,
} from '@/shared/api/authSessionLifecycle';
// eslint-disable-next-line import/first
import { refreshTokens, rotateTokens } from '@/shared/api/refresh';
// eslint-disable-next-line import/first
import { getAccessToken, getRefreshToken } from '@/shared/api/token-store';
// eslint-disable-next-line import/first
import {
  __resetPrivateMediaLifecycleForTests,
  isPrivateMediaSessionOpen,
  registerPrivateMediaPurger,
} from '@/shared/media/privateMediaLifecycle';
// eslint-disable-next-line import/first
import { purgeProtectedAssets } from '@/shared/media/protectedAssetStore';
// eslint-disable-next-line import/first
import { photoSaveTempCoordinator } from '@/shared/media/photoSaveTempStore';
// eslint-disable-next-line import/first
import { changePasswordRequest, fetchMe, logoutRequest } from '../api';
// eslint-disable-next-line import/first
import { SessionProvider, useSession } from '../session';
// eslint-disable-next-line import/first
import type { AuthResponse, AuthUser } from '../types';

const mockRefresh = refreshTokens as jest.MockedFunction<typeof refreshTokens>;
const mockRotate = rotateTokens as jest.MockedFunction<typeof rotateTokens>;
const mockChangePassword = changePasswordRequest as jest.MockedFunction<typeof changePasswordRequest>;
const mockFetchMe = fetchMe as jest.MockedFunction<typeof fetchMe>;
const mockLogout = logoutRequest as jest.MockedFunction<typeof logoutRequest>;
const mockPhotoSaveCoordinator = photoSaveTempCoordinator as jest.Mocked<
  typeof photoSaveTempCoordinator
>;
const secureStore = (SecureStore as unknown as { __store: Map<string, string> }).__store;

const user = { id: 'u1', requires_profile_setup: false } as AuthUser;
const authResponse: AuthResponse = {
  user,
  tokens: { access: 'access-1', refresh: 'refresh-1', token_type: 'Bearer' },
};

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

function wrapper({ children }: PropsWithChildren) {
  return <SessionProvider>{children}</SessionProvider>;
}

function restoreWith(pair: { access: string; refresh: string } | null): void {
  mockRefresh.mockImplementation(async (ticket) => {
    if (pair === null || ticket === null || ticket === undefined) return null;
    publishAuthPair(ticket, pair);
    return pair.access;
  });
}

function installSuccessfulRotation(): void {
  mockRotate.mockImplementation(async (tokens, source) => {
    if (source === null || source === undefined) return false;
    const rotated = beginAuthCredentialRotation(source, tokens);
    return rotated !== null && publishAuthPair(rotated, tokens);
  });
}

beforeEach(() => {
  __resetAuthSessionLifecycleForTests();
  __resetPrivateMediaLifecycleForTests();
  secureStore.clear();
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockFetchMe.mockResolvedValue(user);
  mockLogout.mockResolvedValue(undefined);
  installSuccessfulRotation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SessionProvider', () => {
  it('restores to signedIn only after refresh, /me, and auth activation succeed', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });

    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    expect(result.current.user).toEqual(user);
    expect(getAuthSnapshot()).toMatchObject({ phase: 'active', access: 'access-1' });
    expect(mockPhotoSaveCoordinator.activateSession).toHaveBeenCalledWith(1, true);
  });

  it('restores to signedOut with both gates closed when no refresh is available', async () => {
    restoreWith(null);
    const { result } = await renderHook(useSession, { wrapper });

    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(mockFetchMe).not.toHaveBeenCalled();
    expect(getAuthSnapshot().phase).toBe('signedOut');
    expect(isPrivateMediaSessionOpen()).toBe(false);
  });

  it('closes restore when backgrounding shuts the media gate during startup purge', async () => {
    const purgeStarted = deferred<void>();
    const purgeGate = deferred<void>();
    let appStateListener: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
    registerPrivateMediaPurger('protected-assets', async () => {
      purgeStarted.resolve();
      await purgeGate.promise;
    });
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    let unmount: (() => Promise<void>) | undefined;

    try {
      const rendered = await renderHook(useSession, { wrapper });
      const { result } = rendered;
      unmount = rendered.unmount;
      await purgeStarted.promise;
      expect(appStateListener).toBeDefined();

      await act(async () => {
        appStateListener?.('background');
      });
      expect(result.current.status).toBe('restoring');
      expect(getAuthSnapshot().phase).toBe('opening');
      expect(isPrivateMediaSessionOpen()).toBe(false);

      await act(async () => {
        purgeGate.resolve();
      });

      await waitFor(() => expect(result.current.status).toBe('signedOut'));
      await waitFor(() => expect(getAuthSnapshot().phase).toBe('signedOut'));
      expect(isPrivateMediaSessionOpen()).toBe(false);
      expect(mockRefresh).not.toHaveBeenCalled();
    } finally {
      purgeGate.resolve();
      await unmount?.();
      registerPrivateMediaPurger('protected-assets', purgeProtectedAssets);
    }
  });

  it('persists and publishes sign-in credentials in coordinator order', async () => {
    restoreWith(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));

    await act(() => result.current.signIn(authResponse));

    expect(result.current.status).toBe('signedIn');
    expect(getAccessToken()).toBe('access-1');
    await expect(getRefreshToken()).resolves.toBe('refresh-1');
    expect(getAuthSnapshot().phase).toBe('active');
  });

  it('uses the complete access/refresh handoff for best-effort revoke', async () => {
    restoreWith(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.signIn(authResponse));
    mockLogout.mockRejectedValue(new Error('network down'));

    await act(() => result.current.signOut());

    expect(mockLogout).toHaveBeenCalledWith({ access: 'access-1', refresh: 'refresh-1' });
    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('keeps sign-in B unpublished until close A revoke and clear settle', async () => {
    restoreWith(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.signIn(authResponse));

    const revokeGate = deferred<void>();
    mockLogout.mockReturnValueOnce(revokeGate.promise);
    const authB: AuthResponse = {
      user: { ...user, id: 'u2' },
      tokens: { access: 'access-b', refresh: 'refresh-b', token_type: 'Bearer' },
    };

    let signingOut!: Promise<void>;
    let signingInB!: Promise<void>;
    await act(async () => {
      signingOut = result.current.signOut();
      signingInB = result.current.signIn(authB);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    expect(await getRefreshToken()).not.toBe('refresh-b');

    revokeGate.resolve();
    await act(async () => {
      await Promise.all([signingOut, signingInB]);
    });
    expect(result.current.status).toBe('signedIn');
    expect(result.current.user?.id).toBe('u2');
    expect(getAccessToken()).toBe('access-b');
    await expect(getRefreshToken()).resolves.toBe('refresh-b');
  });

  it('keeps sign-in B unpublished while a failed durable clear retries', async () => {
    restoreWith(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.signIn(authResponse));

    const deleteGate = deferred<void>();
    (SecureStore.deleteItemAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockImplementationOnce((key: string) =>
        deleteGate.promise.then(() => {
          secureStore.delete(key);
        }),
      );
    const authB: AuthResponse = {
      user: { ...user, id: 'u2' },
      tokens: { access: 'access-b', refresh: 'refresh-b', token_type: 'Bearer' },
    };

    let signingOut!: Promise<void>;
    let signingInB!: Promise<void>;
    await act(async () => {
      signingOut = result.current.signOut();
      signingInB = result.current.signIn(authB);
    });
    await waitFor(() => expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2));

    expect(result.current.status).toBe('signedOut');
    expect(getAuthSnapshot().phase).toBe('closing');
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBe('refresh-1');
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      'goplan.refresh_token',
      'refresh-b',
    );

    deleteGate.resolve();
    await act(async () => {
      await Promise.all([signingOut, signingInB]);
    });

    expect(result.current.status).toBe('signedIn');
    expect(result.current.user?.id).toBe('u2');
    expect(getAccessToken()).toBe('access-b');
    await expect(getRefreshToken()).resolves.toBe('refresh-b');
  });

  it('joins hard failure and user sign-out without duplicate workflows', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    const revokeGate = deferred<void>();
    mockLogout.mockReturnValue(revokeGate.promise);

    let hardClose!: Promise<void>;
    let userClose!: Promise<void>;
    await act(async () => {
      hardClose = requestAuthSessionClose('refreshFailure');
      userClose = result.current.signOut();
      await Promise.resolve();
    });
    expect(getAuthSnapshot().phase).toBe('closing');
    expect(result.current.status).toBe('signedOut');
    expect(mockLogout).toHaveBeenCalledTimes(1);
    revokeGate.resolve();
    await act(async () => {
      await Promise.all([hardClose, userClose]);
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockPhotoSaveCoordinator.suspend).toHaveBeenCalledWith('signOut');
  });

  it('runs one workflow for two concurrent user sign-outs', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));

    await act(async () => {
      await Promise.all([result.current.signOut(), result.current.signOut()]);
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('owns password HTTP plus adoption and replaces the session user', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    const rotatedUser = { ...user, display_name: 'Rotated' } as AuthUser;
    const rotatedAuth: AuthResponse = {
      user: rotatedUser,
      tokens: { access: 'access-2', refresh: 'refresh-2', token_type: 'Bearer' },
    };
    mockChangePassword.mockResolvedValue(rotatedAuth);

    let outcome: 'rotated' | 'signedOut' | undefined;
    await act(async () => {
      outcome = await result.current.changePassword({
        current_password: 'old',
        new_password: 'new-secret',
      });
    });

    expect(outcome).toBe('rotated');
    expect(mockChangePassword).toHaveBeenCalledWith({
      current_password: 'old',
      new_password: 'new-secret',
    });
    expect(mockRotate).toHaveBeenCalledWith(rotatedAuth.tokens, {
      sessionGeneration: 1,
      credentialRevision: 0,
    });
    expect(result.current.user).toEqual(rotatedUser);
  });

  it('hands a password response crossing sign-out to revoke and does not publish screen state', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    const responseGate = deferred<AuthResponse>();
    const revokeGate = deferred<void>();
    mockChangePassword.mockReturnValue(responseGate.promise);
    mockLogout.mockReturnValue(revokeGate.promise);
    const rotatedAuth: AuthResponse = {
      user: { ...user, display_name: 'Must not publish' } as AuthUser,
      tokens: { access: 'access-2', refresh: 'refresh-2', token_type: 'Bearer' },
    };

    let changing!: Promise<'rotated' | 'signedOut'>;
    let signingOut!: Promise<void>;
    await act(async () => {
      changing = result.current.changePassword({
        current_password: 'old',
        new_password: 'new-secret',
      });
      signingOut = result.current.signOut();
      responseGate.resolve(rotatedAuth);
      await Promise.resolve();
    });

    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    await waitFor(() => expect(mockLogout).toHaveBeenCalledWith({
      access: 'access-2',
      refresh: 'refresh-2',
    }));
    revokeGate.resolve();

    await act(async () => {
      await signingOut;
      await expect(changing).resolves.toBe('signedOut');
    });
    expect(result.current.user).toBeNull();
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('forces shared close when password token persistence fails', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    mockChangePassword.mockResolvedValue(authResponse);
    mockRotate.mockRejectedValue(new Error('keychain unavailable'));

    let outcome: 'rotated' | 'signedOut' | undefined;
    await act(async () => {
      outcome = await result.current.changePassword({
        current_password: 'old',
        new_password: 'new-secret',
      });
    });

    expect(outcome).toBe('signedOut');
    expect(result.current.status).toBe('signedOut');
    expect(result.current.user).toBeNull();
    expect(isPrivateMediaSessionOpen()).toBe(false);
  });

  it('does not surface a stale password HTTP error after close', async () => {
    restoreWith({ access: 'access-1', refresh: 'refresh-1' });
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    const requestGate = deferred<never>();
    mockChangePassword.mockReturnValue(requestGate.promise);

    let changing!: Promise<'rotated' | 'signedOut'>;
    let closing!: Promise<void>;
    await act(async () => {
      changing = result.current.changePassword({
        current_password: 'old',
        new_password: 'new-secret',
      });
      closing = result.current.signOut();
      requestGate.reject(new Error('late failure'));
      await closing;
      await expect(changing).resolves.toBe('signedOut');
    });
    expect(isAuthTicketCurrent({ sessionGeneration: 1, credentialRevision: 0 } as AuthTicket)).toBe(false);
  });
});
