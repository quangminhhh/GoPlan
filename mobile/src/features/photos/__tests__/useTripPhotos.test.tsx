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
import type { TripPhoto } from '../types';

const mockListTripPhotos = listTripPhotos as jest.MockedFunction<typeof listTripPhotos>;
const mockInvalidateAsset = invalidateProtectedAsset as jest.MockedFunction<
  typeof invalidateProtectedAsset
>;
const mockInvalidateTrip = invalidateProtectedAssets as jest.MockedFunction<
  typeof invalidateProtectedAssets
>;

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
  const view = await renderHook(() => useTripPhotos('trip-1'));
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

  it('keeps loaded pages and the same cursor when a page fails, so retry asks again', async () => {
    const view = await renderReady(page([photo('p1')], 'cursor-1'));

    mockListTripPhotos.mockRejectedValueOnce(serverError());
    await act(async () => {
      await view.result.current.loadMore();
    });

    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1']);
    expect(view.result.current.errorSource).toBe('loadMore');
    expect(view.result.current.status).toBe('ready');

    mockListTripPhotos.mockResolvedValueOnce(page([photo('p2')], null));
    await act(async () => {
      await view.result.current.loadMore();
    });

    expect(mockListTripPhotos).toHaveBeenLastCalledWith('trip-1', 'cursor-1');
    expect(view.result.current.photos.map((item) => item.id)).toEqual(['p1', 'p2']);
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
    const view = await renderHook(() => useTripPhotos('trip-1'));
    await triggerFocus();

    await waitFor(() => expect(view.result.current.status).toBe('error'));
    expect(view.result.current.errorSource).toBe('initial');
    expect(view.result.current.photos).toEqual([]);
  });

  it('ignores a stale first-page response that lost the race', async () => {
    const slow = createDeferred<CursorPage<TripPhoto>>();
    mockListTripPhotos.mockReturnValueOnce(slow.promise);
    const view = await renderHook(() => useTripPhotos('trip-1'));
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
  it('treats a list 404 as trip-level and invalidates every asset of the trip', async () => {
    mockListTripPhotos.mockRejectedValueOnce(notFound('TRIP_NOT_FOUND'));
    const view = await renderHook(() => useTripPhotos('trip-1'));
    await triggerFocus();

    await waitFor(() => expect(view.result.current.tripNotFound).toBe(true));
    expect(view.result.current.photos).toEqual([]);
    expect(mockInvalidateTrip).toHaveBeenCalledWith('trip-photo:trip-1:');
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
