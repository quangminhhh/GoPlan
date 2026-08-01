import { act, renderHook } from '@testing-library/react-native';
import { PHOTO_SAVE_SELECTION_MAX } from '../constants';
import { createDeferred } from '@test/fakeProtectedTransport';
import { createPhotoSaveActionLock } from '../photoSave';
import { usePhotoSelection } from '../hooks/usePhotoSelection';
import type {
  CreateSelectedPhotoSaveSessionOptions,
  SelectedPhotoSaveSession,
  SelectedSaveSnapshot,
} from '../selectedPhotoSaveSession';
import type { TripPhotoScope, TripPhotoScopeTicket } from '../hooks/useTripPhotoScope';
import type { TripPhoto } from '../types';

function photo(id: string): TripPhoto {
  return {
    id,
    created_at: '2026-07-31T10:00:00Z',
    uploaded_by: { id: 'u1', display_name: 'Mai', identify_tag: 'mai', avatar_url: null },
    width: 4032,
    height: 3024,
    thumbnail_width: 480,
    thumbnail_height: 360,
    medium_width: 2560,
    medium_height: 1920,
    can_delete: true,
  };
}

function createScope(tripId = 'trip-1'): TripPhotoScope & { invalidate(nextTripId: string): void } {
  let ticket: TripPhotoScopeTicket = { tripId, generation: 0 };
  const listeners = new Set<Parameters<TripPhotoScope['subscribeInvalidation']>[0]>();
  return {
    capture: () => ticket,
    isCurrent: (candidate) =>
      candidate.tripId === ticket.tripId && candidate.generation === ticket.generation,
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForCleanup: async () => undefined,
    invalidate: (nextTripId) => {
      const previous = ticket;
      ticket = { tripId: nextTripId, generation: ticket.generation + 1 };
      for (const listener of listeners) void listener(previous, ticket);
    },
  };
}

function snapshot(overrides: Partial<SelectedSaveSnapshot> = {}): SelectedSaveSnapshot {
  return {
    phase: 'idle',
    stage: null,
    total: 0,
    currentOrdinal: null,
    counts: {
      committed: 0,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 0,
      unattempted: 0,
    },
    ledger: [],
    failure: null,
    permissionDenied: null,
    ...overrides,
  };
}

function fakeSessionFactory(finalSnapshot: SelectedSaveSnapshot) {
  const sessions: SelectedPhotoSaveSession[] = [];
  const optionsSeen: CreateSelectedPhotoSaveSessionOptions[] = [];
  const createSession = jest.fn((options: CreateSelectedPhotoSaveSessionOptions) => {
    let current = snapshot({
      total: options.photoIds.length,
      counts: {
        committed: 0,
        terminalSkipped: 0,
        retryableFailed: 0,
        unknown: 0,
        unattempted: options.photoIds.length,
      },
      ledger: options.photoIds.map((photoId) => ({ photoId, status: 'unattempted' as const })),
    });
    const session: SelectedPhotoSaveSession = {
      getSnapshot: () => current,
      start: jest.fn(async () => {
        current = finalSnapshot;
        options.onSnapshot?.(current);
      }),
      pause: jest.fn(),
      stop: jest.fn(),
      markUnavailable: jest.fn(),
      close: jest.fn(async () => undefined),
    };
    sessions.push(session);
    optionsSeen.push(options);
    options.onSnapshot?.(current);
    return session;
  });
  return { createSession, sessions, optionsSeen };
}

function options(overrides: Record<string, unknown> = {}) {
  const scope = createScope();
  const captured = {
    auth: { sessionGeneration: 1, credentialRevision: 0 },
    trip: scope.capture(),
    store: { storeGeneration: 1, authGeneration: 1 },
    runId: Symbol('selection-test-run'),
  };
  return {
    tripId: 'trip-1',
    photos: [photo('p1'), photo('p2'), photo('p3')],
    tombstonedPhotoIds: new Set<string>(),
    isPhotoTombstoned: jest.fn(() => false),
    subscribePhotoTombstones: jest.fn(() => () => undefined),
    scope,
    onTombstone: jest.fn(),
    onTripUnavailable: jest.fn(),
    resolveAmbiguousNotFound: jest.fn(async () => 'unknown' as const),
    captureTickets: jest.fn(() => captured),
    ticketsAreCurrent: jest.fn(() => true),
    ...overrides,
  };
}

