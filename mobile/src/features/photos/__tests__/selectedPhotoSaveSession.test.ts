/* eslint-disable import/first -- Jest mocks must install before native-backed imports. */
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
  type PhotoSaveTempCoordinator,
} from '@/shared/media/photoSaveTempStore';
import { createDeferred, createFakeFileStore, flushMicrotasks } from '@test/fakeProtectedTransport';
import {
  capturePhotoSaveTickets,
  createPhotoSaveActionLock,
  saveOneTripPhoto,
  saveTripPhotoToLibrary,
} from '../photoSave';
import type {
  PhotoLibraryAdapter,
  PhotoSaveInterruption,
  PhotoSaveItemOutcome,
  PhotoSaveLedgerStatus,
  SaveOneTripPhotoOptions,
} from '../photoSaveTypes';
import {
  createSelectedPhotoSaveSession,
  type SelectedPhotoSaveSession,
} from '../selectedPhotoSaveSession';
import type { TripPhotoScope, TripPhotoScopeTicket } from '../hooks/useTripPhotoScope';
/* eslint-enable import/first */

interface MutableTripScope extends TripPhotoScope {
  invalidate(nextTripId?: string): Promise<void>;
}

interface SessionHarness {
  authTicket: AuthTicket;
  scope: MutableTripScope;
  coordinator: PhotoSaveTempCoordinator;
  requestPermission: jest.Mock<ReturnType<PhotoLibraryAdapter['requestAddOnlyPermission']>, []>;
  createAsset: jest.Mock<Promise<void>, [string]>;
  library: PhotoLibraryAdapter;
}

type SavePhotoMock = jest.MockedFunction<typeof saveOneTripPhoto>;

const sessions: SelectedPhotoSaveSession[] = [];

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

async function createHarness(): Promise<SessionHarness> {
  const authTicket = await activateAuth();
  const scope = createTripScope();
  const coordinator = createPhotoSaveTempCoordinator(
    createFakeFileStore('selected-save-test'),
  );
  coordinator.activateSession(authTicket.sessionGeneration, true);
  const requestPermission = jest.fn(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  }));
  const createAsset = jest.fn<Promise<void>, [string]>(async () => undefined);
  return {
    authTicket,
    scope,
    coordinator,
    requestPermission,
    createAsset,
    library: { requestAddOnlyPermission: requestPermission, createAsset },
  };
}

function createSavePhoto(
  implementation: (options: SaveOneTripPhotoOptions) => Promise<PhotoSaveItemOutcome>,
): SavePhotoMock {
  return jest.fn(implementation);
}

function createSession(
  harness: SessionHarness,
  photoIds: readonly string[],
  savePhoto: SavePhotoMock,
  overrides: Partial<Parameters<typeof createSelectedPhotoSaveSession>[0]> = {},
): SelectedPhotoSaveSession {
  const session = createSelectedPhotoSaveSession({
    tripId: 'trip-1',
    photoIds,
    tripScope: harness.scope,
    coordinator: harness.coordinator,
    library: harness.library,
    actionLock: createPhotoSaveActionLock(),
    savePhoto,
    ...overrides,
  });
  sessions.push(session);
  return session;
}

function failureOutcome(
  status: 'retryableFailed' | 'unknown',
  kind: 'auth' | 'notFound' | 'throttled' | 'request' | 'network' | 'server',
  message: string,
): PhotoSaveItemOutcome {
  return { status, failure: { kind, message } };
}

beforeEach(() => {
  sessions.length = 0;
  jest.clearAllMocks();
  __resetAuthSessionLifecycleForTests();
});

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close('cancelled')));
  __resetAuthSessionLifecycleForTests();
});

