const mockDownloadAndShare = jest.fn();

jest.mock('../downloads', () => ({
  ...jest.requireActual('../downloads'),
  downloadAndShareTripPhotoArchive: (...args: unknown[]) => mockDownloadAndShare(...args),
}));

// eslint-disable-next-line import/first
import { act, renderHook } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { createDeferred } from '@test/fakeProtectedTransport';
// eslint-disable-next-line import/first
import { PHOTO_BULK_DOWNLOAD_MAX_SELECTION } from '../constants';
// eslint-disable-next-line import/first
import { usePhotoSelection } from '../hooks/usePhotoSelection';
// eslint-disable-next-line import/first
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

function options(overrides: Record<string, unknown> = {}) {
  return {
    tripId: 'trip-1',
    photos: [photo('p1'), photo('p2'), photo('p3')],
    reconcile: jest.fn(async () => undefined),
    onTripNotFound: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDownloadAndShare.mockResolvedValue({ status: 'shared', fileName: 'trip-photos.zip' });
});

describe('selection model', () => {
  it('enters selection on a long press and selects that photo', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));

    await act(async () => {
      result.current.enterSelection('p2');
    });

    expect(result.current.selectionMode).toBe(true);
    expect(result.current.selectedIds).toEqual(['p2']);
  });

  it('toggles on tap', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      result.current.toggle('p2');
    });
    expect(result.current.selectedCount).toBe(2);

    await act(async () => {
      result.current.toggle('p1');
    });
    expect(result.current.selectedIds).toEqual(['p2']);
  });

  it('refuses the photo past the hundred cap', async () => {
    const photos = Array.from({ length: 120 }, (_unused, index) => photo(`p${index}`));
    const { result } = await renderHook(() => usePhotoSelection(options({ photos })));

    await act(async () => {
      result.current.enterSelection('p0');
      for (let index = 1; index < 120; index += 1) {
        result.current.toggle(`p${index}`);
      }
    });

    expect(result.current.selectedCount).toBe(PHOTO_BULK_DOWNLOAD_MAX_SELECTION);
  });

  it('selects only what is loaded, capped at a hundred', async () => {
    const photos = Array.from({ length: 130 }, (_unused, index) => photo(`p${index}`));
    const { result } = await renderHook(() => usePhotoSelection(options({ photos })));

    await act(async () => {
      result.current.enterSelection('p0');
      result.current.selectLoaded();
    });

    expect(result.current.selectedCount).toBe(PHOTO_BULK_DOWNLOAD_MAX_SELECTION);
  });

  it('clears without leaving selection mode, and exits on cancel', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      result.current.clear();
    });
    expect(result.current.selectionMode).toBe(true);
    expect(result.current.selectedCount).toBe(0);

    await act(async () => {
      result.current.exit();
    });
    expect(result.current.selectionMode).toBe(false);
  });
});

describe('bulk download', () => {
  it('sends the selected ids and counts the request against the hourly budget', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
      result.current.toggle('p3');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(mockDownloadAndShare).toHaveBeenCalledTimes(1);
    expect(mockDownloadAndShare.mock.calls[0][0]).toMatchObject({
      tripId: 'trip-1',
      photoIds: ['p1', 'p3'],
    });
    expect(result.current.requestsUsed).toBe(1);
  });

  it('keeps the selection after the sheet closes and claims no success', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    // `shareAsync` resolving proves the sheet closed, not that anything was
    // shared, so nothing is announced and the selection survives.
    expect(result.current.selectedIds).toEqual(['p1']);
    expect(result.current.selectionMode).toBe(true);
    expect(result.current.download).toEqual({ status: 'idle' });
  });

  it('refuses a second download while one is running', async () => {
    let release: (() => void) | null = null;
    mockDownloadAndShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'shared', fileName: 'a.zip' });
        }),
    );
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      void result.current.startDownload();
      void result.current.startDownload();
      release?.();
    });

    expect(mockDownloadAndShare).toHaveBeenCalledTimes(1);
  });

  it('does nothing with an empty selection', async () => {
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
      result.current.clear();
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(mockDownloadAndShare).not.toHaveBeenCalled();
  });

  it('reports progress while the archive streams', async () => {
    const finish = createDeferred<{ status: 'shared'; fileName: string }>();
    mockDownloadAndShare.mockImplementation(
      async (input: { onProgress?: (written: number, total: number | null) => void }) => {
        input.onProgress?.(1024, 4096);
        return finish.promise;
      },
    );
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.startDownload();
    });

    // Observed while the archive is still streaming, not after it finished.
    expect(result.current.download).toEqual({
      status: 'downloading',
      bytesWritten: 1024,
      totalBytes: 4096,
    });

    await act(async () => {
      finish.resolve({ status: 'shared', fileName: 'a.zip' });
      await pending;
    });
  });

  it('aborts an in-flight archive when selection mode is exited', async () => {
    const finish = createDeferred<{ status: 'cancelled' }>();
    mockDownloadAndShare.mockImplementation(() => finish.promise);
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.startDownload();
    });
    const signal = mockDownloadAndShare.mock.calls[0][0].signal as AbortSignal;

    await act(async () => {
      result.current.exit();
    });

    expect(signal.aborted).toBe(true);
    expect(result.current.selectionMode).toBe(false);

    await act(async () => {
      finish.resolve({ status: 'cancelled' });
      await pending;
    });
  });

  it('aborts an in-flight archive when the screen unmounts', async () => {
    const finish = createDeferred<{ status: 'cancelled' }>();
    mockDownloadAndShare.mockImplementation(() => finish.promise);
    const view = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      view.result.current.enterSelection('p1');
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = view.result.current.startDownload();
    });
    const signal = mockDownloadAndShare.mock.calls[0][0].signal as AbortSignal;

    await act(async () => {
      view.unmount();
    });

    expect(signal.aborted).toBe(true);
    finish.resolve({ status: 'cancelled' });
    await pending;
  });
});

