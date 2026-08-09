const mockDeleteTripPhoto = jest.fn();
const mockGetTripPhoto = jest.fn();
const mockSaveTripPhotoToLibrary = jest.fn();

jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  deleteTripPhoto: (...args: unknown[]) => mockDeleteTripPhoto(...args),
  getTripPhoto: (...args: unknown[]) => mockGetTripPhoto(...args),
}));

jest.mock('../photoSave', () => ({
  ...jest.requireActual('../photoSave'),
  saveTripPhotoToLibrary: (...args: unknown[]) => mockSaveTripPhotoToLibrary(...args),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('@/shared/media/AuthenticatedImage', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return {
    AuthenticatedImage: (props: Record<string, unknown>) =>
      createElement(View, {
        backgroundColor: props.backgroundColor,
        accessibilityLabel: props.accessibilityLabel,
        accessible: props.accessible,
        height: props.height,
        testID: `authenticated-${String(props.assetKey)}`,
        width: props.width,
      }),
  };
});

// eslint-disable-next-line import/first
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { Alert, StyleSheet } from 'react-native';
// eslint-disable-next-line import/first
import { SafeAreaProvider, type EdgeInsets } from 'react-native-safe-area-context';
// eslint-disable-next-line import/first
import {
  Gesture,
  GestureHandlerRootView,
  State,
} from 'react-native-gesture-handler';
// eslint-disable-next-line import/first
import { useSharedValue } from 'react-native-reanimated';
// eslint-disable-next-line import/first
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';
// eslint-disable-next-line import/first
import { createDeferred } from '@test/fakeProtectedTransport';
// eslint-disable-next-line import/first
import { AxiosError } from 'axios';
// eslint-disable-next-line import/first
import {
  dismissTranslationForViewport,
  formatCapturedAt,
  mediaViewportFallback,
  photoViewerPageKey,
  PhotoViewer,
  readSynchronousMediaViewport,
  zoomChangeHandlerForPage,
} from '../components/PhotoViewer';
// eslint-disable-next-line import/first
import { ZoomablePhoto } from '../components/ZoomablePhoto';
// eslint-disable-next-line import/first
import { usePhotoViewer, VIEWER_PREFETCH_THRESHOLD } from '../hooks/usePhotoViewer';
// eslint-disable-next-line import/first
import type { TripPhotoScope, TripPhotoScopeTicket } from '../hooks/useTripPhotoScope';
// eslint-disable-next-line import/first
import type { SavePhotoOutcome, SaveTripPhotoOptions } from '../photoSave';
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

function ZoomableGestureProbe({
  onZoomChange,
}: {
  onZoomChange: (zoomed: boolean) => void;
}) {
  const pinchInProgress = useSharedValue(false);
  const pagerGesture = Gesture.Native();
  const dismissGesture = Gesture.Pan();

  return (
    <GestureHandlerRootView>
      <ZoomablePhoto
        photoId="gesture-probe"
        width={390}
        height={700}
        sourceWidth={2560}
        sourceHeight={1920}
        zoomed={false}
        pagerGesture={pagerGesture}
        dismissGesture={dismissGesture}
        pinchInProgress={pinchInProgress}
        onZoomChange={onZoomChange}
      >
        <></>
      </ZoomablePhoto>
    </GestureHandlerRootView>
  );
}

function renderViewer(
  overrides: Record<string, unknown> = {},
  safeAreaInsets: EdgeInsets = { top: 0, bottom: 0, left: 0, right: 0 },
) {
  const photos = (overrides.photos as TripPhoto[]) ?? [photo('p1'), photo('p2'), photo('p3')];
  const currentIndex = (overrides.currentIndex as number) ?? 0;
  const viewer = (
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
    />
  );
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 430, height: 932 },
        insets: safeAreaInsets,
      }}
    >
      {viewer}
    </SafeAreaProvider>,
  );
}

function hookOptions(overrides: Record<string, unknown> = {}) {
  const ticket = { tripId: 'trip-1', generation: 0 };
  return {
    tripId: 'trip-1',
    scope: {
      capture: () => ticket,
      isCurrent: (candidate: typeof ticket) =>
        candidate.tripId === ticket.tripId && candidate.generation === ticket.generation,
      subscribeInvalidation: () => () => undefined,
      waitForCleanup: async () => undefined,
    },
    photos: [photo('p1'), photo('p2'), photo('p3')],
    hasNextPage: false,
    loadMore: jest.fn(),
    reconcile: jest.fn(async () => undefined),
    removePhoto: jest.fn(),
    isPhotoTombstoned: jest.fn(() => false),
    onAssetNotFound: jest.fn(),
    onTripUnavailable: jest.fn(),
    resolveAmbiguousNotFound: jest.fn(async () => 'unknown' as const),
    ...overrides,
  };
}

