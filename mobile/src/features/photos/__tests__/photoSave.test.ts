/* eslint-disable import/first -- Jest mocks must install before native-backed imports. */
jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(),
}));

jest.mock('../nativePhotoActions', () => ({
  nativePhotoActions: {
    requestAddOnlyPermission: jest.fn(),
    createAsset: jest.fn(),
  },
}));

import {
  __resetAuthSessionLifecycleForTests,
  activateAuthSession,
  beginAuthSessionOpening,
  publishAuthPair,
  requestAuthSessionClose,
  type AuthTicket,
} from '@/shared/api/authSessionLifecycle';
import {
  createPhotoSaveTempCoordinator,
  type PhotoSaveRunHandle,
  type PhotoSaveTempCoordinator,
} from '@/shared/media/photoSaveTempStore';
import {
  __resetPrivateMediaLifecycleForTests,
  startPrivateMediaSession,
} from '@/shared/media/privateMediaLifecycle';
import type {
  ProtectedFileSink,
  ProtectedTransport,
} from '@/shared/media/protectedAssetTypes';
import {
  bytes,
  createDeferred,
  createFakeFileStore,
  createFakeResponse,
  createFakeTransport,
  flushMicrotasks,
  imageResponse,
  jsonErrorResponse,
  type FakeFileStore,
} from '@test/fakeProtectedTransport';
import { MEDIUM_MAX_BYTES, PRIVATE_MEDIA_DISK_RESERVE_BYTES } from '../constants';
import type { TripPhotoScope, TripPhotoScopeTicket } from '../hooks/useTripPhotoScope';
import {
  capturePhotoSaveTickets,
  createPhotoSaveActionLock,
  extensionForPhotoContentType,
  hasPhotoSaveCommitHeadroom,
  hasPhotoSaveWriteReserve,
  normalizedPhotoContentType,
  saveOneTripPhoto,
  saveTripPhotoToLibrary,
} from '../photoSave';
import type {
  PhotoLibraryAdapter,
  PhotoSaveCapturedTickets,
  PhotoSaveGate,
  PhotoSaveItemOutcome,
} from '../photoSaveTypes';
/* eslint-enable import/first */

interface MutableTripScope extends TripPhotoScope {
  invalidate(nextTripId?: string): Promise<void>;
}

interface GateState {
  open: boolean;
  tombstoned: boolean;
  interruption: ReturnType<PhotoSaveGate['interruption']>;
}

interface PrimitiveHarness {
  authTicket: AuthTicket;
  scope: MutableTripScope;
  store: FakeFileStore;
  coordinator: PhotoSaveTempCoordinator;
  captured: PhotoSaveCapturedTickets;
  run: PhotoSaveRunHandle;
  gateState: GateState;
  gate: PhotoSaveGate;
  createAsset: jest.Mock<Promise<void>, [string]>;
  library: PhotoLibraryAdapter;
}

function createTripScope(tripId = 'trip-1'): MutableTripScope {
  let ticket: TripPhotoScopeTicket = { tripId, generation: 0 };
  const listeners = new Set<
    (previous: TripPhotoScopeTicket, current: TripPhotoScopeTicket) => void | Promise<void>
  >();
  let cleanupTail = Promise.resolve();

  return {
    capture: () => ticket,
    isCurrent: (candidate) =>
      candidate.tripId === ticket.tripId && candidate.generation === ticket.generation,
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForCleanup: () => cleanupTail,
    invalidate: (nextTripId = `${ticket.tripId}-next`) => {
      const previous = ticket;
      ticket = { tripId: nextTripId, generation: ticket.generation + 1 };
      const cleanups = Array.from(listeners, (listener) => listener(previous, ticket));
      cleanupTail = Promise.allSettled(cleanups).then(() => undefined);
      return cleanupTail;
    },
  };
}

async function activateAuth(access = 'access-a'): Promise<AuthTicket> {
  const ticket = await beginAuthSessionOpening();
  expect(
    publishAuthPair(ticket, { access, refresh: `refresh-${access}` }),
  ).toBe(true);
  expect(activateAuthSession(ticket)).toBe(true);
  return ticket;
}

function createLibrary(
  createAsset: jest.Mock<Promise<void>, [string]> = jest.fn<Promise<void>, [string]>(
    async () => undefined,
  ),
  permission: PhotoLibraryAdapter['requestAddOnlyPermission'] = async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  }),
): PhotoLibraryAdapter {
  return {
    requestAddOnlyPermission: permission,
    createAsset,
  };
}