describe('selected save worklist and runner ownership', () => {
  it('freezes ordered de-duplicated IDs and caps work at 100', async () => {
    const harness = await createHarness();
    const photoIds = ['photo-2', 'photo-1', 'photo-2', ...Array.from(
      { length: 105 },
      (_, index) => `photo-${index + 3}`,
    )];
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, photoIds, savePhoto);

    await session.start();

    const calledIds = savePhoto.mock.calls.map(([options]) => options.photoId);
    expect(calledIds).toHaveLength(100);
    expect(calledIds.slice(0, 4)).toEqual(['photo-2', 'photo-1', 'photo-3', 'photo-4']);
    expect(new Set(calledIds).size).toBe(100);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'completed',
      total: 100,
      counts: { committed: 100, unattempted: 0 },
    });
  });

  it.each([2, 20, 60, 100])(
    'processes %i photos with peak primitive concurrency one',
    async (count) => {
      const harness = await createHarness();
      let active = 0;
      let peak = 0;
      const savePhoto = createSavePhoto(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { status: 'committed' };
      });
      const session = createSession(
        harness,
        Array.from({ length: count }, (_, index) => `photo-${index + 1}`),
        savePhoto,
      );

      await session.start();

      expect(savePhoto).toHaveBeenCalledTimes(count);
      expect(peak).toBe(1);
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot().counts.committed).toBe(count);
    },
  );

  it('returns one runner promise for rapid Start taps and prompts once', async () => {
    const harness = await createHarness();
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    harness.requestPermission.mockImplementation(() => permission.promise);
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, ['photo-1'], savePhoto);

    const first = session.start();
    const second = session.start();

    expect(second).toBe(first);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });
    await first;
    expect(savePhoto).toHaveBeenCalledTimes(1);
  });

  it('shares one rapid-tap lock across single and selected save surfaces', async () => {
    const harness = await createHarness();
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    harness.requestPermission.mockImplementation(() => permission.promise);
    const lock = createPhotoSaveActionLock();
    const singlePrimitive = createSavePhoto(async () => ({ status: 'committed' }));
    const selectedPrimitive = createSavePhoto(async () => ({ status: 'committed' }));
    const selected = createSession(
      harness,
      ['photo-2'],
      selectedPrimitive,
      { actionLock: lock },
    );

    const single = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      tripScope: harness.scope,
      coordinator: harness.coordinator,
      library: harness.library,
      actionLock: lock,
      savePhoto: singlePrimitive,
    });
    await selected.start();

    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(selectedPrimitive).not.toHaveBeenCalled();
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });
    await expect(single).resolves.toEqual({ status: 'saved' });
    expect(singlePrimitive).toHaveBeenCalledTimes(1);

    await selected.start();
    expect(harness.requestPermission).toHaveBeenCalledTimes(2);
    expect(selectedPrimitive).toHaveBeenCalledTimes(1);
  });

  it('requests permission once for the whole session across explicit retry', async () => {
    const harness = await createHarness();
    let attempt = 0;
    const savePhoto = createSavePhoto(async () => {
      attempt += 1;
      return attempt === 1
        ? failureOutcome('retryableFailed', 'network', 'Offline.')
        : { status: 'committed' };
    });
    const session = createSession(harness, ['photo-1'], savePhoto);

    await session.start();
    expect(session.getSnapshot().counts.retryableFailed).toBe(1);
    await session.start();

    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(savePhoto).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().counts.committed).toBe(1);
  });

  it('retries only retryable/unattempted entries and never replays committed work', async () => {
    const harness = await createHarness();
    let photo2Attempts = 0;
    const savePhoto = createSavePhoto(async (options) => {
      if (options.photoId === 'photo-2') {
        photo2Attempts += 1;
        if (photo2Attempts === 1) {
          return failureOutcome('retryableFailed', 'network', 'Offline.');
        }
      }
      if (options.photoId === 'photo-3') {
        return {
          status: 'terminalSkipped',
          failure: { kind: 'notFound', message: 'Gone.' },
        };
      }
      return { status: 'committed' };
    });
    const session = createSession(
      harness,
      ['photo-1', 'photo-2', 'photo-3', 'photo-4'],
      savePhoto,
    );

    await session.start();
    await session.start();

    expect(savePhoto.mock.calls.map(([options]) => options.photoId)).toEqual([
      'photo-1',
      'photo-2',
      'photo-2',
      'photo-3',
      'photo-4',
    ]);
    expect(session.getSnapshot().counts).toMatchObject({
      committed: 3,
      terminalSkipped: 1,
      retryableFailed: 0,
      unattempted: 0,
    });
  });

  it('never retries an unknown native outcome', async () => {
    const harness = await createHarness();
    const savePhoto = createSavePhoto(async () =>
      failureOutcome('unknown', 'server', 'Check Photos.'),
    );
    const session = createSession(harness, ['photo-1'], savePhoto);

    await session.start();
    await session.start();

    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().counts.unknown).toBe(1);
  });

  it.each<[string, boolean]>([
    ['denied', true],
    ['restricted', false],
  ])('does zero primitive work when permission is %s', async (status, canAskAgain) => {
    const harness = await createHarness();
    harness.requestPermission.mockResolvedValue({
      granted: false,
      canAskAgain,
      status,
    });
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);

    await session.start();
    await session.start();

    expect(savePhoto).not.toHaveBeenCalled();
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'completed',
      permissionDenied: { canAskAgain },
      counts: { unattempted: 2 },
    });
  });
});