function createTombstoneFeed() {
  const ids = new Set<string>();
  const listeners = new Set<(photoId: string) => void>();
  return {
    isPhotoTombstoned: (photoId: string) => ids.has(photoId),
    subscribePhotoTombstones: (listener: (photoId: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(photoId: string): void {
      ids.add(photoId);
      for (const listener of Array.from(listeners)) listener(photoId);
    },
  };
}

it('keeps ordered selection, enforces 100, and adds loaded ids without dropping deep ids', async () => {
  const photos = Array.from({ length: 130 }, (_unused, index) => photo(`p${index}`));
  const { result } = await renderHook(() => usePhotoSelection(options({ photos })));

  await act(async () => {
    result.current.enterSelection('deep-page-id');
    result.current.selectLoaded();
  });

  expect(result.current.selectedIds[0]).toBe('deep-page-id');
  expect(result.current.selectedCount).toBe(PHOTO_SAVE_SELECTION_MAX);
  expect(result.current.selectedIds).toContain('p0');
  expect(result.current.selectedIds).not.toContain('p100');
});

it('removes only authoritative tombstones and never intersects with the current page', async () => {
  const scope = createScope();
  const initial = options({ scope, photos: [photo('p1')] });
  const view = await renderHook(
    ({ tombstones }: { tombstones: ReadonlySet<string> }) =>
      usePhotoSelection({ ...initial, tombstonedPhotoIds: tombstones }),
    { initialProps: { tombstones: new Set<string>() } },
  );

  await act(async () => {
    view.result.current.enterSelection('deep-page-id');
    view.result.current.toggle('p1');
  });
  expect(view.result.current.selectedIds).toEqual(['deep-page-id', 'p1']);

  await view.rerender({ tombstones: new Set(['p1']) });
  expect(view.result.current.selectedIds).toEqual(['deep-page-id']);
});

it('delivers the synchronous tombstone feed to the active session before prop state changes', async () => {
  const feed = createTombstoneFeed();
  const paused = snapshot({
    phase: 'paused',
    total: 2,
    counts: {
      committed: 0,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 0,
      unattempted: 2,
    },
    ledger: [
      { photoId: 'p1', status: 'unattempted' },
      { photoId: 'p2', status: 'unattempted' },
    ],
  });
  const fake = fakeSessionFactory(paused);
  const configured = options({
    ...feed,
    createSession: fake.createSession,
  });
  const view = await renderHook(() => usePhotoSelection(configured));
  await act(async () => {
    view.result.current.enterSelection('p1');
    view.result.current.toggle('p2');
    await view.result.current.startSave();
  });

  await act(async () => {
    feed.emit('p1');
    expect(fake.sessions[0].markUnavailable).toHaveBeenCalledWith('p1');
  });

  expect(view.result.current.selectedIds).toEqual(['p2']);
  expect(fake.optionsSeen[0].isPhotoUnavailable?.('p1')).toBe(true);
});

it('freezes an ordered worklist and coalesces rapid Save taps', async () => {
  const complete = snapshot({
    phase: 'completed',
    total: 2,
    counts: {
      committed: 2,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 0,
      unattempted: 0,
    },
    ledger: [
      { photoId: 'p2', status: 'committed' },
      { photoId: 'p1', status: 'committed' },
    ],
  });
  const fake = fakeSessionFactory(complete);
  const { result } = await renderHook(() =>
    usePhotoSelection(options({ createSession: fake.createSession })),
  );

  await act(async () => {
    result.current.enterSelection('p2');
    result.current.toggle('p1');
  });
  await act(async () => {
    await Promise.all([result.current.startSave(), result.current.startSave()]);
  });

  expect(fake.createSession).toHaveBeenCalledTimes(1);
  expect(fake.optionsSeen[0].photoIds).toEqual(['p2', 'p1']);
  expect(fake.sessions[0].start).toHaveBeenCalledTimes(1);
  expect(result.current.selectionMode).toBe(false);
  expect(result.current.selectedIds).toEqual([]);
  expect(result.current.feedback?.message).toBe('Saved 2 photos to Photos.');
});

it('reserves the global action and cannot adopt auth/store B across an old cleanup tail', async () => {
  const cleanup = createDeferred<void>();
  const scope = createScope();
  scope.waitForCleanup = () => cleanup.promise;
  const actionLock = createPhotoSaveActionLock();
  const fake = fakeSessionFactory(snapshot());
  let ticketsCurrent = true;
  const configured = options({
    scope,
    actionLock,
    createSession: fake.createSession,
    ticketsAreCurrent: jest.fn(() => ticketsCurrent),
  });
  const { result } = await renderHook(() => usePhotoSelection(configured));
  await act(async () => result.current.enterSelection('p1'));

  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.startSave();
    await Promise.resolve();
  });
  expect(fake.createSession).not.toHaveBeenCalled();
  expect(actionLock.tryAcquire()).toBeNull();

  ticketsCurrent = false;
  await act(async () => {
    cleanup.resolve();
    await pending;
  });
  expect(fake.createSession).not.toHaveBeenCalled();
  const release = actionLock.tryAcquire();
  expect(release).not.toBeNull();
  release?.();
});

