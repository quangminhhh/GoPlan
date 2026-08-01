import { refreshTokens } from '@/shared/api/refresh';
import {
  __resetAuthSessionLifecycleForTests,
  activateAuthSession,
  beginAuthSessionOpening,
  publishAuthPair,
  requestAuthSessionClose,
  type AuthTicket,
} from '@/shared/api/authSessionLifecycle';
import { getAccessToken } from '@/shared/api/token-store';
import {
  assertSameOriginApiPath,
  fetchProtectedResponse,
  parseProtectedErrorBody,
} from '../fetchProtectedAsset';
import {
  __resetPrivateMediaLifecycleForTests,
  beginPrivateMediaShutdown,
  startPrivateMediaSession,
  waitForPrivateNetworkIdle,
} from '../privateMediaLifecycle';
import { ProtectedAssetError } from '../protectedAssetTypes';
import {
  createDeferred,
  createFakeResponse,
  createFakeTransport,
  flushMicrotasks,
  imageResponse,
  jsonErrorResponse,
  bytes,
} from '@test/fakeProtectedTransport';

jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(),
}));

const mockRefreshTokens = refreshTokens as jest.MockedFunction<typeof refreshTokens>;

const PATH = '/trips/trip-1/photos/photo-1/thumbnail';
let authTicket: AuthTicket;

function publishAccess(access: string): void {
  expect(
    publishAuthPair(authTicket, { access, refresh: `refresh-for-${access}` }),
  ).toBe(true);
}

async function startOpeningWithoutAccess(): Promise<void> {
  __resetAuthSessionLifecycleForTests();
  authTicket = await beginAuthSessionOpening();
}

/** Runs a request that is expected to fail and returns the typed error. */
async function expectProtectedFailure(pending: Promise<Response>): Promise<ProtectedAssetError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ProtectedAssetError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the protected request to fail.');
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetAuthSessionLifecycleForTests();
  __resetPrivateMediaLifecycleForTests();
  authTicket = await beginAuthSessionOpening();
  publishAccess('token-old');
  activateAuthSession(authTicket);
  await startPrivateMediaSession();
});

afterEach(() => {
  __resetAuthSessionLifecycleForTests();
});

describe('assertSameOriginApiPath', () => {
  it.each([
    ['an absolute url', 'https://evil.example.com/steal'],
    ['a protocol-relative path', '//evil.example.com/steal'],
    ['a scheme inside the path', '/trips/x://evil.example.com'],
    ['a backslash', '\\trips\\x'],
    ['a traversal segment', '/trips/../../auth/refresh'],
    ['a single-dot segment', '/trips/./photos'],
    ['a query string', '/trips/x/photos?token=leak'],
    ['a fragment', '/trips/x/photos#leak'],
    ['a relative path', 'trips/x/photos'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(() => assertSameOriginApiPath(path)).toThrow(ProtectedAssetError);
  });

  it('rejects control characters without using a literal control-char regex', () => {
    expect(() => assertSameOriginApiPath('/trips/x\u0000/photos')).toThrow(ProtectedAssetError);
    expect(() => assertSameOriginApiPath('/trips/x\u007f/photos')).toThrow(ProtectedAssetError);
  });

  it('accepts an ordinary api path', () => {
    expect(() => assertSameOriginApiPath(PATH)).not.toThrow();
  });
});

describe('fetchProtectedResponse request shape', () => {
  it('reads the access token immediately before the request', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    publishAccess('token-rotated');
    await fetchProtectedResponse({ path: PATH, transport });

    expect(transport.fetches.authorizations()).toEqual(['Bearer token-rotated']);
  });

  it('builds the url from the api base and the validated path only', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await fetchProtectedResponse({ path: PATH, transport });

    expect(transport.fetches.calls[0].url).toBe(`http://testserver:8000/api${PATH}`);
  });

  it('refuses to follow redirects so the bearer token cannot reach another origin', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await fetchProtectedResponse({ path: PATH, transport });

    expect(transport.fetches.calls[0].init.redirect).toBe('error');
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN'])(
    'rejects a caller-supplied %s header',
    async (header) => {
      const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

      expect(() =>
        fetchProtectedResponse({ path: PATH, headers: { [header]: 'Bearer stolen' }, transport }),
      ).toThrow(ProtectedAssetError);
      expect(transport.fetches.calls).toHaveLength(0);
    },
  );

  it('never puts the token in the url', async () => {
    publishAccess('super-secret-token');
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await fetchProtectedResponse({ path: PATH, transport });

    expect(transport.fetches.calls[0].url).not.toContain('super-secret-token');
  });

  it('refreshes once when there is no access token at all', async () => {
    await startOpeningWithoutAccess();
    mockRefreshTokens.mockImplementation(async () => {
      publishAccess('token-restored');
      return 'token-restored';
    });
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await fetchProtectedResponse({ path: PATH, transport });

    expect(mockRefreshTokens).toHaveBeenCalledTimes(1);
    expect(transport.fetches.authorizations()).toEqual(['Bearer token-restored']);
  });

  it('fails with an auth error when no token can be restored', async () => {
    await startOpeningWithoutAccess();
    mockRefreshTokens.mockResolvedValue(null);
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(transport.fetches.calls).toHaveLength(0);
  });
});