async function createPrimitiveHarness(): Promise<PrimitiveHarness> {
  const authTicket = await activateAuth();
  await startPrivateMediaSession();
  const scope = createTripScope();
  const store = createFakeFileStore('photo-save-test');
  const coordinator = createPhotoSaveTempCoordinator(store);
  coordinator.activateSession(authTicket.sessionGeneration, true);
  const captured = capturePhotoSaveTickets(scope, coordinator);
  if (!captured) throw new Error('Expected active save tickets.');
  const run = await coordinator.beginRun(captured.store);
  const gateState: GateState = {
    open: true,
    tombstoned: false,
    interruption: 'cancelled',
  };
  const gate: PhotoSaveGate = {
    isOpen: () => gateState.open,
    isTombstoned: () => gateState.tombstoned,
    interruption: () => gateState.interruption,
  };
  const createAsset = jest.fn<Promise<void>, [string]>(async () => undefined);
  return {
    authTicket,
    scope,
    store,
    coordinator,
    captured,
    run,
    gateState,
    gate,
    createAsset,
    library: createLibrary(createAsset),
  };
}

async function runPrimitive(
  harness: PrimitiveHarness,
  transport: ProtectedTransport,
  overrides: Partial<Parameters<typeof saveOneTripPhoto>[0]> = {},
): Promise<PhotoSaveItemOutcome> {
  try {
    return await saveOneTripPhoto({
      tripId: 'trip-1',
      photoId: 'photo-1',
      captured: harness.captured,
      tripScope: harness.scope,
      coordinator: harness.coordinator,
      run: harness.run,
      library: harness.library,
      gate: harness.gate,
      transport,
      ...overrides,
    });
  } finally {
    harness.run.release();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetAuthSessionLifecycleForTests();
  __resetPrivateMediaLifecycleForTests();
});

afterEach(() => {
  __resetAuthSessionLifecycleForTests();
  __resetPrivateMediaLifecycleForTests();
});

describe('photo save validation helpers', () => {
  it.each([
    ['image/webp', 'image/webp', '.webp'],
    [' IMAGE/JPEG; charset=binary ', 'image/jpeg', '.jpg'],
    ['image/png', 'image/png', '.png'],
    ['image/gif', null, null],
    [null, null, null],
  ])('normalizes and allowlists %p', (input, normalized, extension) => {
    expect(normalizedPhotoContentType(input)).toBe(normalized);
    expect(extensionForPhotoContentType(input)).toBe(extension);
  });

  it('accepts exact reserve/headroom boundaries and rejects unavailable probes', () => {
    expect(hasPhotoSaveWriteReserve(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 4, 4)).toBe(true);
    expect(hasPhotoSaveWriteReserve(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 3, 4)).toBe(false);
    expect(hasPhotoSaveCommitHeadroom(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 4, 4)).toBe(true);
    expect(hasPhotoSaveCommitHeadroom(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 3, 4)).toBe(false);
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(hasPhotoSaveWriteReserve(value, 1)).toBe(false);
      expect(hasPhotoSaveCommitHeadroom(value, 1)).toBe(false);
    }
  });
});