it('cancels a pending cleanup wait without creating a session or touching native state', async () => {
  const cleanup = createDeferred<void>();
  const scope = createScope();
  scope.waitForCleanup = () => cleanup.promise;
  const actionLock = createPhotoSaveActionLock();
  const fake = fakeSessionFactory(snapshot());
  const configured = options({
    scope,
    actionLock,
    createSession: fake.createSession,
  });
  const { result } = await renderHook(() => usePhotoSelection(configured));
  await act(async () => result.current.enterSelection('p1'));

  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.startSave();
    await Promise.resolve();
  });
  expect(result.current.saveSnapshot?.stage).toBe('preparing');

  await act(async () => result.current.cancelSave());
  expect(result.current.saveSnapshot).toBeNull();
  expect(result.current.selectedIds).toEqual(['p1']);
  expect(result.current.feedback?.message).toBe('Save stopped. 1 not saved.');
  expect(fake.createSession).not.toHaveBeenCalled();
  const releaseAfterCancel = actionLock.tryAcquire();
  expect(releaseAfterCancel).not.toBeNull();
  releaseAfterCancel?.();

  await act(async () => {
    cleanup.resolve();
    await pending;
  });
  expect(fake.createSession).not.toHaveBeenCalled();
});

it('retains only retryable/unattempted ids after a partial result', async () => {
  const partial = snapshot({
    phase: 'completed',
    total: 5,
    counts: {
      committed: 1,
      terminalSkipped: 1,
      retryableFailed: 1,
      unknown: 1,
      unattempted: 1,
    },
    ledger: [
      { photoId: 'committed', status: 'committed' },
      { photoId: 'gone', status: 'terminalSkipped', failure: { kind: 'notFound', message: 'Gone' } },
      { photoId: 'retry', status: 'retryableFailed', failure: { kind: 'network', message: 'Offline' } },
      { photoId: 'unknown', status: 'unknown', failure: { kind: 'server', message: 'Check Photos' } },
      { photoId: 'rest', status: 'unattempted' },
    ],
    failure: { kind: 'network', message: 'Offline' },
  });
  const fake = fakeSessionFactory(partial);
  const { result } = await renderHook(() =>
    usePhotoSelection(options({ createSession: fake.createSession })),
  );

  await act(async () => {
    result.current.enterSelection('committed');
    for (const id of ['gone', 'retry', 'unknown', 'rest']) result.current.toggle(id);
    await result.current.startSave();
  });

  expect(result.current.selectionMode).toBe(true);
  expect(result.current.selectedIds).toEqual(['retry', 'rest']);
  expect(result.current.feedback?.message).toContain('Check Photos');
});

it('keeps an unknown warning detached and exposes no actionable unknown id', async () => {
  const unknown = snapshot({
    phase: 'completed',
    total: 1,
    counts: {
      committed: 0,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 1,
      unattempted: 0,
    },
    ledger: [
      { photoId: 'p1', status: 'unknown', failure: { kind: 'server', message: 'ambiguous' } },
    ],
  });
  const fake = fakeSessionFactory(unknown);
  const { result } = await renderHook(() =>
    usePhotoSelection(options({ createSession: fake.createSession })),
  );
  await act(async () => {
    result.current.enterSelection('p1');
    await result.current.startSave();
  });

  expect(result.current.selectionMode).toBe(false);
  expect(result.current.selectedIds).toEqual([]);
  expect(result.current.feedback?.message).toContain('Check Photos');
});

it('closes stale Trip A work without publishing into Trip B', async () => {
  const scope = createScope();
  const paused = snapshot({ phase: 'paused' });
  const fake = fakeSessionFactory(paused);
  const view = await renderHook(
    ({ tripId }: { tripId: string }) =>
      usePhotoSelection(options({ tripId, scope, createSession: fake.createSession })),
    { initialProps: { tripId: 'trip-1' } },
  );

  await act(async () => {
    view.result.current.enterSelection('p1');
  });
  scope.invalidate('trip-2');
  await view.rerender({ tripId: 'trip-2' });

  expect(view.result.current.selectionMode).toBe(false);
  expect(view.result.current.selectedIds).toEqual([]);
});