describe('401 handling', () => {
  it('refreshes once and retries with the new token', async () => {
    mockRefreshTokens.mockImplementation(async () => {
      publishAccess('token-new');
      return 'token-new';
    });
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? jsonErrorResponse(401, { detail: 'nope' }).response : imageResponse([bytes(4)]).response,
    );

    const response = await fetchProtectedResponse({ path: PATH, transport });

    expect(response.status).toBe(200);
    expect(mockRefreshTokens).toHaveBeenCalledTimes(1);
    expect(transport.fetches.authorizations()).toEqual(['Bearer token-old', 'Bearer token-new']);
  });

  it('retries without refreshing when another request already rotated the token (D4)', async () => {
    const transport = createFakeTransport((_call, index) => {
      if (index === 0) {
        // The 401 resolves late: by the time it is observed, some other request
        // has already completed a refresh.
        publishAccess('token-new');
        return jsonErrorResponse(401, { detail: 'nope' }).response;
      }
      return imageResponse([bytes(4)]).response;
    });

    await fetchProtectedResponse({ path: PATH, transport });

    expect(mockRefreshTokens).not.toHaveBeenCalled();
    expect(transport.fetches.authorizations()).toEqual(['Bearer token-old', 'Bearer token-new']);
  });

  it('cancels without refresh or Bearer null after auth close invalidates its ticket', async () => {
    const transport = createFakeTransport((_call, index) => {
      if (index === 0) {
        void requestAuthSessionClose('user');
        return jsonErrorResponse(401, { detail: 'nope' }).response;
      }
      return imageResponse([bytes(4)]).response;
    });

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(mockRefreshTokens).not.toHaveBeenCalled();
    expect(transport.fetches.calls).toHaveLength(1);
  });

  it('retries at most once', async () => {
    mockRefreshTokens.mockImplementation(async () => {
      publishAccess('token-new');
      return 'token-new';
    });
    const transport = createFakeTransport(() => jsonErrorResponse(401, { detail: 'nope' }).response);

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    expect(transport.fetches.calls).toHaveLength(2);
    expect(mockRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it('stops with an auth error when the refresh fails', async () => {
    mockRefreshTokens.mockResolvedValue(null);
    const transport = createFakeTransport(() => jsonErrorResponse(401, { detail: 'nope' }).response);

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(transport.fetches.calls).toHaveLength(1);
  });

  it('cancels the 401 body before retrying so no native stream is left open', async () => {
    mockRefreshTokens.mockImplementation(async () => {
      publishAccess('token-new');
      return 'token-new';
    });
    const unauthorized = createFakeResponse({
      status: 401,
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      chunks: [bytes(2)],
      text: '{}',
    });
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? unauthorized.response : imageResponse([bytes(4)]).response,
    );

    await fetchProtectedResponse({ path: PATH, transport });

    expect(unauthorized.cancelled()).toBe(true);
  });
});

describe('60 concurrent tiles racing one expiry', () => {
  it('refreshes exactly once and retries every tile with the new token', async () => {
    const refreshGate = createDeferred<void>();
    let refreshHttpCalls = 0;
    let refreshInFlight: Promise<string | null> | null = null;

    // Mirrors the real `refreshTokens()`: single-flight, so counting invocations
    // would say nothing. What matters is how many times the refresh endpoint is
    // actually hit, and how many tiles skipped asking for one at all.
    mockRefreshTokens.mockImplementation(() => {
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          refreshHttpCalls += 1;
          await refreshGate.promise;
          publishAccess('token-new');
          return 'token-new';
        })().finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    });

    // The first 40 tiles observe their 401 while the refresh is still pending;
    // the last 20 observe it only after the refresh promise has settled.
    const lateGate = createDeferred<void>();
    const transport = createFakeTransport(async (call, index) => {
      if (call.authorization === 'Bearer token-old') {
        if (index >= 40) {
          await lateGate.promise;
        }
        return jsonErrorResponse(401, { detail: 'expired' }).response;
      }
      return imageResponse([bytes(8)]).response;
    });

    const inFlight = Array.from({ length: 60 }, () =>
      fetchProtectedResponse({ path: PATH, transport }),
    );

    await flushMicrotasks(8);
    refreshGate.resolve();
    await flushMicrotasks(8);
    lateGate.resolve();

    const responses = await Promise.all(inFlight);

    expect(responses).toHaveLength(60);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    // The refresh endpoint is hit exactly once for all 60 tiles.
    expect(refreshHttpCalls).toBe(1);
    // The 20 tiles whose 401 resolved after the refresh had settled compared the
    // token they sent against the current one and retried straight away, without
    // asking for a refresh at all (D4).
    expect(mockRefreshTokens).toHaveBeenCalledTimes(40);
    // 60 first attempts + 60 retries, and never a third attempt for any tile.
    expect(transport.fetches.calls).toHaveLength(120);
    expect(transport.fetches.authorizations().filter((value) => value === 'Bearer token-new')).toHaveLength(
      60,
    );
  });

  it('keeps the token out of thrown errors', async () => {
    publishAccess('token-that-must-not-leak');
    mockRefreshTokens.mockResolvedValue(null);
    const transport = createFakeTransport(() => jsonErrorResponse(401, { detail: 'expired' }).response);

    const error = await expectProtectedFailure(fetchProtectedResponse({ path: PATH, transport }));

    const serialized = `${String(error)} ${error.message}`;
    expect(serialized).not.toContain('token-that-must-not-leak');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('non-2xx outcomes', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'notFound'],
    [429, 'throttled'],
    [500, 'server'],
    [503, 'server'],
    [400, 'request'],
    [409, 'request'],
  ])('maps %i without retrying', async (status, kind) => {
    const transport = createFakeTransport(() => jsonErrorResponse(status, { detail: 'no' }).response);

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({ kind, status });
    expect(transport.fetches.calls).toHaveLength(1);
  });

  it('carries the error_code so owners can branch trip-level from photo-level (D18)', async () => {
    const transport = createFakeTransport(
      () => jsonErrorResponse(404, { detail: 'Trip not found.', error_code: 'TRIP_NOT_FOUND' }).response,
    );

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'notFound',
      errorCode: 'TRIP_NOT_FOUND',
      message: 'Trip not found.',
    });
  });

  it('reports a transport failure as a network error', async () => {
    const transport = createFakeTransport(() => {
      throw new Error('connection reset');
    });

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});