describe('saveOneTripPhoto', () => {
  it('streams a missing-length response with an authenticated GET and commits an allowlisted file', async () => {
    const harness = await createPrimitiveHarness();
    const transport = createFakeTransport(() =>
      imageResponse([bytes(2), bytes(3)], 'image/jpeg').response,
    );
    const progress: number[] = [];

    const outcome = await runPrimitive(harness, transport, {
      onProgress: (written) => progress.push(written),
    });

    expect(outcome).toEqual({ status: 'committed' });
    expect(progress).toEqual([2, 5]);
    expect(harness.createAsset).toHaveBeenCalledTimes(1);
    expect(harness.createAsset.mock.calls[0][0]).toMatch(/\.jpg$/);
    expect(transport.fetches.calls).toHaveLength(1);
    expect(transport.fetches.calls[0].init).toMatchObject({
      method: 'GET',
      redirect: 'error',
    });
    expect(transport.fetches.authorizations()).toEqual(['Bearer access-a']);
    expect(harness.store.contents().size).toBe(0);
  });

  it.each([
    ['wrong content type', createFakeResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      chunks: [bytes(2)],
    }).response],
    ['oversized declared body', createFakeResponse({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(MEDIUM_MAX_BYTES + 1),
      },
      chunks: [bytes(1)],
    }).response],
    ['fractional declared body', createFakeResponse({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '1.5',
      },
      chunks: [bytes(1)],
    }).response],
    ['truncated declared body', createFakeResponse({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '5',
      },
      chunks: [bytes(4)],
    }).response],
    ['empty body', imageResponse([]).response],
  ])('rejects %s before native and cleans the current file', async (_label, response) => {
    const harness = await createPrimitiveHarness();
    const transport = createFakeTransport(() => response);

    const outcome = await runPrimitive(harness, transport);

    expect(outcome).toMatchObject({ status: 'retryableFailed' });
    expect(harness.createAsset).not.toHaveBeenCalled();
    expect(harness.store.contents().size).toBe(0);
  });

  it('bounds streamed bytes even without Content-Length', async () => {
    const harness = await createPrimitiveHarness();
    const response = imageResponse([bytes(MEDIUM_MAX_BYTES), bytes(1)]).response;

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => response),
    );

    expect(outcome).toMatchObject({ status: 'retryableFailed' });
    expect(harness.createAsset).not.toHaveBeenCalled();
    expect(harness.store.contents().size).toBe(0);
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'fails closed for free-space probe %p before writing',
    async (available) => {
      const harness = await createPrimitiveHarness();
      harness.store.setAvailableBytes(available);
      const originalCreate = harness.store.createSink.bind(harness.store);
      const write = jest.fn(async () => undefined);
      harness.store.createSink = async (name) => {
        const sink = await originalCreate(name);
        return { ...sink, write };
      };

      const outcome = await runPrimitive(
        harness,
        createFakeTransport(() => imageResponse([bytes(4)]).response),
      );

      expect(outcome).toMatchObject({ status: 'retryableFailed' });
      expect(write).not.toHaveBeenCalled();
      expect(harness.createAsset).not.toHaveBeenCalled();
      expect(harness.store.contents().size).toBe(0);
    },
  );

  it('checks the reserve immediately before every non-empty chunk write', async () => {
    const harness = await createPrimitiveHarness();
    const available = jest
      .fn<number | null, []>()
      .mockReturnValueOnce(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 2)
      .mockReturnValueOnce(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 1)
      .mockReturnValue(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 4);
    harness.store.availableBytes = available;
    const originalCreate = harness.store.createSink.bind(harness.store);
    const write = jest.fn<Promise<void>, [Uint8Array]>();
    harness.store.createSink = async (name) => {
      const sink = await originalCreate(name);
      write.mockImplementation((chunk) => sink.write(chunk));
      return { ...sink, write };
    };

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => imageResponse([bytes(2), bytes(2)]).response),
    );

    expect(outcome).toMatchObject({ status: 'retryableFailed' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(harness.createAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['exact headroom', PRIVATE_MEDIA_DISK_RESERVE_BYTES + 4, 'committed'],
    ['headroom minus one', PRIVATE_MEDIA_DISK_RESERVE_BYTES + 3, 'retryableFailed'],
  ])('enforces %s after authoritative stat', async (_label, headroom, status) => {
    const harness = await createPrimitiveHarness();
    harness.store.availableBytes = jest
      .fn<number | null, []>()
      .mockReturnValueOnce(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 4)
      .mockReturnValue(headroom);

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => imageResponse([bytes(4)]).response),
    );

    expect(outcome.status).toBe(status);
    expect(harness.createAsset).toHaveBeenCalledTimes(status === 'committed' ? 1 : 0);
  });

  it.each(['write', 'close', 'counterMismatch', 'stat', 'zeroStat', 'mismatch'] as const)(
    'cleans up and never calls native when %s validation fails',
    async (failurePoint) => {
      const harness = await createPrimitiveHarness();
      const originalCreate = harness.store.createSink.bind(harness.store);
      const originalStat = harness.store.stat.bind(harness.store);
      harness.store.createSink = async (name) => {
        const sink = await originalCreate(name);
        const wrapped: ProtectedFileSink = {
          ...sink,
          write:
            failurePoint === 'write'
              ? async () => {
                  throw new Error('write failed');
                }
              : sink.write,
          close:
            failurePoint === 'close'
              ? async () => {
                  throw new Error('close failed');
                }
              : sink.close,
          bytesWritten:
            failurePoint === 'counterMismatch'
              ? () => sink.bytesWritten() + 1
              : sink.bytesWritten,
        };
        return wrapped;
      };
      if (failurePoint === 'stat') {
        harness.store.stat = async () => null;
      } else if (failurePoint === 'zeroStat') {
        harness.store.stat = async () => ({ bytes: 0 });
      } else if (failurePoint === 'mismatch') {
        harness.store.stat = async (uri) => {
          const stat = await originalStat(uri);
          return stat ? { bytes: stat.bytes + 1 } : null;
        };
      }

      const outcome = await runPrimitive(
        harness,
        createFakeTransport(() => imageResponse([bytes(4)]).response),
      );

      expect(outcome).toMatchObject({ status: 'retryableFailed' });
      expect(harness.createAsset).not.toHaveBeenCalled();
      expect(harness.store.contents().size).toBe(0);
    },
  );

  it('stops after the sink closes when the gate closes', async () => {
    const harness = await createPrimitiveHarness();
    const originalCreate = harness.store.createSink.bind(harness.store);
    harness.store.createSink = async (name) => {
      const sink = await originalCreate(name);
      return {
        ...sink,
        close: async () => {
          await sink.close();
          harness.gateState.open = false;
        },
      };
    };

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => imageResponse([bytes(4)]).response),
    );

    expect(outcome).toEqual({ status: 'unattempted', interruption: 'cancelled' });
    expect(harness.createAsset).not.toHaveBeenCalled();
    expect(harness.store.contents().size).toBe(0);
  });

  it('honours a synchronous tombstone published at the final saving stage', async () => {
    const harness = await createPrimitiveHarness();
    const onTombstone = jest.fn();

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => imageResponse([bytes(4)]).response),
      {
        onStage: (stage) => {
          if (stage === 'saving') harness.gateState.tombstoned = true;
        },
        onTombstone,
      },
    );

    expect(outcome).toMatchObject({ status: 'terminalSkipped' });
    expect(onTombstone).toHaveBeenCalledWith('photo-1');
    expect(harness.createAsset).not.toHaveBeenCalled();
  });

  it('classifies authoritative and reconciled photo 404s without guessing malformed 404s', async () => {
    const authoritative = await createPrimitiveHarness();
    const tombstone = jest.fn();
    const photo404 = jsonErrorResponse(404, {
      detail: 'Gone.',
      error_code: 'PHOTO_NOT_FOUND',
    }).response;
    const photoOutcome = await runPrimitive(
      authoritative,
      createFakeTransport(() => photo404),
      { onTombstone: tombstone },
    );
    expect(photoOutcome).toMatchObject({ status: 'terminalSkipped' });
    expect(tombstone).toHaveBeenCalledWith('photo-1');

    __resetAuthSessionLifecycleForTests();
    __resetPrivateMediaLifecycleForTests();
    const ambiguous = await createPrimitiveHarness();
    const resolver = jest.fn(async () => 'unknown' as const);
    const malformed404 = jsonErrorResponse(404, { detail: 'Missing.' }).response;
    const unknownOutcome = await runPrimitive(
      ambiguous,
      createFakeTransport(() => malformed404),
      { resolveAmbiguousNotFound: resolver },
    );
    expect(unknownOutcome).toMatchObject({ status: 'retryableFailed' });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('turns a failed ambiguous-404 reconcile into a retryable result', async () => {
    const harness = await createPrimitiveHarness();
    const malformed404 = jsonErrorResponse(404, { detail: 'Missing.' }).response;

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => malformed404),
      {
        resolveAmbiguousNotFound: async () => {
          throw new Error('reconcile failed');
        },
      },
    );

    expect(outcome).toMatchObject({
      status: 'retryableFailed',
      failure: { kind: 'server' },
    });
  });

  it.each(['forbidden', 'trip404', 'resolvedTrip'] as const)(
    'publishes %s as trip-unavailable evidence before stopping',
    async (mode) => {
      const harness = await createPrimitiveHarness();
      const response =
        mode === 'forbidden'
          ? jsonErrorResponse(403, { detail: 'Membership lost.' }).response
          : mode === 'trip404'
            ? jsonErrorResponse(404, {
                detail: 'Trip gone.',
                error_code: 'TRIP_NOT_FOUND',
              }).response
            : jsonErrorResponse(404, { detail: 'Missing.' }).response;
      const onTripUnavailable = jest.fn();

      const outcome = await runPrimitive(
        harness,
        createFakeTransport(() => response),
        {
          onTripUnavailable,
          ...(mode === 'resolvedTrip'
            ? { resolveAmbiguousNotFound: async () => 'trip' as const }
            : {}),
        },
      );

      expect(outcome).toMatchObject({
        status: 'unattempted',
        interruption: 'tripUnavailable',
      });
      expect(onTripUnavailable).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps trip-unavailable classification when its observer throws', async () => {
    const harness = await createPrimitiveHarness();
    const response = jsonErrorResponse(404, {
      detail: 'Trip gone.',
      error_code: 'TRIP_NOT_FOUND',
    }).response;

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => response),
      {
        onTripUnavailable: () => {
          throw new Error('navigation observer failed');
        },
      },
    );

    expect(outcome).toMatchObject({
      status: 'unattempted',
      interruption: 'tripUnavailable',
    });
  });

  it('keeps native resolve committed across background and cleans the fenced file', async () => {
    const harness = await createPrimitiveHarness();
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<void>();
    harness.library = createLibrary(
      jest.fn<Promise<void>, [string]>(() => {
        nativeStarted.resolve();
        return nativeResult.promise;
      }),
    );
    const pending = saveOneTripPhoto({
      tripId: 'trip-1',
      photoId: 'photo-1',
      captured: harness.captured,
      tripScope: harness.scope,
      coordinator: harness.coordinator,
      run: harness.run,
      library: harness.library,
      gate: harness.gate,
      transport: createFakeTransport(() => imageResponse([bytes(4)]).response),
    });
    await nativeStarted.promise;

    harness.coordinator.suspend('background');
    nativeResult.resolve();
    const outcome = await pending;
    harness.run.release();

    expect(outcome).toEqual({ status: 'committed' });
    expect(harness.store.contents().size).toBe(0);
  });

  it.each(['reject', 'throw'] as const)(
    'classifies native %s as unknown and never retryable',
    async (mode) => {
      const harness = await createPrimitiveHarness();
      const createAsset = jest.fn<Promise<void>, [string]>(() => {
        if (mode === 'throw') throw new Error('native threw');
        return Promise.reject(new Error('native rejected'));
      });
      harness.library = createLibrary(createAsset);

      const outcome = await runPrimitive(
        harness,
        createFakeTransport(() => imageResponse([bytes(4)]).response),
      );

      expect(outcome).toMatchObject({
        status: 'unknown',
        failure: { message: expect.stringContaining('Check Photos') },
      });
      expect(harness.store.contents().size).toBe(0);
    },
  );

  it('does not relabel committed when fence cleanup throws synchronously', async () => {
    const harness = await createPrimitiveHarness();
    const beginCommit = harness.coordinator.beginCommit.bind(harness.coordinator);
    harness.coordinator.beginCommit = (uri, ticket) => {
      const fence = beginCommit(uri, ticket);
      return {
        settleAndDiscard: () => {
          void fence.settleAndDiscard();
          throw new Error('cleanup failed');
        },
      };
    };

    const outcome = await runPrimitive(
      harness,
      createFakeTransport(() => imageResponse([bytes(4)]).response),
    );
    await flushMicrotasks();

    expect(outcome).toEqual({ status: 'committed' });
    expect(harness.store.contents().size).toBe(0);
  });
});

