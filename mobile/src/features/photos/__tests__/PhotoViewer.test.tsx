const mockDeleteTripPhoto = jest.fn();
const mockSaveTripPhotoToLibrary = jest.fn();

jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  deleteTripPhoto: (...args: unknown[]) => mockDeleteTripPhoto(...args),
}));

jest.mock('../downloads', () => ({
  ...jest.requireActual('../downloads'),
  saveTripPhotoToLibrary: (...args: unknown[]) => mockSaveTripPhotoToLibrary(...args),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('@/shared/media/AuthenticatedImage', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return {
    AuthenticatedImage: (props: Record<string, unknown>) =>
      createElement(View, { testID: `authenticated-${String(props.assetKey)}` }),
  };
});

// eslint-disable-next-line import/first
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { Alert } from 'react-native';
// eslint-disable-next-line import/first
import { AxiosError } from 'axios';
// eslint-disable-next-line import/first
import { formatCapturedAt, PhotoViewer } from '../components/PhotoViewer';
// eslint-disable-next-line import/first
import { usePhotoViewer, VIEWER_PREFETCH_THRESHOLD } from '../hooks/usePhotoViewer';
// eslint-disable-next-line import/first
import type { TripPhoto } from '../types';

function photo(id: string, overrides: Partial<TripPhoto> = {}): TripPhoto {
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
    ...overrides,
  };
}

function failure(status: number, body: unknown): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data: body,
  });
}

function networkFailure(): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('Network Error', 'ERR_NETWORK', config, {});
}

const noop = () => undefined;

function renderViewer(overrides: Record<string, unknown> = {}) {
  const photos = (overrides.photos as TripPhoto[]) ?? [photo('p1'), photo('p2'), photo('p3')];
  const currentIndex = (overrides.currentIndex as number) ?? 0;
  return render(
    <PhotoViewer
      tripId="trip-1"
      photos={photos}
      currentIndex={currentIndex}
      currentPhoto={photos[currentIndex]}
      action={{ status: 'idle' }}
      onClose={noop}
      onGoTo={noop}
      onGoToOffset={noop}
      onDelete={noop}
      onSave={noop}
      onDismissAction={noop}
      onAssetNotFound={noop}
      {...overrides}
    />,
  );
}

function hookOptions(overrides: Record<string, unknown> = {}) {
  return {
    tripId: 'trip-1',
    photos: [photo('p1'), photo('p2'), photo('p3')],
    hasNextPage: false,
    loadMore: jest.fn(),
    reconcile: jest.fn(async () => undefined),
    removePhoto: jest.fn(),
    onAssetNotFound: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteTripPhoto.mockResolvedValue(undefined);
  mockSaveTripPhotoToLibrary.mockResolvedValue({ status: 'saved' });
});

describe('PhotoViewer rendering', () => {
  it('opens on the tapped photo and mounts only its immediate neighbours', async () => {
    const photos = [photo('p1'), photo('p2'), photo('p3'), photo('p4'), photo('p5')];
    await renderViewer({ photos, currentIndex: 2 });

    expect(screen.getByTestId('zoomable-photo-p2')).toBeTruthy();
    expect(screen.getByTestId('zoomable-photo-p3')).toBeTruthy();
    expect(screen.getByTestId('zoomable-photo-p4')).toBeTruthy();
    // A five-photo gallery must not hold five medium variants in memory.
    expect(screen.queryByTestId('zoomable-photo-p1')).toBeNull();
    expect(screen.queryByTestId('zoomable-photo-p5')).toBeNull();
  });

  it('uses the medium variant, never the thumbnail', async () => {
    await renderViewer();

    expect(screen.getByTestId('authenticated-trip-photo:trip-1:p1:medium')).toBeTruthy();
    expect(screen.queryByTestId('authenticated-trip-photo:trip-1:p1:thumbnail')).toBeNull();
  });

  it('shows uploader, tag and a localised date', async () => {
    await renderViewer();

    expect(screen.getByText('Mai @mai')).toBeTruthy();
    expect(screen.getByText(formatCapturedAt('2026-07-31T10:00:00Z'))).toBeTruthy();
  });

  it('renders a neutral fallback for an unparseable date instead of crashing', async () => {
    const photos = [photo('p1', { created_at: 'not-a-date' })];
    await renderViewer({ photos });

    expect(screen.getByText('Date unavailable')).toBeTruthy();
  });

  it('announces the position for VoiceOver', async () => {
    await renderViewer({ currentIndex: 1 });

    expect(screen.getByTestId('photo-viewer-position').props.children).toBe('Photo 2 of 3');
  });

  it('offers accessible previous and next controls, disabled at the boundaries', async () => {
    const onGoToOffset = jest.fn();
    await renderViewer({ currentIndex: 0, onGoToOffset });

    expect(screen.getByLabelText('Previous photo').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByLabelText('Next photo'));
    expect(onGoToOffset).toHaveBeenCalledWith(1);
  });
});

