const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) => mockUseFocusEffect(effect),
}));

jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: (listener: () => void) => mockUseAppForegroundEffect(listener),
}));

jest.mock('@/shared/media/protectedAssetStore', () => ({
  invalidateProtectedAsset: jest.fn(async () => undefined),
  invalidateProtectedAssets: jest.fn(async () => undefined),
}));

jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  listTripPhotos: jest.fn(),
}));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AxiosError } from 'axios';
// eslint-disable-next-line import/first
import type { CursorPage } from '@/shared/api/pagination';
// eslint-disable-next-line import/first
import {
  invalidateProtectedAsset,
  invalidateProtectedAssets,
} from '@/shared/media/protectedAssetStore';
// eslint-disable-next-line import/first
import { createDeferred } from '@test/fakeProtectedTransport';
// eslint-disable-next-line import/first
import { listTripPhotos } from '../api';
// eslint-disable-next-line import/first
import { useTripPhotos } from '../hooks/useTripPhotos';
// eslint-disable-next-line import/first
import { useTripPhotoScope } from '../hooks/useTripPhotoScope';
// eslint-disable-next-line import/first
import type { TripPhoto } from '../types';

const mockListTripPhotos = listTripPhotos as jest.MockedFunction<typeof listTripPhotos>;
const mockInvalidateAsset = invalidateProtectedAsset as jest.MockedFunction<
  typeof invalidateProtectedAsset
>;
const mockInvalidateTrip = invalidateProtectedAssets as jest.MockedFunction<
  typeof invalidateProtectedAssets
>;

function useScopedTripPhotos(tripId: string) {
  const scope = useTripPhotoScope(tripId);
  return useTripPhotos(tripId, scope);
}

function useScopedTripPhotosWithOwner(tripId: string) {
  const scope = useTripPhotoScope(tripId);
  return { scope, photos: useTripPhotos(tripId, scope) };
}

function photo(id: string, createdAt = '2026-07-31T10:00:00Z'): TripPhoto {
  return {
    id,
    created_at: createdAt,
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

function page(items: TripPhoto[], nextCursor: string | null = null): CursorPage<TripPhoto> {
  return { items, nextCursor };
}

function notFound(errorCode?: string): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('Not found', 'ERR_BAD_REQUEST', config, {}, {
    status: 404,
    statusText: '',
    headers: {},
    config,
    data: errorCode ? { detail: 'Not found.', error_code: errorCode } : { some_field: ['broken'] },
  });
}

function serverError(): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('Boom', 'ERR_BAD_RESPONSE', config, {}, {
    status: 500,
    statusText: '',
    headers: {},
    config,
    data: { detail: 'Server error.', error_code: 'PHOTO_STORAGE_ERROR' },
  });
}

/** Runs the focus callback the hook registered, the way navigation would. */
async function triggerFocus() {
  const effect = mockUseFocusEffect.mock.calls.at(-1)?.[0] as (() => void) | undefined;
  await act(async () => {
    effect?.();
  });
}

async function triggerForeground() {
  const listener = mockUseAppForegroundEffect.mock.calls.at(-1)?.[0] as (() => void) | undefined;
  await act(async () => {
    listener?.();
  });
}