describe('selected save ticket fences', () => {
  it('cannot adopt Session B when construction receives a pre-captured Session A action', async () => {
    const harness = await createHarness();
    const initialCaptured = capturePhotoSaveTickets(
      harness.scope,
      harness.coordinator,
    );
    if (!initialCaptured) throw new Error('Expected Session A tickets.');

    await requestAuthSessionClose('user');
    const authB = await activateAuth('access-b');
    harness.coordinator.activateSession(authB.sessionGeneration, true);
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, ['photo-1'], savePhoto, {
      initialCaptured,
    });

    await session.start();

    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(savePhoto).not.toHaveBeenCalled();
    expect(session.getSnapshot().counts.unattempted).toBe(1);
  });

  it('does zero work when pending permission crosses a trip generation', async () => {
    const harness = await createHarness();
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    harness.requestPermission.mockImplementation(() => permission.promise);
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, ['photo-1'], savePhoto);

    const pending = session.start();
    const cleanup = harness.scope.invalidate('trip-2');
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });
    await Promise.all([pending, cleanup]);

    expect(savePhoto).not.toHaveBeenCalled();
    expect(session.getSnapshot().counts.unattempted).toBe(1);
  });

  it('uses a fresh store ticket on Resume only while original auth/trip stay current', async () => {
    const harness = await createHarness();
    const initialCaptured = capturePhotoSaveTickets(
      harness.scope,
      harness.coordinator,
    );
    if (!initialCaptured) throw new Error('Expected initial tickets.');
    const started = createDeferred<void>();
    const storeGenerations: number[] = [];
    let call = 0;
    const savePhoto = createSavePhoto(async (options) => {
      call += 1;
      storeGenerations.push(options.captured.store.storeGeneration);
      if (call > 1) return { status: 'committed' };
      started.resolve();
      return new Promise<PhotoSaveItemOutcome>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => resolve({ status: 'unattempted', interruption: 'background' }),
          { once: true },
        );
      });
    });
    const session = createSession(harness, ['photo-1'], savePhoto, {
      initialCaptured,
    });
    const first = session.start();
    await started.promise;
    session.pause();
    await first;

    harness.coordinator.suspend('background');
    harness.coordinator.resume(harness.authTicket.sessionGeneration);
    await session.start();

    expect(storeGenerations).toHaveLength(2);
    expect(storeGenerations[1]).toBeGreaterThan(storeGenerations[0]);
    expect(session.getSnapshot().counts.committed).toBe(1);
  });

  it('does zero work and cannot adopt Session B after auth A closes during permission', async () => {
    const harness = await createHarness();
    const permission = createDeferred<{
      granted: boolean;
      canAskAgain: boolean;
      status: string;
    }>();
    harness.requestPermission.mockImplementation(() => permission.promise);
    const savePhoto = createSavePhoto(async () => ({ status: 'committed' }));
    const session = createSession(harness, ['photo-1'], savePhoto);
    const pending = session.start();

    await requestAuthSessionClose('user');
    const authB = await activateAuth('access-b');
    harness.coordinator.activateSession(authB.sessionGeneration, true);
    permission.resolve({ granted: true, canAskAgain: true, status: 'granted' });
    await pending;

    expect(savePhoto).not.toHaveBeenCalled();
    expect(session.getSnapshot().counts.unattempted).toBe(1);
  });
});