function createViewerScopeHarness(tripId = 'trip-1') {
  let ticket: TripPhotoScopeTicket = { tripId, generation: 0 };
  const listeners = new Set<Parameters<TripPhotoScope['subscribeInvalidation']>[0]>();
  let cleanupTail = Promise.resolve();
  const scope: TripPhotoScope = {
    capture: () => ticket,
    isCurrent: (candidate) =>
      candidate.tripId === ticket.tripId && candidate.generation === ticket.generation,
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForCleanup: async () => {
      for (;;) {
        const observed = cleanupTail;
        await observed;
        if (observed === cleanupTail) return;
      }
    },
  };
  return {
    scope,
    invalidate(nextTripId: string): Promise<void> {
      const previous = ticket;
      ticket = { tripId: nextTripId, generation: ticket.generation + 1 };
      const cleanups = Array.from(listeners, (listener) => {
        try {
          return Promise.resolve(listener(previous, ticket));
        } catch {
          return Promise.resolve();
        }
      });
      cleanupTail = Promise.allSettled([cleanupTail, ...cleanups]).then(
        () => undefined,
      );
      return cleanupTail;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteTripPhoto.mockResolvedValue(undefined);
  mockGetTripPhoto.mockResolvedValue(photo('p1'));
  mockSaveTripPhotoToLibrary.mockResolvedValue({ status: 'saved' });
});

describe('PhotoViewer rendering', () => {
  it('changes page identity when a neighbour becomes active so stale zoom state is reset', () => {
    expect(photoViewerPageKey('p2', 'p1')).toBe('p2:neighbour');
    expect(photoViewerPageKey('p2', 'p2')).toBe('p2:active');
  });

  it('opens on the tapped photo and mounts only its immediate neighbours', async () => {
    const photos = [photo('p1'), photo('p2'), photo('p3'), photo('p4'), photo('p5')];
    await renderViewer({ photos, currentIndex: 2 });

    expect(
      screen.getByTestId('zoomable-photo-p2', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByTestId('zoomable-photo-p3')).toBeTruthy();
    expect(
      screen.getByTestId('zoomable-photo-p4', { includeHiddenElements: true }),
    ).toBeTruthy();
    // A five-photo gallery must not hold five medium variants in memory.
    expect(screen.queryByTestId('zoomable-photo-p1')).toBeNull();
    expect(screen.queryByTestId('zoomable-photo-p5')).toBeNull();
  });

  it('exposes only the current page to VoiceOver while neighbours preload', async () => {
    await renderViewer({ currentIndex: 1 });

    expect(screen.queryByTestId('photo-viewer-page-p1')).toBeNull();
    expect(screen.queryByTestId('photo-viewer-page-p3')).toBeNull();
    expect(
      screen.getByTestId('photo-viewer-page-p1', { includeHiddenElements: true }).props,
    ).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(screen.getByTestId('photo-viewer-page-p2').props).toMatchObject({
      accessibilityElementsHidden: false,
      importantForAccessibility: 'auto',
    });
    expect(
      screen.getByTestId('photo-viewer-page-p3', { includeHiddenElements: true }).props,
    ).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(
      screen.getByTestId('authenticated-trip-photo:trip-1:p1:medium', {
        includeHiddenElements: true,
      }).props.accessible,
    ).toBe(false);
    expect(screen.getByTestId('authenticated-trip-photo:trip-1:p2:medium').props.accessible).toBe(
      true,
    );
    expect(
      screen.getByTestId('authenticated-trip-photo:trip-1:p3:medium', {
        includeHiddenElements: true,
      }).props.accessible,
    ).toBe(false);
  });

  it('lets only the active page control shared zoom state', () => {
    const handler = jest.fn();

    expect(zoomChangeHandlerForPage('p2', 'p2', handler)).toBe(handler);
    expect(zoomChangeHandlerForPage('p1', 'p2', handler)).toBeUndefined();
    expect(zoomChangeHandlerForPage('p3', 'p2', handler)).toBeUndefined();
  });

  it('dismisses after a downward pager pan crosses the threshold', async () => {
    const onClose = jest.fn();
    await renderViewer({ onClose });

    await act(async () => {
      fireGestureHandler(getByGestureTestId('photo-viewer-dismiss-gesture'), [
        { state: State.BEGAN, translationY: 0 },
        { state: State.ACTIVE, translationY: 160 },
        { state: State.END, translationY: 160 },
      ]);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks parent dismiss while pinch is active and unlocks on finalize', async () => {
    const onClose = jest.fn();
    await renderViewer({ onClose });

    const pinch = getByGestureTestId('photo-pinch-p1') as unknown as {
      config: {
        blocksHandlers?: unknown[];
        simultaneousWith?: unknown[];
      };
      handlers: {
        onBegin?: (event: unknown) => void;
        onFinalize?: (event: unknown, success: boolean) => void;
      };
    };

    expect(pinch.config.blocksHandlers).toHaveLength(2);
    expect(
      pinch.config.blocksHandlers?.some((handler) =>
        pinch.config.simultaneousWith?.includes(handler),
      ),
    ).toBe(false);

    pinch.handlers.onBegin?.({});
    await act(async () => {
      fireGestureHandler(getByGestureTestId('photo-viewer-dismiss-gesture'), [
        { state: State.BEGAN, translationY: 0 },
        { state: State.END, translationY: 160 },
      ]);
    });
    expect(onClose).not.toHaveBeenCalled();

    pinch.handlers.onFinalize?.({}, false);
    await act(async () => {
      fireGestureHandler(getByGestureTestId('photo-viewer-dismiss-gesture'), [
        { state: State.BEGAN, translationY: 0 },
        { state: State.END, translationY: 160 },
      ]);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['CANCEL', 'FAIL'])(
    'rolls back transient pinch scale after %s before the next double tap',
    async () => {
    const onZoomChange = jest.fn();
    await render(<ZoomableGestureProbe onZoomChange={onZoomChange} />);
    onZoomChange.mockClear();

    const pinch = getByGestureTestId('photo-pinch-gesture-probe') as unknown as {
      handlers: {
        onBegin?: (event: unknown) => void;
        onUpdate?: (event: { scale: number }) => void;
        onFinalize?: (event: unknown, success: boolean) => void;
      };
    };
    await act(async () => {
      pinch.handlers.onBegin?.({});
      pinch.handlers.onUpdate?.({ scale: 2 });
      // RNGH supplies `success=false` to onFinalize for both CANCEL and FAIL.
      pinch.handlers.onFinalize?.({}, false);
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(false);

    const doubleTap = getByGestureTestId(
      'photo-double-tap-gesture-probe',
    ) as unknown as {
      handlers: { onEnd?: (event: unknown, success: boolean) => void };
    };
    await act(async () => {
      doubleTap.handlers.onEnd?.({}, true);
    });
    // A cancelled transient 2x scale must have rolled back to 1x. Therefore
    // the next double tap zooms in and hands one-finger drags to zoom-pan.
    expect(onZoomChange).toHaveBeenLastCalledWith(true);
    },
  );

  it('reads Fabric viewport bounds synchronously and subtracts safe areas only in fallback', () => {
    const getBoundingClientRect = jest.fn(() => ({ width: 390, height: 700 }));

    expect(readSynchronousMediaViewport({ getBoundingClientRect })).toEqual({
      width: 390,
      height: 700,
    });
    expect(getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(mediaViewportFallback(430, 932, 59, 34)).toEqual({
      width: 430,
      height: 839,
    });
  });

  it('uses the measured safe media viewport for image size and paging math', async () => {
    const onGoTo = jest.fn();
    await renderViewer({ onGoTo }, { top: 59, bottom: 34, left: 0, right: 0 });

    const viewport = screen.getByTestId('photo-viewer-media-viewport');
    await fireEvent(viewport, 'layout', {
      nativeEvent: { layout: { x: 0, y: 59, width: 390, height: 700 } },
    });

    const viewportStyle = StyleSheet.flatten(viewport.props.style);
    expect(viewportStyle.marginTop).toBe(59);
    expect(viewportStyle.marginBottom).toBe(34);
    expect(screen.getByTestId('authenticated-trip-photo:trip-1:p1:medium').props).toMatchObject({
      width: 390,
      height: 700,
    });

    await fireEvent(screen.getByTestId('photo-viewer-pager'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 390, y: 0 } },
    });
    expect(onGoTo).toHaveBeenCalledWith('p2');
    expect(dismissTranslationForViewport(700)).toBe(105);
  });

  it('uses the medium variant, never the thumbnail', async () => {
    await renderViewer();

    expect(screen.getByTestId('authenticated-trip-photo:trip-1:p1:medium')).toBeTruthy();
    expect(screen.queryByTestId('authenticated-trip-photo:trip-1:p1:thumbnail')).toBeNull();
  });

  it('keeps contain letterboxing dark so the white viewer controls remain visible', async () => {
    await renderViewer();

    expect(
      screen.getByTestId('authenticated-trip-photo:trip-1:p1:medium').props.backgroundColor,
    ).toBe('#000000');
  });

  it('keeps absolute controls outside the status bar and home indicator', async () => {
    await renderViewer({}, { top: 59, bottom: 34, left: 0, right: 0 });

    expect(StyleSheet.flatten(screen.getByTestId('photo-viewer-top-bar').props.style).top).toBe(59);
    expect(
      StyleSheet.flatten(screen.getByTestId('photo-viewer-bottom-stack').props.style).bottom,
    ).toBe(34);
  });

  it('keeps toast and variable-height bottom content in the same safe-area stack', async () => {
    await renderViewer(
      { action: { status: 'message', message: 'Saved to Photos.' } },
      { top: 59, bottom: 34, left: 0, right: 0 },
    );
    const bottomBar = screen.getByTestId('photo-viewer-bottom-bar');
    const bottomStack = screen.getByTestId('photo-viewer-bottom-stack');
    const toast = screen.getByTestId('photo-viewer-toast');

    await fireEvent(bottomBar, 'layout', {
      nativeEvent: { layout: { x: 0, y: 700, width: 430, height: 104 } },
    });
    expect(StyleSheet.flatten(bottomStack.props.style).bottom).toBe(34);
    expect(StyleSheet.flatten(toast.props.style).position).toBeUndefined();
    expect(StyleSheet.flatten(bottomBar.props.style).position).toBeUndefined();
    expect(StyleSheet.flatten(toast.props.style).flexShrink).toBe(0);
    expect(StyleSheet.flatten(bottomBar.props.style).flexShrink).toBe(0);

    await fireEvent(bottomBar, 'layout', {
      nativeEvent: { layout: { x: 0, y: 610, width: 430, height: 194 } },
    });
    expect(StyleSheet.flatten(bottomStack.props.style).bottom).toBe(34);
  });

  it('keeps a long unknown message above the measured controls and announces its real text', async () => {
    const message =
      'This photo may already be saved. Check Photos before trying again because the native result was unknown.';
    await renderViewer(
      { action: { status: 'error', failure: { kind: 'network', message } } },
      { top: 59, bottom: 34, left: 0, right: 0 },
    );

    await fireEvent(screen.getByTestId('photo-viewer-bottom-bar'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 600, width: 430, height: 204 } },
    });

    expect(screen.getByTestId('photo-viewer-toast-message').props.children).toBe(message);
    expect(
      StyleSheet.flatten(screen.getByTestId('photo-viewer-bottom-stack').props.style).bottom,
    ).toBe(34);
    expect(StyleSheet.flatten(screen.getByTestId('photo-viewer-toast').props.style).position).toBeUndefined();
    expect(screen.getByLabelText('Dismiss message')).toBeTruthy();
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

  it('announces the real feedback text and exposes dismissal separately', async () => {
    const onDismissAction = jest.fn();
    await renderViewer({
      action: { status: 'message', message: 'Saved to Photos.' },
      onDismissAction,
    });

    const toast = screen.getByTestId('photo-viewer-toast');
    const message = screen.getByTestId('photo-viewer-toast-message');
    expect(toast.props.accessibilityLabel).toBeUndefined();
    expect(message.props.accessibilityRole).toBe('alert');
    expect(message.props.children).toBe('Saved to Photos.');

    const dismiss = screen.getByLabelText('Dismiss message');
    expect(StyleSheet.flatten(dismiss.props.style)).toMatchObject({ width: 44, height: 44 });
    await fireEvent.press(dismiss);
    expect(onDismissAction).toHaveBeenCalledTimes(1);
  });

  it('offers a separate Settings action when Photos permission cannot be requested again', async () => {
    const onOpenSettings = jest.fn();
    await renderViewer({
      action: { status: 'permissionDenied', canAskAgain: false },
      onOpenSettings,
    });

    expect(screen.getByText('Allow photo access for GoPlan in Settings to save photos.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Open Settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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

    expect(mockDeleteTripPhoto).toHaveBeenCalledWith('trip-1', 'p1', expect.anything());
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

  it('keeps a page-2 photo when an authoritative detail probe says it still exists', async () => {
    mockDeleteTripPhoto.mockRejectedValue(networkFailure());
    const options = hookOptions({
      photos: Array.from({ length: 25 }, (_, index) => photo(`p${index + 1}`)),
    });
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p21');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(mockGetTripPhoto).toHaveBeenCalledWith('trip-1', 'p21', expect.anything());
    expect(options.reconcile).not.toHaveBeenCalled();
    expect(options.removePhoto).not.toHaveBeenCalled();
    expect(result.current.action).toMatchObject({ status: 'error' });
    expect(result.current.action).not.toMatchObject({ status: 'message' });
  });

  it('tombstones a page-2 photo when its detail probe proves the uncertain delete landed', async () => {
    mockDeleteTripPhoto.mockRejectedValue(networkFailure());
    mockGetTripPhoto.mockRejectedValue(
      failure(404, { detail: 'Photo not found.', error_code: 'PHOTO_NOT_FOUND' }),
    );
    const options = hookOptions({
      photos: Array.from({ length: 25 }, (_, index) => photo(`p${index + 1}`)),
    });
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => {
      result.current.open('p21');
    });

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(options.removePhoto).toHaveBeenCalledWith('p21');
    expect(options.reconcile).not.toHaveBeenCalled();
    expect(result.current.openPhotoId).toBeNull();
    expect(result.current.action).toEqual({ status: 'idle' });
  });

  it('falls back to page-1 reconciliation when both delete and detail probe are uncertain', async () => {
    mockDeleteTripPhoto.mockRejectedValue(
      failure(500, { detail: 'Storage error.', error_code: 'PHOTO_STORAGE_ERROR' }),
    );
    mockGetTripPhoto.mockRejectedValue(networkFailure());
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
    expect(result.current.action).toEqual({ status: 'permissionDenied', canAskAgain: true });

    mockSaveTripPhotoToLibrary.mockResolvedValue({ status: 'permissionDenied', canAskAgain: false });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.action).toEqual({ status: 'permissionDenied', canAskAgain: false });
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

  it('hands a trip-terminal save result to the neutral trip owner', async () => {
    const tripFailure = {
      kind: 'notFound' as const,
      message: 'Trip not found.',
      status: 404,
      errorCode: 'TRIP_NOT_FOUND',
    };
    mockSaveTripPhotoToLibrary.mockImplementationOnce(
      async (input: { onTripUnavailable?: (failure: typeof tripFailure) => void }) => {
        input.onTripUnavailable?.(tripFailure);
        return { status: 'cancelled' };
      },
    );
    const options = hookOptions();
    const { result } = await renderHook(() => usePhotoViewer(options));
    await act(async () => result.current.open('p1'));
    await act(async () => result.current.save());

    expect(options.onTripUnavailable).toHaveBeenCalledWith(tripFailure);
    expect(result.current.action).toEqual({ status: 'idle' });
  });

  it('maps an unexpected native rejection and unlocks Save for a retry', async () => {
    mockSaveTripPhotoToLibrary
      .mockRejectedValueOnce(new Error('native bridge failed'))
      .mockResolvedValueOnce({ status: 'saved' });
    const { result } = await renderHook(() => usePhotoViewer(hookOptions()));
    await act(async () => {
      result.current.open('p1');
    });

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.action).toMatchObject({
      status: 'error',
      failure: { kind: 'server' },
    });

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.action).toEqual({ status: 'message', message: 'Saved to Photos.' });
    expect(mockSaveTripPhotoToLibrary).toHaveBeenCalledTimes(2);
  });

  it('closes the single-save gate from the authoritative feed without a rerender', async () => {
    const boundary = createDeferred<void>();
    const wrapperEntered = createDeferred<void>();
    const nativeCommit = jest.fn();
    let tombstoned = false;
    mockSaveTripPhotoToLibrary.mockImplementationOnce(
      async (input: SaveTripPhotoOptions): Promise<SavePhotoOutcome> => {
        wrapperEntered.resolve();
        await boundary.promise;
        if (input.gate?.isTombstoned(input.photoId)) {
          return { status: 'cancelled' };
        }
        nativeCommit();
        return { status: 'saved' };
      },
    );
    const options = hookOptions({
      isPhotoTombstoned: (photoId: string) => tombstoned && photoId === 'p1',
    });
    const view = await renderHook(() => usePhotoViewer(options));
    await act(async () => view.result.current.open('p1'));

    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = view.result.current.save();
      await wrapperEntered.promise;
    });
    const input = mockSaveTripPhotoToLibrary.mock.calls[0][0] as SaveTripPhotoOptions;
    expect(input.gate?.isTombstoned('p1')).toBe(false);

    // This models the producer's synchronous ref/front-half. There is no
    // photos-prop update or layout effect between the two gate reads.
    tombstoned = true;
    expect(input.gate?.isTombstoned('p1')).toBe(true);
    await act(async () => {
      boundary.resolve();
      await savePromise;
    });

    expect(nativeCommit).not.toHaveBeenCalled();
    expect(view.result.current.action).toEqual({ status: 'idle' });
  });

  it('holds Trip B single save behind Trip A native settlement cleanup', async () => {
    const scopeHarness = createViewerScopeHarness();
    const nativeA = createDeferred<SavePhotoOutcome>();
    const nativeAStarted = createDeferred<void>();
    mockSaveTripPhotoToLibrary
      .mockImplementationOnce(() => {
        nativeAStarted.resolve();
        return nativeA.promise;
      })
      .mockResolvedValueOnce({ status: 'saved' });

    const tripAOptions = hookOptions({ scope: scopeHarness.scope });
    const tripA = await renderHook(() => usePhotoViewer(tripAOptions));
    await act(async () => tripA.result.current.open('p1'));
    let savingA!: Promise<void>;
    await act(async () => {
      savingA = tripA.result.current.save();
      await nativeAStarted.promise;
    });

    let cleanupA!: Promise<void>;
    await act(async () => {
      cleanupA = scopeHarness.invalidate('trip-2');
      await Promise.resolve();
    });
    let cleanupSettled = false;
    void cleanupA.then(() => {
      cleanupSettled = true;
    });

    const tripBOptions = hookOptions({
      tripId: 'trip-2',
      scope: scopeHarness.scope,
      photos: [photo('b1')],
    });
    const tripB = await renderHook(() => usePhotoViewer(tripBOptions));
    await act(async () => tripB.result.current.open('b1'));
    let savingB!: Promise<void>;
    await act(async () => {
      savingB = tripB.result.current.save();
      await Promise.resolve();
    });

    expect(cleanupSettled).toBe(false);
    expect(mockSaveTripPhotoToLibrary).toHaveBeenCalledTimes(1);

    await act(async () => {
      nativeA.resolve({ status: 'saved' });
      await Promise.all([savingA, cleanupA, savingB]);
    });

    expect(mockSaveTripPhotoToLibrary).toHaveBeenCalledTimes(2);
    expect(tripB.result.current.action).toEqual({
      status: 'message',
      message: 'Saved to Photos.',
    });
  });

  it('closes the pre-native gate when the current photo is removed during permission', async () => {
    const permissionSettled = createDeferred<void>();
    const wrapperEntered = createDeferred<void>();
    const nativeCommit = jest.fn();
    mockSaveTripPhotoToLibrary.mockImplementationOnce(
      async (input: SaveTripPhotoOptions): Promise<SavePhotoOutcome> => {
        wrapperEntered.resolve();
        await permissionSettled.promise;
        const gate = input.gate;
        if (!gate?.isOpen() || gate.isTombstoned(input.photoId)) {
          return { status: 'cancelled' };
        }
        nativeCommit();
        return { status: 'saved' };
      },
    );
    const options = hookOptions();
    const view = await renderHook(
      ({ photos }: { photos: TripPhoto[] }) =>
        usePhotoViewer({ ...options, photos }),
      { initialProps: { photos: options.photos } },
    );
    await act(async () => view.result.current.open('p1'));

    let savePromise: Promise<void> | undefined;
    await act(async () => {
      savePromise = view.result.current.save();
      await wrapperEntered.promise;
    });
    await view.rerender({ photos: [photo('p2'), photo('p3')] });

    const input = mockSaveTripPhotoToLibrary.mock.calls[0][0] as SaveTripPhotoOptions;
    expect(input.gate?.isOpen()).toBe(true);
    expect(input.gate?.isTombstoned('p1')).toBe(true);

    await act(async () => {
      permissionSettled.resolve();
      await savePromise;
    });

    expect(nativeCommit).not.toHaveBeenCalled();
    expect(view.result.current.action).toEqual({ status: 'idle' });
  });

  it('lets a pending download discard its temp instead of reaching native after removal', async () => {
    const downloadSettled = createDeferred<void>();
    const tempCreated = createDeferred<void>();
    const discardTemp = jest.fn(async () => undefined);
    const nativeCommit = jest.fn();
    mockSaveTripPhotoToLibrary.mockImplementationOnce(
      async (input: SaveTripPhotoOptions): Promise<SavePhotoOutcome> => {
        tempCreated.resolve();
        await downloadSettled.promise;
        const gate = input.gate;
        if (!gate?.isOpen() || gate.isTombstoned(input.photoId)) {
          await discardTemp();
          return { status: 'cancelled' };
        }
        nativeCommit();
        return { status: 'saved' };
      },
    );
    const options = hookOptions();
    const view = await renderHook(
      ({ photos }: { photos: TripPhoto[] }) =>
        usePhotoViewer({ ...options, photos }),
      { initialProps: { photos: options.photos } },
    );
    await act(async () => view.result.current.open('p1'));

    let savePromise: Promise<void> | undefined;
    await act(async () => {
      savePromise = view.result.current.save();
      await tempCreated.promise;
    });
    await view.rerender({ photos: [photo('p2'), photo('p3')] });
    await act(async () => {
      downloadSettled.resolve();
      await savePromise;
    });

    expect(discardTemp).toHaveBeenCalledTimes(1);
    expect(nativeCommit).not.toHaveBeenCalled();
  });

  it.each<{
    label: string;
    outcome: SavePhotoOutcome;
    expectedAction: object;
  }>([
    {
      label: 'committed',
      outcome: { status: 'saved' },
      expectedAction: { status: 'message', message: 'Saved to Photos.' },
    },
    {
      label: 'unknown',
      outcome: {
        status: 'unknown',
        failure: { kind: 'server', message: 'Save may have completed.' },
      },
      expectedAction: {
        status: 'error',
        failure: { kind: 'server', message: 'Save may have completed.' },
      },
    },
  ])('preserves the $label result when removal lands after native starts', async ({
    outcome,
    expectedAction,
  }) => {
    const nativeStarted = createDeferred<void>();
    const nativeResult = createDeferred<SavePhotoOutcome>();
    mockSaveTripPhotoToLibrary.mockImplementationOnce(
      async (_input: SaveTripPhotoOptions): Promise<SavePhotoOutcome> => {
        nativeStarted.resolve();
        return nativeResult.promise;
      },
    );
    const options = hookOptions();
    const view = await renderHook(
      ({ photos }: { photos: TripPhoto[] }) =>
        usePhotoViewer({ ...options, photos }),
      { initialProps: { photos: options.photos } },
    );
    await act(async () => view.result.current.open('p1'));

    let savePromise: Promise<void> | undefined;
    await act(async () => {
      savePromise = view.result.current.save();
      await nativeStarted.promise;
    });
    await view.rerender({ photos: [photo('p2'), photo('p3')] });
    await act(async () => {
      nativeResult.resolve(outcome);
      await savePromise;
    });

    expect(view.result.current.currentPhoto).toBeNull();
    expect(view.result.current.action).toMatchObject(expectedAction);
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

  it('does not reopen a removed id when it is later loaded again', async () => {
    const photos = [photo('p1'), photo('p2')];
    const { result, rerender } = await renderHook(
      (props: { photos: TripPhoto[] }) => usePhotoViewer(hookOptions({ photos: props.photos })),
      { initialProps: { photos } },
    );

    await act(async () => {
      result.current.open('p1');
    });
    await rerender({ photos: [photo('p2')] });
    await waitFor(() => expect(result.current.openPhotoId).toBeNull());

    await rerender({ photos: [photo('p1'), photo('p2')] });
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
