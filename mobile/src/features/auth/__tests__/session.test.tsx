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
jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(),
  rotateTokens: jest.fn(),
  setOnRefreshFailed: jest.fn(),
}));
jest.mock('../api', () => ({
  fetchMe: jest.fn(),
  logoutRequest: jest.fn(),
}));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import type { PropsWithChildren } from 'react';
// eslint-disable-next-line import/first
import { refreshTokens, rotateTokens } from '@/shared/api/refresh';
// eslint-disable-next-line import/first
import { getAccessToken, getRefreshToken, setRefreshToken } from '@/shared/api/token-store';
// eslint-disable-next-line import/first
import { fetchMe, logoutRequest } from '../api';
// eslint-disable-next-line import/first
import { SessionProvider, useSession } from '../session';
// eslint-disable-next-line import/first
import type { AuthResponse, AuthUser } from '../types';

const mockRefresh = refreshTokens as jest.MockedFunction<typeof refreshTokens>;
const mockFetchMe = fetchMe as jest.MockedFunction<typeof fetchMe>;
const mockLogout = logoutRequest as jest.MockedFunction<typeof logoutRequest>;

const user = { id: 'u1', requires_profile_setup: false } as AuthUser;
const authResponse: AuthResponse = {
  user,
  tokens: { access: 'access-1', refresh: 'refresh-1', token_type: 'Bearer' },
};

function wrapper({ children }: PropsWithChildren) {
  return <SessionProvider>{children}</SessionProvider>;
}

describe('SessionProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('restores to signedIn when refresh succeeds', async () => {
    mockRefresh.mockResolvedValue('access-1');
    mockFetchMe.mockResolvedValue(user);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
    expect(result.current.user).toEqual(user);
  });

  it('restores to signedOut when no refresh token is available', async () => {
    mockRefresh.mockResolvedValue(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    expect(mockFetchMe).not.toHaveBeenCalled();
  });

  it('signIn stores both tokens and the user', async () => {
    mockRefresh.mockResolvedValue(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));

    await act(() => result.current.signIn(authResponse));
    expect(result.current.status).toBe('signedIn');
    expect(getAccessToken()).toBe('access-1');
    await expect(getRefreshToken()).resolves.toBe('refresh-1');
  });

  it('signOut revokes the refresh token best-effort and clears state', async () => {
    mockRefresh.mockResolvedValue(null);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
    await act(() => result.current.signIn(authResponse));

    mockLogout.mockRejectedValue(new Error('network down'));
    await act(() => result.current.signOut());
    expect(mockLogout).toHaveBeenCalledWith('refresh-1');
    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('signs out when restore me-fetch fails', async () => {
    await setRefreshToken('refresh-1');
    mockRefresh.mockResolvedValue('access-1');
    mockFetchMe.mockRejectedValue(new Error('500'));
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedOut'));
  });

  it('starts in restoring state until refresh settles', async () => {
    let resolveRefresh!: (value: string | null) => void;
    mockRefresh.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    mockFetchMe.mockResolvedValue(user);
    const { result } = await renderHook(useSession, { wrapper });
    expect(result.current.status).toBe('restoring');
    await act(async () => {
      resolveRefresh('access-1');
    });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));
  });

  it('rotateSession adopts the new pair and replaces the session user', async () => {
    mockRefresh.mockResolvedValue('access-1');
    mockFetchMe.mockResolvedValue(user);
    (rotateTokens as jest.Mock).mockResolvedValue(undefined);
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));

    const rotated = { ...user, display_name: 'Rotated' } as AuthUser;
    let outcome: 'rotated' | 'signedOut' | undefined;
    await act(async () => {
      outcome = await result.current.rotateSession({
        user: rotated,
        tokens: { access: 'access-2', refresh: 'refresh-2', token_type: 'Bearer' },
      });
    });

    expect(outcome).toBe('rotated');
    expect(rotateTokens).toHaveBeenCalledWith({ access: 'access-2', refresh: 'refresh-2', token_type: 'Bearer' });
    expect(result.current.user).toEqual(rotated);
    expect(result.current.status).toBe('signedIn');
  });

  it('rotateSession forces a sign-out when the secure write fails', async () => {
    mockRefresh.mockResolvedValue('access-1');
    mockFetchMe.mockResolvedValue(user);
    (rotateTokens as jest.Mock).mockRejectedValue(new Error('keychain unavailable'));
    const { result } = await renderHook(useSession, { wrapper });
    await waitFor(() => expect(result.current.status).toBe('signedIn'));

    let outcome: 'rotated' | 'signedOut' | undefined;
    await act(async () => {
      outcome = await result.current.rotateSession(authResponse);
    });

    expect(outcome).toBe('signedOut');
    expect(result.current.status).toBe('signedOut');
    expect(result.current.user).toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });
});