describe('selected save tombstones', () => {
  it('continues after PHOTO_NOT_FOUND and records the unavailable item', async () => {
    const harness = await createHarness();
    const onTombstone = jest.fn();
    const savePhoto = createSavePhoto(async (options) => {
      if (options.photoId === 'photo-2') {
        options.onTombstone?.(options.photoId);
        return {
          status: 'terminalSkipped',
          failure: {
            kind: 'notFound',
            message: 'Gone.',
            status: 404,
            errorCode: 'PHOTO_NOT_FOUND',
          },
        };
      }
      return { status: 'committed' };
    });
    const session = createSession(
      harness,
      ['photo-1', 'photo-2', 'photo-3'],
      savePhoto,
      { onTombstone },
    );

    await session.start();

    expect(savePhoto.mock.calls.map(([options]) => options.photoId)).toEqual([
      'photo-1',
      'photo-2',
      'photo-3',
    ]);
    expect(onTombstone).toHaveBeenCalledWith('photo-2');
    expect(session.getSnapshot().counts).toMatchObject({
      committed: 2,
      terminalSkipped: 1,
      unattempted: 0,
    });
  });

  it('skips an externally tombstoned queued item and continues in order', async () => {
    const harness = await createHarness();
    const firstStarted = createDeferred<void>();
    const firstResult = createDeferred<PhotoSaveItemOutcome>();
    const savePhoto = createSavePhoto(async (options) => {
      if (options.photoId === 'photo-1') {
        firstStarted.resolve();
        return firstResult.promise;
      }
      return { status: 'committed' };
    });
    const session = createSession(
      harness,
      ['photo-1', 'photo-2', 'photo-3'],
      savePhoto,
    );
    const pending = session.start();
    await firstStarted.promise;

    session.markUnavailable('photo-2');
    firstResult.resolve({ status: 'committed' });
    await pending;

    expect(savePhoto.mock.calls.map(([options]) => options.photoId)).toEqual([
      'photo-1',
      'photo-3',
    ]);
    expect(session.getSnapshot().counts).toMatchObject({
      committed: 2,
      terminalSkipped: 1,
    });
  });

  it('lets a current pre-native tombstone win a late abort result and continues', async () => {
    const harness = await createHarness();
    const currentStarted = createDeferred<void>();
    const savePhoto = createSavePhoto(async (options) => {
      if (options.photoId !== 'photo-1') return { status: 'committed' };
      options.onStage?.('downloading');
      currentStarted.resolve();
      return new Promise<PhotoSaveItemOutcome>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => resolve({ status: 'unattempted', interruption: 'cancelled' }),
          { once: true },
        );
      });
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const pending = session.start();
    await currentStarted.promise;

    session.markUnavailable('photo-1');
    await pending;

    expect(savePhoto.mock.calls.map(([options]) => options.photoId)).toEqual([
      'photo-1',
      'photo-2',
    ]);
    expect(session.getSnapshot().counts).toMatchObject({
      committed: 1,
      terminalSkipped: 1,
      unattempted: 0,
    });
  });

  it('reads the synchronous authoritative feed at the item commit gate', async () => {
    const harness = await createHarness();
    const unavailable = new Set<string>();
    const savePhoto = createSavePhoto(async (options) => {
      expect(options.gate.isTombstoned(options.photoId)).toBe(false);
      unavailable.add(options.photoId);
      // This assertion happens in the same turn: no React tombstone Set or
      // passive effect has had a chance to render.
      expect(options.gate.isTombstoned(options.photoId)).toBe(true);
      return {
        status: 'terminalSkipped',
        failure: {
          kind: 'notFound',
          message: 'Photo is unavailable.',
          status: 404,
          errorCode: 'PHOTO_NOT_FOUND',
        },
      };
    });
    const session = createSession(harness, ['photo-1'], savePhoto, {
      isPhotoUnavailable: (photoId) => unavailable.has(photoId),
    });

    await session.start();

    expect(session.getSnapshot().counts).toMatchObject({
      terminalSkipped: 1,
      unattempted: 0,
    });
  });

  it.each<[string, PhotoSaveItemOutcome]>([
    ['committed', { status: 'committed' } as const],
    [
      'unknown',
      failureOutcome('unknown', 'server', 'May already be saved.'),
    ],
  ])('lets the actual %s result win an external native-boundary tombstone', async (_label, result) => {
    const harness = await createHarness();
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<PhotoSaveItemOutcome>();
    const savePhoto = createSavePhoto(async (options) => {
      options.onStage?.('saving');
      options.onCommitStarted?.();
      nativeStarted.resolve();
      return nativeResult.promise;
    });
    const session = createSession(harness, ['photo-1'], savePhoto);
    const pending = session.start();
    await nativeStarted.promise;

    session.markUnavailable('photo-1');
    nativeResult.resolve(result);
    await pending;

    expect(session.getSnapshot().ledger[0].status).toBe(result.status);
    expect(session.getSnapshot().counts.terminalSkipped).toBe(0);
  });
});