async function renderReady(first = page([photo('p1'), photo('p2')])) {
  mockListTripPhotos.mockResolvedValueOnce(first);
  const view = await renderHook(() => useScopedTripPhotos('trip-1'));
  await triggerFocus();
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loading and pagination', () => {
  it('loads the first page on first focus and reconciles silently afterwards', async () => {
    const view = await renderReady();

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2']);
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p1')]));
    await triggerFocus();

    // A silent reconcile never shows a spinner or clears what is on screen.
    await waitFor(() => expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1']));
    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.refreshing).toBe(false);
  });

  it('appends the next page and de-duplicates ids the server repeats', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')], 'cursor-1'));

    expect(view.result.current.hasNextPage).toBe(true);
    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2'), photo('p3')], null));
    await act(async () => {
      await view.result.current.loadMore();
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    expect(view.result.current.hasNextPage).toBe(false);
    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-1', 'cursor-1');
  });

  it('merges a refreshed first page into the loaded tail and keeps the deepest cursor', async () => {
    const view = await renderReady(page([photo('p1')], 'cursor-1'));

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2')], 'cursor-2'));
    await act(async () => {
      await view.result.current.loadMore();
    });

    mockListTripPhotos.mockResolvedValueOnce(
      page([photo('new'), photo('p1')], 'replacement-page-2'),
    );
    await act(async () => {
      await view.result.current.loadFirstPage('silent');
    });

    expect(view.result.current.photos.map(({ id }) => id)).toEqual(['new', 'p1', 'p2']);
    expect(view.result.current.hasNextPage).toBe(true);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p3')], null));
    await act(async () => {
      await view.result.current.loadMore();
    });
    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-1', 'cursor-2');
    expect(view.result.current.photos.map(({ id }) => id)).toEqual([
      'new',
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('keeps loaded pages and waits for explicit Retry after a page fails', async () => {
    const view = await renderReady(page([photo('p1')], 'cursor-1'));

    mockListTripPhotos.mockRejectedValueOnce(serverError());
    await act(async () => {
      await view.result.current.loadMore();
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1']);
    expect(view.result.current.errorSource).toBe('loadMore');
    expect(view.result.current.status).toBe('ready');

    const requestsAfterFailure = mockListTripPhotos.mock.calls.length;
    await act(async () => {
      await view.result.current.loadMore();
    });
    expect(mockListTripPhotos).toHaveBeenCalledTimes(requestsAfterFailure);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2')], null));
    await act(async () => {
      await view.result.current.retryLoadMore();
    });

    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-1', 'cursor-1');
    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2']);
  });

  it('keeps the failed frontier closed across automatic silent reconciles', async () => {
    const view = await renderReady(page([photo('p1')], 'cursor-1'));

    mockListTripPhotos.mockRejectedValueOnce(serverError());
    await act(async () => {
      await view.result.current.loadMore();
    });
    expect(view.result.current.errorSource).toBe('loadMore');

    mockListTripPhotos.mockRejectedValueOnce(serverError());
    await triggerForeground();
    await waitFor(() => expect(mockListTripPhotos).toHaveBeenCalledTimes(3));
    expect(view.result.current.errorSource).toBe('loadMore');

    mockListTripPhotos.mockResolvedValueOnce(page([photo('new'), photo('p1')], 'ignored'));
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual(['new', 'p1']),
    );
    expect(view.result.current.errorSource).toBe('loadMore');

    const requestsBeforeAutomaticLoadMore = mockListTripPhotos.mock.calls.length;
    await act(async () => {
      await view.result.current.loadMore();
    });
    expect(mockListTripPhotos).toHaveBeenCalledTimes(requestsBeforeAutomaticLoadMore);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2')], null));
    await act(async () => {
      await view.result.current.retryLoadMore();
    });
    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-1', 'cursor-1');
    expect(view.result.current.errorSource).toBeNull();
  });

  it('keeps photos and reports a refresh failure inline', async () => {
    const view = await renderReady();

    mockListTripPhotos.mockRejectedValueOnce(serverError());
    await act(async () => {
      await view.result.current.loadFirstPage('refresh');
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2']);
    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.errorSource).toBe('refresh');
  });

  it('shows a full error only when the first load fails with nothing on screen', async () => {
    mockListTripPhotos.mockRejectedValueOnce(serverError());
    const view = await renderHook(() => useScopedTripPhotos('trip-1'));
    await triggerFocus();

    await waitFor(() => expect(view.result.current.status).toBe('error'));
    expect(view.result.current.errorSource).toBe('initial');
    expect(view.result.current.photos).toEqual([]);
  });

  it('ignores a stale first-page response that lost the race', async () => {
    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    const view = await renderHook(() => useScopedTripPhotos('trip-1'));
    await triggerFocus();

    mockListTripPhotos.mockResolvedValueOnce(page([photo('newest')]));
    await act(async () => {
      await view.result.current.loadFirstPage('refresh');
    });

    await act(async () => {
      slow.resolve(page([photo('stale')]));
      await slow.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['newest']);
  });

  it('does not let an older first-page success revive an explicitly invalidated trip', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));
    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    let pending!: Promise<void>;

    await act(async () => {
      pending = view.result.current.loadFirstPage('silent');
      await Promise.resolve();
    });
    await act(async () => {
      view.result.current.handleAssetNotFound('p1', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
        errorCode: 'TRIP_NOT_FOUND',
      });
    });

    await act(async () => {
      slow.resolve(page([photo('stale')]));
      await pending;
    });

    expect(view.result.current.tripNotFound).toBe(true);
    expect(view.result.current.photos).toEqual([]);
    expect(mockInvalidateTrip).toHaveBeenCalledTimes(1);
  });
});

describe('focus and foreground coalescing', () => {
  it('does not spend two list requests when both fire while one is in flight', async () => {
    const view = await renderReady();

    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    mockListTripPhotos.mockClear();

    await triggerFocus();
    await triggerForeground();

    // Returning to a screen while the app also comes back to the foreground is
    // one event to the user; it must cost one request, not two.
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(page([photo('p1')]));
      await slow.promise;
    });
    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1']);
  });
});

describe('reconcile sequencing', () => {
  it('invalidates an older load-more request before replacing the first page', async () => {
    const view = await renderReady(page([photo('p1')], 'cursor-1'));
    const loadMore = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(loadMore.promise);

    let pendingLoadMore!: Promise<void>;
    await act(async () => {
      pendingLoadMore = view.result.current.loadMore();
      await Promise.resolve();
    });

    mockListTripPhotos.mockResolvedValueOnce(page([photo('fresh')]));
    await act(async () => {
      view.result.current.handleAssetNotFound('ghost', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
    });
    await waitFor(() =>
      expect(view.result.current.photos.map((item) => item.id)).toEqual(['fresh']),
    );

    await act(async () => {
      loadMore.resolve(page([photo('stale-page')]));
      await pendingLoadMore;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['fresh']);
    expect(view.result.current.loadingMore).toBe(false);
  });

  it('does not let an older reconcile overwrite or tombstone a newer first page', async () => {
    const view = await renderReady(page([photo('p1')]));
    const reconcile = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(reconcile.promise);

    await act(async () => {
      view.result.current.handleAssetNotFound('p1', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p1'), photo('fresh')]));
    await act(async () => {
      await view.result.current.loadFirstPage('refresh');
    });

    await act(async () => {
      reconcile.resolve(page([photo('stale-reconcile')]));
      await reconcile.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'fresh']);
    expect(mockInvalidateAsset).not.toHaveBeenCalled();
    expect(view.result.current.refreshing).toBe(false);
  });
});

describe('trip identity boundaries', () => {
  it('hides the old trip immediately and ignores its pending response after rerender', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map((item) => item.id)).toEqual([
        'trip-1-photo',
      ]),
    );

    const oldTripResponse = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(oldTripResponse.promise);
    let oldTripRequest!: Promise<void>;
    await act(async () => {
      oldTripRequest = view.result.current.loadFirstPage('silent');
      await Promise.resolve();
    });

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    // The derived identity guard applies before the reset effect can paint.
    expect(view.result.current.photos).toEqual([]);
    expect(view.result.current.status).toBe('loading');

    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map((item) => item.id)).toEqual([
        'trip-2-photo',
      ]),
    );
    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-2');

    await act(async () => {
      oldTripResponse.resolve(page([photo('stale-trip-1-photo')]));
      await oldTripRequest;
    });
    expect(view.result.current.photos.map((item) => item.id)).toEqual([
      'trip-2-photo',
    ]);
  });

  it('loads a new trip after the previous trip was marked unreadable', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    await act(async () => {
      view.result.current.handleAssetNotFound('trip-1-photo', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
        errorCode: 'TRIP_NOT_FOUND',
      });
    });
    expect(view.result.current.tripNotFound).toBe(true);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();

    await waitFor(() =>
      expect(view.result.current.photos.map((item) => item.id)).toEqual([
        'trip-2-photo',
      ]),
    );
    expect(view.result.current.tripNotFound).toBe(false);
    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-2');
  });

  it('does not let a stale PHOTO_NOT_FOUND callback tombstone the same id in Trip B', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('shared'), photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const staleResolveAssetNotFound = view.result.current.resolveAssetNotFound;

    mockListTripPhotos.mockResolvedValueOnce(page([photo('shared'), photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual([
        'shared',
        'trip-2-photo',
      ]),
    );
    const invalidationsBeforeStaleCallback = mockInvalidateAsset.mock.calls.length;

    let resolution: Awaited<ReturnType<typeof staleResolveAssetNotFound>> | undefined;
    await act(async () => {
      resolution = await staleResolveAssetNotFound('shared', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
        errorCode: 'PHOTO_NOT_FOUND',
      });
    });

    expect(resolution).toBe('unknown');
    expect(view.result.current.photos.map(({ id }) => id)).toEqual([
      'shared',
      'trip-2-photo',
    ]);
    expect(view.result.current.tombstonedPhotoIds.has('shared')).toBe(false);
    expect(mockInvalidateAsset).toHaveBeenCalledTimes(invalidationsBeforeStaleCallback);
  });

  it('ignores a stale Trip A list TRIP_NOT_FOUND after Trip B is ready', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    const staleTripNotFound = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(staleTripNotFound.promise);
    let pendingTripA!: Promise<void>;
    await act(async () => {
      pendingTripA = view.result.current.loadFirstPage('silent');
      await Promise.resolve();
    });

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']),
    );
    const tripInvalidationsBeforeStaleResponse = mockInvalidateTrip.mock.calls.length;

    await act(async () => {
      staleTripNotFound.reject(notFound('TRIP_NOT_FOUND'));
      await pendingTripA;
    });

    expect(view.result.current.tripNotFound).toBe(false);
    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']);
    expect(mockInvalidateTrip).toHaveBeenCalledTimes(
      tripInvalidationsBeforeStaleResponse,
    );
  });

  it('does not let stale Trip A load-more error/finally mutate Trip B loading or cursor state', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')], 'trip-1-cursor'));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    const tripALoadMore = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(tripALoadMore.promise);
    let pendingTripALoadMore!: Promise<void>;
    await act(async () => {
      pendingTripALoadMore = view.result.current.loadMore();
      await Promise.resolve();
    });
    expect(view.result.current.loadingMore).toBe(true);

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')], 'trip-2-cursor'));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']),
    );

    const tripBLoadMore = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(tripBLoadMore.promise);
    let pendingTripBLoadMore!: Promise<void>;
    await act(async () => {
      pendingTripBLoadMore = view.result.current.loadMore();
      await Promise.resolve();
    });
    expect(view.result.current.loadingMore).toBe(true);

    await act(async () => {
      tripALoadMore.reject(serverError());
      await pendingTripALoadMore;
    });

    expect(view.result.current.loadingMore).toBe(true);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
    expect(view.result.current.hasNextPage).toBe(true);
    expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']);

    await act(async () => {
      tripBLoadMore.resolve(page([photo('trip-2-tail')], null));
      await pendingTripBLoadMore;
    });

    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-2', 'trip-2-cursor');
    expect(view.result.current.loadingMore).toBe(false);
    expect(view.result.current.hasNextPage).toBe(false);
    expect(view.result.current.photos.map(({ id }) => id)).toEqual([
      'trip-2-photo',
      'trip-2-tail',
    ]);
  });

  it('keeps Trip B reconcile ownership when a stale Trip A reconcile errors and settles', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    const tripAReconcile = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(tripAReconcile.promise);
    let pendingTripAReconcile!: ReturnType<typeof view.result.current.resolveAssetNotFound>;
    await act(async () => {
      pendingTripAReconcile = view.result.current.resolveAssetNotFound('trip-1-photo', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-a'), photo('trip-2-b')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual([
        'trip-2-a',
        'trip-2-b',
      ]),
    );

    const tripBReconcile = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(tripBReconcile.promise);
    let pendingTripBFirst!: ReturnType<typeof view.result.current.resolveAssetNotFound>;
    await act(async () => {
      pendingTripBFirst = view.result.current.resolveAssetNotFound('trip-2-a', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });

    await act(async () => {
      tripAReconcile.reject(serverError());
      await pendingTripAReconcile;
    });

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.errorSource).toBeNull();
    expect(view.result.current.refreshing).toBe(false);
    expect(view.result.current.loadingMore).toBe(false);

    const requestsBeforeSecondTripBCallback = mockListTripPhotos.mock.calls.length;
    let pendingTripBSecond!: ReturnType<typeof view.result.current.resolveAssetNotFound>;
    await act(async () => {
      pendingTripBSecond = view.result.current.resolveAssetNotFound('trip-2-b', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });
    expect(mockListTripPhotos).toHaveBeenCalledTimes(requestsBeforeSecondTripBCallback);

    await act(async () => {
      tripBReconcile.resolve(page([photo('trip-2-a'), photo('trip-2-b')]));
      await Promise.all([pendingTripBFirst, pendingTripBSecond]);
    });

    expect(view.result.current.photos).toEqual([]);
    expect(view.result.current.tombstonedPhotoIds).toEqual(
      new Set(['trip-2-a', 'trip-2-b']),
    );
  });

  it('makes an old public list callback a no-op at entry after Trip B renders', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const staleLoadFirstPage = view.result.current.loadFirstPage;

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']),
    );
    const requestsBeforeStaleEntry = mockListTripPhotos.mock.calls.length;

    await act(async () => {
      await staleLoadFirstPage('refresh');
    });

    expect(mockListTripPhotos).toHaveBeenCalledTimes(requestsBeforeStaleEntry);
    expect(view.result.current.refreshing).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']);
  });

  it('does not prepend a stale Trip A upload after Trip B renders', async () => {
    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-1-photo')]));
    const view = await renderHook(
      ({ activeTripId }: { activeTripId: string }) => useScopedTripPhotos(activeTripId),
      { initialProps: { activeTripId: 'trip-1' } },
    );
    await triggerFocus();
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    const stalePrependUploaded = view.result.current.prependUploaded;

    mockListTripPhotos.mockResolvedValueOnce(page([photo('trip-2-photo')]));
    await view.rerender({ activeTripId: 'trip-2' });
    await triggerFocus();
    await waitFor(() =>
      expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']),
    );

    await act(async () => {
      stalePrependUploaded([photo('stale-trip-1-upload', '2026-07-31T12:00:00Z')]);
    });

    expect(view.result.current.photos.map(({ id }) => id)).toEqual(['trip-2-photo']);
  });
});