describe('delete affordance', () => {
  it('is absent when the server says the user cannot delete', async () => {
    const photos = [photo('p1', { can_delete: false })];
    await renderViewer({ photos });

    expect(screen.queryByTestId('photo-viewer-delete')).toBeNull();
  });

  it('is present when the server says they can, behind a destructive confirmation', async () => {
    const onDelete = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderViewer({ onDelete });

    await fireEvent.press(screen.getByTestId('photo-viewer-delete'));

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; style?: string; onPress?: () => void }[],
    ];
    expect(title).toBe('Delete photo?');
    expect(message).toContain('cannot be undone');
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Delete']);
    expect(buttons[1].style).toBe('destructive');

    buttons[1].onPress?.();
    expect(onDelete).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it('labels save neutrally, because the download variant is not an original', async () => {
    await renderViewer();

    expect(screen.getByLabelText('Save to Photos')).toBeTruthy();
    expect(screen.queryByLabelText(/original/i)).toBeNull();
    expect(screen.queryByText(/full quality/i)).toBeNull();
  });
});

describe('usePhotoViewer delete', () => {
  it('removes the photo, closes and reports success on 204', async () => {
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));

    await act(async () => {
      result.current.open('p1');
    });
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(mockDeleteTripPhoto).toHaveBeenCalledWith('trip-1', 'p1');
    expect(options.removePhoto).toHaveBeenCalledWith('p1');
    expect(result.current.openPhotoId).toBeNull();
    expect(result.current.action).toEqual({ status: 'message', message: 'Photo deleted.' });
  });

  it('refuses a second delete while one is in flight', async () => {
    let resolveDelete: (() => void) | null = null;
    mockDeleteTripPhoto.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      void result.current.confirmDelete();
      void result.current.confirmDelete();
      resolveDelete?.();
    });

    expect(mockDeleteTripPhoto).toHaveBeenCalledTimes(1);
  });

  it('treats PHOTO_NOT_FOUND as already gone, without claiming it deleted anything', async () => {
    mockDeleteTripPhoto.mockRejectedValue(
      failure(404, { detail: 'Photo not found.', error_code: 'PHOTO_NOT_FOUND' }),
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(options.removePhoto).toHaveBeenCalledWith('p1');
    expect(result.current.openPhotoId).toBeNull();
    expect(result.current.action).toEqual({ status: 'idle' });
  });

  it('routes TRIP_NOT_FOUND to the owner instead of removing one photo', async () => {
    mockDeleteTripPhoto.mockRejectedValue(
      failure(404, { detail: 'Trip not found.', error_code: 'TRIP_NOT_FOUND' }),
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(options.removePhoto).not.toHaveBeenCalled();
    expect(options.onAssetNotFound).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ errorCode: 'TRIP_NOT_FOUND' }),
    );
  });

  it('keeps the server as the authority on 403', async () => {
    mockDeleteTripPhoto.mockRejectedValue(
      failure(403, { detail: 'You cannot delete this photo.', error_code: 'PHOTO_DELETE_FORBIDDEN' }),
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(options.removePhoto).not.toHaveBeenCalled();
    expect(result.current.action).toMatchObject({
      status: 'error',
      failure: { message: 'You cannot delete this photo.' },
    });
  });

  it('reconciles rather than guessing when the outcome cannot be known', async () => {
    mockDeleteTripPhoto.mockRejectedValue(networkFailure());
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    // The delete may have landed before the connection dropped, so the list is
    // re-read and no success is claimed either way.
    expect(options.reconcile).toHaveBeenCalledTimes(1);
    expect(options.removePhoto).not.toHaveBeenCalled();
    expect(result.current.action).toMatchObject({ status: 'error' });
    expect(result.current.action).not.toMatchObject({ status: 'message' });
  });

  it('treats a 5xx the same way as a dropped connection', async () => {
    mockDeleteTripPhoto.mockRejectedValue(
      failure(500, { detail: 'Storage error.', error_code: 'PHOTO_STORAGE_ERROR' }),
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(options.reconcile).toHaveBeenCalledTimes(1);
    expect(options.removePhoto).not.toHaveBeenCalled();
  });
});

