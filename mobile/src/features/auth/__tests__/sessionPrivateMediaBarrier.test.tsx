/**
 * D20 regression: a refresh that is already in flight when the user signs out
 * must not resurrect the session.
 *
 * Both transports are covered, because both can refresh. `fetchProtectedResponse`
 * calls `refreshTokens()` directly; an Axios photo call refreshes inside the
 * response interceptor in `shared/api/client.ts`. Tracking only the first would
 * leave the second free to write a fresh access token into a store the user just
 * cleared. Neither `refresh.ts` nor the interceptor is modified — the barrier is
 * entirely at the caller.
 */

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
jest.mock('../api', () => ({
  fetchMe: jest.fn(),
  logoutRequest: jest.fn(),
}));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import type { PropsWithChildren } from 'react';
// eslint-disable-next-line import/first
import { AxiosError } from 'axios';
// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import { refreshHttp } from '@/shared/api/refresh';
// eslint-disable-next-line import/first
import { getAccessToken, getRefreshToken, setAccessToken } from '@/shared/api/token-store';
// eslint-disable-next-line import/first
import { fetchProtectedResponse } from '@/shared/media/fetchProtectedAsset';
// eslint-disable-next-line import/first
import { trackPrivateOperation } from '@/shared/media/privateMediaLifecycle';
// eslint-disable-next-line import/first
import { bytes, createDeferred, createFakeTransport, flushMicrotasks, imageResponse, jsonErrorResponse } from '@test/fakeProtectedTransport';
// eslint-disable-next-line import/first
import { fetchMe, logoutRequest } from '../api';
// eslint-disable-next-line import/first
import { SessionProvider, useSession } from '../session';
// eslint-disable-next-line import/first
import type { AuthUser } from '../types';

const mockFetchMe = fetchMe as jest.MockedFunction<typeof fetchMe>;
const mockLogout = logoutRequest as jest.MockedFunction<typeof logoutRequest>;

const user = { id: 'u1', requires_profile_setup: false } as AuthUser;

function wrapper({ children }: PropsWithChildren) {
  return <SessionProvider>{children}</SessionProvider>;
}

/**
 * Restores a real signed-in session and hands back the gate that holds the
 * *next* refresh open. The restore itself must not be gated, or the provider
 * never leaves `restoring` and there is no session to sign out of.
 */
async function signedInSessionWithGatedRefresh() {
  const refreshGate = createDeferred<void>();
  // Ordering is the whole point, so it is recorded rather than inferred.
  const events: string[] = [];
  let refreshHttpCalls = 0;

  jest.spyOn(refreshHttp, 'post').mockImplementation(async () => {
    refreshHttpCalls += 1;
    if (refreshHttpCalls === 1) {
      return { data: { access: 'access-1', refresh: 'refresh-1' } } as never;
    }
    await refreshGate.promise;
    events.push('refresh-settled');
    return { data: { access: 'access-2', refresh: 'refresh-2' } } as never;
  });
  mockLogout.mockImplementation(async () => {
    events.push('logout');
  });

  const { setItemAsync } = jest.requireMock('expo-secure-store');
  await setItemAsync('goplan.refresh_token', 'refresh-0');

  mockFetchMe.mockResolvedValue(user);
  const { result } = await renderHook(useSession, { wrapper });
  await waitFor(() => expect(result.current.status).toBe('signedIn'));
  expect(getAccessToken()).toBe('access-1');

  return { result, refreshGate, events, refreshHttpCallCount: () => refreshHttpCalls };
}

const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

beforeEach(async () => {
  jest.clearAllMocks();
  setAccessToken(null);
  // The real refresh module is used here on purpose: single-flight, the
  // generation barrier and the SecureStore write queue are the mechanisms under
  // test. Only the network underneath it is faked.
  await getRefreshToken();
});

describe('sign-out while a protected fetch is refreshing', () => {
  it('leaves both tokens null even though the refresh settles afterwards', async () => {
    const { result, refreshGate, events, refreshHttpCallCount } =
      await signedInSessionWithGatedRefresh();

    const transport = createFakeTransport((_call, index) =>
      index === 0 ? jsonErrorResponse(401, { detail: 'expired' }).response : imageResponse([bytes(8)]).response,
    );
    const pending = fetchProtectedResponse({
      path: '/trips/trip-1/photos/photo-1/thumbnail',
      transport,
    }).catch((error: unknown) => error);
    await flushMicrotasks();

    // Sign out while the 401 has been observed and the refresh is in flight.
    await act(async () => {
      const signingOut = result.current.signOut();
      await flushMicrotasks();
      refreshGate.resolve();
      await signingOut;
    });
    await pending;

    // The gated refresh really ran and really wrote a new pair; sign-out waited
    // for it and cleared afterwards, so nothing survives.
    expect(refreshHttpCallCount()).toBe(2);
    expect(events).toEqual(['refresh-settled', 'logout']);
    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
    // The aborted request never retried.
    expect(transport.fetches.calls).toHaveLength(1);
  });
});

describe('sign-out while an Axios photo request is refreshing', () => {
  it('waits for the interceptor refresh inside the tracked operation, then clears', async () => {
    const { result, refreshGate, events, refreshHttpCallCount } =
      await signedInSessionWithGatedRefresh();

    // Stands in for `deleteTripPhoto`: an ordinary Axios call wrapped as tracked
    // private-network activity, whose 401 is retried by the shared interceptor.
    // Same adapter shape `shared/api/__tests__/client.test.ts` uses: the 401 has
    // to arrive as a real AxiosError carrying `config`, which is what the shared
    // response interceptor requires before it will refresh and replay.
    let axiosAttempts = 0;
    apiClient.defaults.adapter = async (config) => {
      axiosAttempts += 1;
      if (axiosAttempts === 1) {
        throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
          status: 401,
          statusText: '',
          headers: {},
          config,
          data: { detail: 'expired' },
        });
      }
      return { status: 204, statusText: 'No Content', headers: {}, config, data: null };
    };

    const operation = trackPrivateOperation(async (signal) =>
      apiClient
        .request({ url: '/trips/trip-1/photos/photo-1', method: 'delete', signal })
        .catch((error: unknown) => error),
    ).catch((error: unknown) => error);
    await flushMicrotasks();

    await act(async () => {
      const signingOut = result.current.signOut();
      await flushMicrotasks();
      refreshGate.resolve();
      await signingOut;
    });
    await operation;

    // The interceptor's own refresh ran inside the tracked operation and wrote a
    // fresh pair; sign-out waited for it before revoking, so the clear wins.
    // Without the barrier this ordering flips and the app comes back signed in.
    expect(axiosAttempts).toBe(1);
    expect(refreshHttpCallCount()).toBe(2);
    expect(events).toEqual(['refresh-settled', 'logout']);
    expect(result.current.status).toBe('signedOut');
    expect(getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