describe('local override ledger', () => {
  it('keeps an uploaded photo through a refresh that started before the upload', async () => {
    const view = await renderReady(page([photo('p1')]));

    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    await act(async () => {
      void view.result.current.loadFirstPage('silent');
    });

    await act(async () => {
      view.result.current.prependUploaded([photo('uploaded', '2026-07-31T12:00:00Z')]);
    });

    await act(async () => {
      // The server has not seen the upload yet; its answer must not erase it.
      slow.resolve(page([photo('p1')]));
      await slow.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['uploaded', 'p1']);
  });

  it('keeps a deleted photo gone through a refresh that started before the delete', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));

    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    await act(async () => {
      void view.result.current.loadFirstPage('silent');
    });

    await act(async () => {
      view.result.current.removePhoto('p1');
    });

    await act(async () => {
      slow.resolve(page([photo('p1'), photo('p2')]));
      await slow.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p2']);
  });

  it('keeps a local delete through a coalesced ambiguous-404 reconcile', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));
    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);

    await act(async () => {
      view.result.current.handleAssetNotFound('ghost', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });
    await act(async () => {
      view.result.current.removePhoto('p1');
      slow.resolve(page([photo('p1'), photo('p2')]));
      await slow.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p2']);
  });

  it('keeps a local upload through a coalesced ambiguous-404 reconcile', async () => {
    const view = await renderReady(page([photo('p1')]));
    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);

    await act(async () => {
      view.result.current.handleAssetNotFound('ghost', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
      await Promise.resolve();
    });
    await act(async () => {
      view.result.current.prependUploaded([photo('uploaded', '2026-07-31T12:00:00Z')]);
      slow.resolve(page([photo('p1')]));
      await slow.promise;
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['uploaded', 'p1']);
  });

  it('sorts merged uploads by the list contract order', async () => {
    const view = await renderReady(page([photo('older', '2026-07-30T10:00:00Z')]));

    await act(async () => {
      view.result.current.prependUploaded([
        photo('newest', '2026-07-31T18:00:00Z'),
        photo('middle', '2026-07-31T09:00:00Z'),
      ]);
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('explicitly invalidates both variants of a removed photo, rather than releasing them', async () => {
    const view = await renderReady(page([photo('p1')]));

    await act(async () => {
      view.result.current.removePhoto('p1');
    });

    expect(mockInvalidateAsset).toHaveBeenCalledWith('trip-photo:trip-1:p1:thumbnail');
    expect(mockInvalidateAsset).toHaveBeenCalledWith('trip-photo:trip-1:p1:medium');
  });
});

describe('D18 404 routing', () => {
  it('treats a list 404 as a fail-closed trip boundary for every photo owner', async () => {
    const cleanup = createDeferred<void>();
    mockListTripPhotos.mockRejectedValueOnce(notFound('TRIP_NOT_FOUND'));
    const view = await renderHook(() => useScopedTripPhotosWithOwner('trip-1'));
    const activeTicket = view.result.current.scope.capture();
    const listener = jest.fn(() => cleanup.promise);
    view.result.current.scope.subscribeInvalidation(listener);
    await triggerFocus();

    await waitFor(() => expect(view.result.current.photos.tripNotFound).toBe(true));
    const terminalTicket = view.result.current.scope.capture();
    expect(listener).toHaveBeenCalledWith(activeTicket, terminalTicket);
    expect(view.result.current.scope.isCurrent(terminalTicket)).toBe(false);
    expect(view.result.current.photos.photos).toEqual([]);
    expect(mockInvalidateTrip).toHaveBeenCalledWith('trip-photo:trip-1:');

    // Even a newly captured same-trip callback is refused after terminal
    // evidence; reopening requires a different route identity.
    await act(async () => {
      await view.result.current.photos.loadFirstPage('initial');
    });
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);

    let cleanupSettled = false;
    const waiting = view.result.current.scope.waitForCleanup().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    cleanup.resolve();
    await waiting;
  });

  it('tombstones only the reported photo on PHOTO_NOT_FOUND', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));

    await act(async () => {
      view.result.current.handleAssetNotFound('p1', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
        errorCode: 'PHOTO_NOT_FOUND',
      });
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p2']);
    expect(view.result.current.tripNotFound).toBe(false);
    // No reconcile needed: the code already said which of the two this was.
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);
  });

  it('publishes a new tombstone synchronously before React state delivery', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));
    let gateObserved = false;
    const listener = jest.fn((photoId: string) => {
      gateObserved = view.result.current.isPhotoTombstoned(photoId);
    });
    const unsubscribe = view.result.current.subscribePhotoTombstones(listener);

    await act(async () => {
      view.result.current.markPhotoStale('p1');
      expect(listener).toHaveBeenCalledWith('p1');
      expect(gateObserved).toBe(true);
    });

    // The feed is an edge, not a second business outcome for the same id.
    await act(async () => {
      view.result.current.markPhotoStale('p1');
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('goes trip-level on TRIP_NOT_FOUND without tombstoning tiles one by one', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));

    await act(async () => {
      view.result.current.handleAssetNotFound('p1', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
        errorCode: 'TRIP_NOT_FOUND',
      });
    });

    expect(view.result.current.tripNotFound).toBe(true);
    expect(view.result.current.photos).toEqual([]);
  });

  it('coalesces sixty tiles reporting the same membership loss into one trip-level pass', async () => {
    const view = await renderReady(page([photo('p1')]));

    await act(async () => {
      for (let index = 0; index < 60; index += 1) {
        view.result.current.handleAssetNotFound(`p${index}`, {
          kind: 'notFound',
          message: 'gone',
          status: 404,
          errorCode: 'TRIP_NOT_FOUND',
        });
      }
    });

    expect(view.result.current.tripNotFound).toBe(true);
    expect(mockInvalidateTrip).toHaveBeenCalledTimes(1);
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);
  });

  it('buys evidence before acting on a 404 with no parseable code', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));

    // The reconcile succeeds, so the trip is readable and the photo really is
    // the stale one.
    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2')]));
    await act(async () => {
      view.result.current.handleAssetNotFound('p1', { kind: 'notFound', message: 'gone', status: 404 });
    });

    await waitFor(() => expect(view.result.current.photos.map((item) => item.id)).toEqual(['p2']));
    expect(view.result.current.tripNotFound).toBe(false);
    expect(mockListTripPhotos).toHaveBeenCalledTimes(2);
  });

  it('escalates an unparseable 404 to trip-level when the reconcile also 404s', async () => {
    const view = await renderReady(page([photo('p1')]));

    mockListTripPhotos.mockRejectedValueOnce(notFound());
    await act(async () => {
      view.result.current.handleAssetNotFound('p1', { kind: 'notFound', message: 'gone', status: 404 });
    });

    await waitFor(() => expect(view.result.current.tripNotFound).toBe(true));
  });

  it('keeps every photo when ambiguous-404 evidence fails with network or 5xx', async () => {
    const view = await renderReady(page([photo('p1'), photo('p2')]));
    mockListTripPhotos.mockRejectedValueOnce(serverError());

    await act(async () => {
      view.result.current.handleAssetNotFound('p1', {
        kind: 'notFound',
        message: 'gone',
        status: 404,
      });
    });

    await waitFor(() =>
      expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2']),
    );
    expect(view.result.current.tripNotFound).toBe(false);
    expect(mockInvalidateAsset).not.toHaveBeenCalled();
  });

  it('runs one reconcile no matter how many tiles report an unparseable 404 at once', async () => {
    const view = await renderReady(page([photo('p1')]));

    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    mockListTripPhotos.mockClear();

    await act(async () => {
      for (let index = 0; index < 60; index += 1) {
        view.result.current.handleAssetNotFound(`p${index}`, {
          kind: 'notFound',
          message: 'gone',
          status: 404,
        });
      }
    });

    // One list request for sixty failing tiles — not sixty. The list throttle is
    // 120/hour, so a grid that fans out here empties it in one screen.
    expect(mockListTripPhotos).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(page([photo('p1')]));
      await slow.promise;
    });
  });
});