describe('usePhotoViewer save', () => {
  it('reports success without promising an original', async () => {
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.action).toEqual({ status: 'message', message: 'Saved to Photos.' });
  });

  it('points at Settings only when the OS will not ask again', async () => {
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    mockSaveTripPhotoToLibrary.mockResolvedValue({ status: 'permissionDenied', canAskAgain: true });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.action).toMatchObject({ status: 'message' });
    expect((result.current.action as { message: string }).message).not.toContain('Settings');

    mockSaveTripPhotoToLibrary.mockResolvedValue({ status: 'permissionDenied', canAskAgain: false });
    await act(async () => {
      await result.current.save();
    });
    expect((result.current.action as { message: string }).message).toContain('Settings');
  });

  it('uses a download-specific message when throttled', async () => {
    mockSaveTripPhotoToLibrary.mockResolvedValue({
      status: 'failed',
      failure: { kind: 'throttled', message: 'generic', status: 429 },
    });
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.action).toMatchObject({
      status: 'error',
      failure: { message: 'Download limit reached. Try again later.' },
    });
  });

  it('closes on a stale photo and hands the failure to the owner', async () => {
    mockSaveTripPhotoToLibrary.mockResolvedValue({
      status: 'failed',
      failure: { kind: 'notFound', message: 'gone', status: 404, errorCode: 'PHOTO_NOT_FOUND' },
    });
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.save();
    });

    expect(options.onAssetNotFound).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ errorCode: 'PHOTO_NOT_FOUND' }),
    );
    expect(result.current.openPhotoId).toBeNull();
  });
});

describe('usePhotoViewer navigation', () => {
  it('follows the photo id, so a delete elsewhere cannot shift it onto another photo', async () => {
    const photos = [photo('p1'), photo('p2'), photo('p3')];
    const { result, rerender } = await renderHook(
      (props: { photos: TripPhoto[] }) => usePhotoViewer(hookOptions({ photos: props.photos })),
      { initialProps: { photos } },
    );

    await act(async () => {
      result.current.open('p3');
    });
    expect(result.current.currentIndex).toBe(2);

    await rerender({ photos: [photo('p2'), photo('p3')] });

    expect(result.current.currentPhoto?.id).toBe('p3');
    expect(result.current.currentIndex).toBe(1);
  });

  it('closes when the open photo disappears from the list', async () => {
    const photos = [photo('p1'), photo('p2')];
    const { result, rerender } = await renderHook(
      (props: { photos: TripPhoto[] }) => usePhotoViewer(hookOptions({ photos: props.photos })),
      { initialProps: { photos } },
    );

    await act(async () => {
      result.current.open('p1');
    });
    await rerender({ photos: [photo('p2')] });

    expect(result.current.openPhotoId).toBeNull();
    expect(result.current.currentPhoto).toBeNull();
  });

  it('prefetches the next page when it nears the end of what is loaded', async () => {
    const photos = Array.from({ length: 10 }, (_unused, index) => photo(`p${index}`));
    const options = hookOptions({ photos, hasNextPage: true });
    const { result } = await renderHook(() => usePhotoViewer(options));

    await act(async () => {
      result.current.open('p0');
    });
    expect(options.loadMore).not.toHaveBeenCalled();

    await act(async () => {
      result.current.goTo(`p${photos.length - VIEWER_PREFETCH_THRESHOLD}`);
    });

    await waitFor(() => expect(options.loadMore).toHaveBeenCalled());
  });

  it('does not prefetch when there is no next page', async () => {
    const photos = Array.from({ length: 4 }, (_unused, index) => photo(`p${index}`));
    const options = hookOptions({ photos, hasNextPage: false });
    const { result } = await renderHook(() => usePhotoViewer(options));

    await act(async () => {
      result.current.open('p3');
    });

    expect(options.loadMore).not.toHaveBeenCalled();
  });
});