describe('saveTripPhotoToLibrary', () => {
  it.each([
    ['denied', true],
    ['restricted', false],
  ])('returns %s permission with zero run/network/temp/native work', async (status, canAskAgain) => {
    const authTicket = await activateAuth();
    const scope = createTripScope();
    const store = createFakeFileStore('single-permission');
    const coordinator = createPhotoSaveTempCoordinator(store);
    coordinator.activateSession(authTicket.sessionGeneration, true);
    const createAsset = jest.fn<Promise<void>, [string]>(async () => undefined);
    const savePhoto = jest.fn<
      Promise<PhotoSaveItemOutcome>,
      [Parameters<typeof saveOneTripPhoto>[0]]
    >();
    const beginRun = jest.spyOn(coordinator, 'beginRun');

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library: createLibrary(createAsset, async () => ({
        granted: false,
        canAskAgain,
        status,
      })),
      actionLock: createPhotoSaveActionLock(),
      savePhoto,
    });

    expect(outcome).toEqual({ status: 'permissionDenied', canAskAgain });
    expect(beginRun).not.toHaveBeenCalled();
    expect(savePhoto).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
    expect(store.createdFileNames()).toHaveLength(0);
  });

  it('uses one synchronous action lock for rapid taps and delegates to the shared primitive', async () => {
    const authTicket = await activateAuth();
    const scope = createTripScope();
    const coordinator = createPhotoSaveTempCoordinator(
      createFakeFileStore('single-lock'),
    );
    coordinator.activateSession(authTicket.sessionGeneration, true);
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    const requestPermission = jest.fn(() => permission.promise);
    const savePhoto = jest.fn<
      Promise<PhotoSaveItemOutcome>,
      [Parameters<typeof saveOneTripPhoto>[0]]
    >(async () => ({ status: 'committed' }));
    const lock = createPhotoSaveActionLock();
    const onTripUnavailable = jest.fn();
    const options = {
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library: createLibrary(
        jest.fn<Promise<void>, [string]>(async () => undefined),
        requestPermission,
      ),
      actionLock: lock,
      savePhoto,
      onTripUnavailable,
    };

    const first = saveTripPhotoToLibrary(options);
    const second = saveTripPhotoToLibrary(options);
    expect(await second).toEqual({ status: 'busy' });
    expect(requestPermission).toHaveBeenCalledTimes(1);

    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });
    await expect(first).resolves.toEqual({ status: 'saved' });
    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(savePhoto.mock.calls[0][0]).toMatchObject({
      tripId: 'trip-1',
      photoId: 'photo-1',
      onTripUnavailable,
    });
  });

  it('re-checks user gates after permission and starts no run when they close', async () => {
    const authTicket = await activateAuth();
    const scope = createTripScope();
    const coordinator = createPhotoSaveTempCoordinator(
      createFakeFileStore('single-gate'),
    );
    coordinator.activateSession(authTicket.sessionGeneration, true);
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    const gateState = { open: true };
    const beginRun = jest.spyOn(coordinator, 'beginRun');
    const savePhoto = jest.fn<
      Promise<PhotoSaveItemOutcome>,
      [Parameters<typeof saveOneTripPhoto>[0]]
    >();
    const pending = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library: createLibrary(
        jest.fn<Promise<void>, [string]>(async () => undefined),
        () => permission.promise,
      ),
      actionLock: createPhotoSaveActionLock(),
      gate: {
        isOpen: () => gateState.open,
        isTombstoned: () => false,
        interruption: () => 'cancelled',
      },
      savePhoto,
    });

    gateState.open = false;
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(beginRun).not.toHaveBeenCalled();
    expect(savePhoto).not.toHaveBeenCalled();
  });

  it('releases the run and current file after a pre-native failure', async () => {
    const authTicket = await activateAuth();
    await startPrivateMediaSession();
    const scope = createTripScope();
    const store = createFakeFileStore('single-release');
    const coordinator = createPhotoSaveTempCoordinator(store);
    coordinator.activateSession(authTicket.sessionGeneration, true);
    const library = createLibrary();
    const lock = createPhotoSaveActionLock();

    const first = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library,
      actionLock: lock,
      transport: createFakeTransport(() =>
        createFakeResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          chunks: [bytes(4)],
        }).response,
      ),
    });
    const second = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library,
      actionLock: lock,
      transport: createFakeTransport(() => imageResponse([bytes(4)]).response),
    });

    expect(first).toMatchObject({ status: 'failed' });
    expect(second).toEqual({ status: 'saved' });
    expect(store.contents().size).toBe(0);
  });

  it('never adopts Session B when Session A closes during the permission prompt', async () => {
    const authA = await activateAuth('access-a');
    const scope = createTripScope();
    const store = createFakeFileStore('single-session-fence');
    const coordinator = createPhotoSaveTempCoordinator(store);
    coordinator.activateSession(authA.sessionGeneration, true);
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    const savePhoto = jest.fn<
      Promise<PhotoSaveItemOutcome>,
      [Parameters<typeof saveOneTripPhoto>[0]]
    >();
    const beginRun = jest.spyOn(coordinator, 'beginRun');
    const pending = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: scope,
      coordinator,
      library: createLibrary(
        jest.fn<Promise<void>, [string]>(async () => undefined),
        () => permission.promise,
      ),
      actionLock: createPhotoSaveActionLock(),
      savePhoto,
    });

    coordinator.suspend('signOut');
    await requestAuthSessionClose('user');
    const authB = await activateAuth('access-b');
    coordinator.activateSession(authB.sessionGeneration, true);
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(beginRun).not.toHaveBeenCalled();
    expect(savePhoto).not.toHaveBeenCalled();
    expect(store.createdFileNames()).toHaveLength(0);
  });
});