describe('selected save cancellation and background behavior', () => {
  function abortableDownload(
    started: ReturnType<typeof createDeferred<void>>,
  ): SavePhotoMock {
    return createSavePhoto(async (options) => {
      options.onStage?.('downloading');
      started.resolve();
      return new Promise<PhotoSaveItemOutcome>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => resolve({
            status: 'unattempted',
            interruption: options.gate.interruption(),
          }),
          { once: true },
        );
      });
    });
  }

  it('stops during download and leaves current/rest unattempted', async () => {
    const harness = await createHarness();
    const started = createDeferred<void>();
    const savePhoto = abortableDownload(started);
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const pending = session.start();
    await started.promise;

    session.stop();
    await pending;

    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'completed',
      counts: { committed: 0, unattempted: 2 },
    });
  });

  it('records native success before stopping and never schedules the next item', async () => {
    const harness = await createHarness();
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<void>();
    const savePhoto = createSavePhoto(async (options) => {
      options.onStage?.('saving');
      options.onCommitStarted?.();
      nativeStarted.resolve();
      await nativeResult.promise;
      return { status: 'committed' };
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const pending = session.start();
    await nativeStarted.promise;

    session.stop();
    nativeResult.resolve();
    await pending;

    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'completed',
      counts: { committed: 1, unattempted: 1 },
    });
  });

  it('pauses in background, does not auto-resume, then uses one explicit runner', async () => {
    const harness = await createHarness();
    const started = createDeferred<void>();
    let call = 0;
    const savePhoto = createSavePhoto(async (options) => {
      call += 1;
      if (call > 1) return { status: 'committed' };
      options.onStage?.('downloading');
      started.resolve();
      return new Promise<PhotoSaveItemOutcome>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => resolve({ status: 'unattempted', interruption: 'background' }),
          { once: true },
        );
      });
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const pending = session.start();
    await started.promise;

    session.pause();
    await pending;
    expect(session.getSnapshot().phase).toBe('paused');
    await flushMicrotasks();
    expect(savePhoto).toHaveBeenCalledTimes(1);

    await session.start();
    expect(savePhoto).toHaveBeenCalledTimes(3);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().counts.committed).toBe(2);
  });

  it('does not duplicate a runner when background/foreground crosses pending native work', async () => {
    const harness = await createHarness();
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<void>();
    const savePhoto = createSavePhoto(async (options) => {
      if (options.photoId === 'photo-1') {
        options.onCommitStarted?.();
        nativeStarted.resolve();
        await nativeResult.promise;
      }
      return { status: 'committed' };
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const first = session.start();
    await nativeStarted.promise;

    session.pause();
    const attemptedForegroundStart = session.start();
    expect(attemptedForegroundStart).toBe(first);
    expect(savePhoto).toHaveBeenCalledTimes(1);
    nativeResult.resolve();
    await first;
    expect(session.getSnapshot().phase).toBe('paused');

    await session.start();
    expect(savePhoto.mock.calls.map(([options]) => options.photoId)).toEqual([
      'photo-1',
      'photo-2',
    ]);
  });

  it.each<[string, PhotoSaveItemOutcome, PhotoSaveLedgerStatus]>([
    [
      '401/auth close',
      { status: 'unattempted', interruption: 'signOut' as const, failure: {
        kind: 'auth' as const,
        message: 'Session expired.',
      } },
      'unattempted',
    ],
    [
      'trip loss',
      { status: 'unattempted', interruption: 'tripUnavailable' as const, failure: {
        kind: 'notFound' as const,
        message: 'Trip gone.',
      } },
      'unattempted',
    ],
    ['malformed 404', failureOutcome('retryableFailed', 'notFound', 'Missing.'), 'retryableFailed'],
    ['429', failureOutcome('retryableFailed', 'throttled', 'Wait.'), 'retryableFailed'],
    ['low storage', failureOutcome('retryableFailed', 'request', 'Low storage.'), 'retryableFailed'],
    ['network', failureOutcome('retryableFailed', 'network', 'Offline.'), 'retryableFailed'],
    ['5xx', failureOutcome('retryableFailed', 'server', 'Server error.'), 'retryableFailed'],
    ['native rejection', failureOutcome('unknown', 'server', 'Check Photos.'), 'unknown'],
  ])('stops the queue after %s with an honest ledger', async (_label, outcome, status) => {
    const harness = await createHarness();
    const savePhoto = createSavePhoto(async () => outcome);
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);

    await session.start();

    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().ledger.map((entry) => entry.status)).toEqual([
      status,
      'unattempted',
    ]);
  });

  it.each(['signOut', 'tripUnavailable', 'tripChanged'] as const)(
    'permanently closes after terminal %s so a second Start does zero work',
    async (interruption) => {
      const harness = await createHarness();
      const onTripUnavailable = jest.fn();
      const tripFailure = {
        kind: 'notFound' as const,
        message: 'Trip not found.',
        status: 404,
        errorCode: 'TRIP_NOT_FOUND',
      };
      const savePhoto = createSavePhoto(async (options) => {
        if (interruption === 'tripUnavailable') {
          options.onTripUnavailable?.(tripFailure);
          return {
            status: 'unattempted',
            interruption,
            failure: tripFailure,
          };
        }
        return { status: 'unattempted', interruption };
      });
      const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto, {
        onTripUnavailable,
      });

      await session.start();
      await session.start();

      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(savePhoto).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toMatchObject({
        phase: 'completed',
        counts: { unattempted: 2 },
      });
      expect(onTripUnavailable).toHaveBeenCalledTimes(
        interruption === 'tripUnavailable' ? 1 : 0,
      );
    },
  );

  it('forwards trip-unavailable evidence to the owning neutral-trip flow', async () => {
    const harness = await createHarness();
    const onTripUnavailable = jest.fn();
    const failure = {
      kind: 'notFound' as const,
      message: 'Trip not found.',
      status: 404,
      errorCode: 'TRIP_NOT_FOUND',
    };
    const savePhoto = createSavePhoto(async (options) => {
      options.onTripUnavailable?.(failure);
      return {
        status: 'unattempted',
        interruption: 'tripUnavailable',
        failure,
      };
    });
    const session = createSession(harness, ['photo-1'], savePhoto, {
      onTripUnavailable,
    });

    await session.start();
    await session.start();

    expect(onTripUnavailable).toHaveBeenCalledWith(failure);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().ledger[0].status).toBe('unattempted');
  });

  it.each([
    ['before native', false, 'retryableFailed'],
    ['after native starts', true, 'unknown'],
  ])('contains an unexpected primitive throw %s', async (_label, commitStarted, status) => {
    const harness = await createHarness();
    const savePhoto = createSavePhoto(async (options) => {
      if (commitStarted) options.onCommitStarted?.();
      throw new Error('unexpected primitive failure');
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);

    await expect(session.start()).resolves.toBeUndefined();

    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().ledger.map((entry) => entry.status)).toEqual([
      status,
      'unattempted',
    ]);
  });

  it.each<[string, PhotoSaveItemOutcome]>([
    ['committed', { status: 'committed' }],
    [
      'unknown',
      failureOutcome('unknown', 'server', 'Check Photos.'),
    ],
  ])('waits for native %s during terminal close and never retries it', async (_label, result) => {
    const harness = await createHarness();
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<PhotoSaveItemOutcome>();
    const savePhoto = createSavePhoto(async (options) => {
      options.onCommitStarted?.();
      nativeStarted.resolve();
      return nativeResult.promise;
    });
    const session = createSession(harness, ['photo-1', 'photo-2'], savePhoto);
    const running = session.start();
    await nativeStarted.promise;

    let closeSettled = false;
    const closing = session.close('tripChanged').then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();
    expect(closeSettled).toBe(false);

    nativeResult.resolve(result);
    await Promise.all([running, closing]);
    await session.start();

    expect(session.getSnapshot().ledger.map((entry) => entry.status)).toEqual([
      result.status,
      'unattempted',
    ]);
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(savePhoto).toHaveBeenCalledTimes(1);
  });
});

describe('selected save interruption reporting', () => {
  it.each<PhotoSaveInterruption>([
    'cancelled',
    'background',
    'signOut',
    'tripChanged',
    'tripUnavailable',
  ])('preserves an explicit %s close reason for the active gate', async (reason) => {
    const harness = await createHarness();
    const started = createDeferred<void>();
    let observed: PhotoSaveInterruption | null = null;
    const savePhoto = createSavePhoto(async (options) => {
      started.resolve();
      return new Promise<PhotoSaveItemOutcome>((resolve) => {
        options.signal?.addEventListener('abort', () => {
          observed = options.gate.interruption();
          resolve({ status: 'unattempted', interruption: observed });
        }, { once: true });
      });
    });
    const session = createSession(harness, ['photo-1'], savePhoto);
    const running = session.start();
    await started.promise;

    const closing = session.close(reason);
    await Promise.all([running, closing]);

    expect(observed).toBe(reason);
  });
});