describe('error body parsing', () => {
  it('reads detail and error_code from a service-layer body', async () => {
    const handle = jsonErrorResponse(400, { detail: 'Too many files.', error_code: 'TOO_MANY_FILES' });

    await expect(parseProtectedErrorBody(handle.response)).resolves.toEqual({
      detail: 'Too many files.',
      errorCode: 'TOO_MANY_FILES',
    });
  });

  it('degrades to a safe generic message on a DRF field-error body', async () => {
    // `photo_ids` empty is rejected by the serializer, which produces a body with
    // neither `detail` nor `error_code`.
    const transport = createFakeTransport(
      () => jsonErrorResponse(400, { photo_ids: ['This list may not be empty.'] }).response,
    );

    const error = await expectProtectedFailure(fetchProtectedResponse({ path: PATH, transport }));

    expect(error.kind).toBe('request');
    expect(error.errorCode).toBeUndefined();
    expect(error.message).toBe('Something went wrong. Please try again.');
    expect(error.message).not.toContain('photo_ids');
  });

  it('does not buffer a body without a usable content-length', async () => {
    const handle = createFakeResponse({
      status: 500,
      headers: { 'content-type': 'text/html' },
      chunks: [bytes(64)],
      text: '<html>a very large proxy error page</html>',
    });

    await expect(parseProtectedErrorBody(handle.response)).resolves.toEqual({});
    expect(handle.cancelled()).toBe(true);
  });

  it('does not buffer a body larger than the parse ceiling', async () => {
    const handle = createFakeResponse({
      status: 500,
      headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) },
      chunks: [bytes(64)],
      text: 'x',
    });

    await expect(parseProtectedErrorBody(handle.response)).resolves.toEqual({});
    expect(handle.cancelled()).toBe(true);
  });

  it('survives a body that is not json', async () => {
    const handle = createFakeResponse({
      status: 500,
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
      text: 'boom!',
    });

    await expect(parseProtectedErrorBody(handle.response)).resolves.toEqual({});
  });
});

describe('cancellation', () => {
  it('normalises a caller abort into a cancelled outcome without refreshing', async () => {
    const controller = new AbortController();
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(4)]).response;
    });

    const pending = fetchProtectedResponse({ path: PATH, signal: controller.signal, transport });
    await flushMicrotasks();
    controller.abort();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it('refuses to start once the session gate is closed', async () => {
    beginPrivateMediaShutdown();
    const transport = createFakeTransport(() => imageResponse([bytes(4)]).response);

    await expect(fetchProtectedResponse({ path: PATH, transport })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(transport.fetches.calls).toHaveLength(0);
  });

  it('does not retry after sign-out aborts a request that is already in flight', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async (_call, index) => {
      if (index === 0) {
        await gate.promise;
        return jsonErrorResponse(401, { detail: 'expired' }).response;
      }
      return imageResponse([bytes(4)]).response;
    });

    const pending = fetchProtectedResponse({ path: PATH, transport });
    await flushMicrotasks();

    beginPrivateMediaShutdown();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await waitForPrivateNetworkIdle();
    expect(transport.fetches.calls).toHaveLength(1);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('token-old');
  });
});