describe('all-or-nothing bulk 404 (D17)', () => {
  it('reconciles, clears the whole selection and asks the user to choose again', async () => {
    mockDownloadAndShare.mockResolvedValue({ status: 'staleSelection' });
    const opts = options();
    const { result } = await renderHook(() => usePhotoSelection(opts));
    await act(async () => {
      result.current.enterSelection('p1');
      result.current.toggle('p2');
      result.current.toggle('p3');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    // The server refuses the whole archive without saying which id was stale,
    // so nothing here tries to work out which two of the three are still fine.
    expect(opts.reconcile).toHaveBeenCalledTimes(1);
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.selectionMode).toBe(false);
    // One request, not a retry loop against a 30/hour budget.
    expect(mockDownloadAndShare).toHaveBeenCalledTimes(1);
  });

  it('clears the selection even when the reconcile itself fails', async () => {
    mockDownloadAndShare.mockResolvedValue({ status: 'staleSelection' });
    const opts = options({
      reconcile: jest.fn(async () => {
        throw new Error('offline');
      }),
    });
    const { result } = await renderHook(() => usePhotoSelection(opts));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      await result.current.startDownload().catch(() => undefined);
    });

    expect(result.current.selectedCount).toBe(0);
    expect(result.current.selectionMode).toBe(false);
  });

  it('never leaks a photo id into the message', async () => {
    mockDownloadAndShare.mockResolvedValue({ status: 'staleSelection' });
    const reconciling = createDeferred<void>();
    const opts = options({ reconcile: jest.fn(() => reconciling.promise) });
    const { result } = await renderHook(() => usePhotoSelection(opts));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.startDownload();
    });

    // Held mid-reconcile so the message is observable before the selection is
    // cleared.
    expect(result.current.download).toEqual({
      status: 'message',
      message: 'Some selected photos are no longer available.',
    });
    expect(JSON.stringify(result.current.download)).not.toContain('p1');

    await act(async () => {
      reconciling.resolve();
      await pending;
    });
  });

  it('routes a trip-level 404 away from the stale-selection path', async () => {
    mockDownloadAndShare.mockResolvedValue({
      status: 'failed',
      failure: { kind: 'notFound', message: 'gone', status: 404, errorCode: 'TRIP_NOT_FOUND' },
    });
    const opts = options();
    const { result } = await renderHook(() => usePhotoSelection(opts));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(opts.onTripNotFound).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'TRIP_NOT_FOUND' }),
    );
    expect(opts.reconcile).not.toHaveBeenCalled();
    expect(result.current.selectionMode).toBe(false);
  });

  it('keeps the selection so the user can retry after a throttle or a failure', async () => {
    mockDownloadAndShare.mockResolvedValue({
      status: 'failed',
      failure: { kind: 'throttled', message: 'Download limit reached. Try again later.', status: 429 },
    });
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
      result.current.toggle('p2');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(result.current.selectedCount).toBe(2);
    expect(result.current.download).toMatchObject({
      status: 'error',
      failure: { message: 'Download limit reached. Try again later.' },
    });
  });

  it('reports an unavailable share sheet without losing the selection', async () => {
    mockDownloadAndShare.mockResolvedValue({ status: 'unavailable' });
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(result.current.selectedCount).toBe(1);
    expect(result.current.download).toMatchObject({ status: 'error' });
  });

  it('treats a cancelled download as an ordinary outcome', async () => {
    mockDownloadAndShare.mockResolvedValue({ status: 'cancelled' });
    const { result } = await renderHook(() => usePhotoSelection(options()));
    await act(async () => {
      result.current.enterSelection('p1');
    });

    await act(async () => {
      await result.current.startDownload();
    });

    expect(result.current.download).toEqual({ status: 'idle' });
    expect(result.current.selectedCount).toBe(1);
  });
});
