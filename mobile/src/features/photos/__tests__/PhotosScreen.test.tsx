const mockUseTripPhotos = jest.fn();
const mockUsePhotoUpload = jest.fn();
const mockUsePhotoViewer = jest.fn();
const mockUsePhotoSelection = jest.fn();
const mockPhotoScope = {
  capture: () => ({ tripId: 'trip-1', generation: 0 }),
  isCurrent: () => true,
  subscribeInvalidation: () => () => undefined,
  waitForCleanup: async () => undefined,
};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ tripId: 'trip-1' }),
  Stack: {
    Screen: (props: unknown) => {
      const { options } = props as { options?: { headerRight?: () => null } };
      return options?.headerRight?.() ?? null;
    },
  },
}));

jest.mock('../hooks/usePhotoUpload', () => ({
  usePhotoUpload: (...args: unknown[]) => mockUsePhotoUpload(...args),
}));

jest.mock('../hooks/useTripPhotos', () => ({
  useTripPhotos: (...args: unknown[]) => mockUseTripPhotos(...args),
}));

jest.mock('../hooks/usePhotoViewer', () => ({
  usePhotoViewer: (...args: unknown[]) => mockUsePhotoViewer(...args),
}));

jest.mock('../hooks/usePhotoSelection', () => ({
  usePhotoSelection: (...args: unknown[]) => mockUsePhotoSelection(...args),
}));

jest.mock('../hooks/useTripPhotoScope', () => ({
  useTripPhotoScope: () => mockPhotoScope,
}));

jest.mock('@/shared/media/AuthenticatedImage', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return {
    AuthenticatedImage: (props: Record<string, unknown>) =>
      createElement(View, { testID: `authenticated-${String(props.assetKey)}` }),
  };
});

jest.mock('@/shared/ui/LoadingScreen', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return { LoadingScreen: () => createElement(View, { testID: 'loading-screen' }) };
});

// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { PhotosScreen } from '../screens/PhotosScreen';
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

function hookState(overrides: Record<string, unknown> = {}) {
  return {
    photos: [],
    status: 'ready',
    error: null,
    errorSource: null,
    refreshing: false,
    loadingMore: false,
    hasNextPage: false,
    tombstonedPhotoIds: new Set<string>(),
    tripNotFound: false,
    loadFirstPage: jest.fn(async () => undefined),
    loadMore: jest.fn(async () => undefined),
    retryLoadMore: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => undefined),
    prependUploaded: jest.fn(),
    removePhoto: jest.fn(),
    markPhotoStale: jest.fn(),
    resolveAssetNotFound: jest.fn(async () => 'unknown'),
    handleAssetNotFound: jest.fn(),
    ...overrides,
  };
}

function uploadState(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: null,
    isOpen: false,
    picking: false,
    pickFailure: null,
    pick: jest.fn(async () => undefined),
    dismissPickFailure: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

function viewerState(overrides: Record<string, unknown> = {}) {
  return {
    openPhotoId: null,
    currentIndex: -1,
    currentPhoto: null,
    action: { status: 'idle' },
    open: jest.fn(),
    close: jest.fn(),
    goTo: jest.fn(),
    goToOffset: jest.fn(),
    confirmDelete: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined),
    dismissAction: jest.fn(),
    ...overrides,
  };
}

function selectionState(overrides: Record<string, unknown> = {}) {
  return {
    selectionMode: false,
    selectedIds: [],
    selectedCount: 0,
    saveSnapshot: null,
    feedback: null,
    enterSelectionMode: jest.fn(),
    enterSelection: jest.fn(),
    toggle: jest.fn(),
    isSelected: jest.fn(() => false),
    selectLoaded: jest.fn(),
    clear: jest.fn(),
    exit: jest.fn(),
    startSave: jest.fn(async () => undefined),
    cancelSave: jest.fn(),
    dismissFeedback: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePhotoUpload.mockReturnValue(uploadState());
  mockUsePhotoViewer.mockReturnValue(viewerState());
  mockUsePhotoSelection.mockReturnValue(selectionState());
});

it('passes the route trip id to the hook', async () => {
  mockUseTripPhotos.mockReturnValue(hookState());
  await render(<PhotosScreen />);

  expect(mockUseTripPhotos).toHaveBeenCalledWith('trip-1', mockPhotoScope);
  expect(mockUsePhotoUpload.mock.calls[0][0]).toMatchObject({
    tripId: 'trip-1',
    scope: mockPhotoScope,
  });
});

it('shows the loading screen on a first load with nothing to show', async () => {
  mockUseTripPhotos.mockReturnValue(hookState({ status: 'loading' }));
  await render(<PhotosScreen />);

  expect(screen.getByTestId('loading-screen')).toBeTruthy();
});

it('shows the empty state when the trip has no photos yet', async () => {
  mockUseTripPhotos.mockReturnValue(hookState());
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-empty')).toBeTruthy();
  expect(screen.getByText('No photos yet')).toBeTruthy();
  expect(screen.queryByLabelText('Select photos')).toBeNull();
});

it('offers a retry when the first load failed', async () => {
  const loadFirstPage = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(
    hookState({
      status: 'error',
      errorSource: 'initial',
      error: { kind: 'server', message: 'Could not load photos.' },
      loadFirstPage,
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByText('Could not load photos.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Retry loading photos'));
  expect(loadFirstPage).toHaveBeenCalledWith('initial');
});

it('shows a neutral not-found that reveals nothing about membership', async () => {
  mockUseTripPhotos.mockReturnValue(hookState({ tripNotFound: true, status: 'error' }));
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-trip-not-found')).toBeTruthy();
  expect(screen.getByText('Trip not found.')).toBeTruthy();
  // No retry: retrying cannot make an unreadable trip readable, and offering it
  // would hint that the trip exists.
  expect(screen.queryByLabelText('Retry loading photos')).toBeNull();
});

it('renders the grid and keeps photos while a background refresh fails', async () => {
  mockUseTripPhotos.mockReturnValue(
    hookState({
      photos: [photo('p1'), photo('p2')],
      errorSource: 'background',
      error: { kind: 'network', message: 'Cannot reach the server.' },
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photo-grid')).toBeTruthy();
  expect(screen.getByTestId('photo-tile-p1')).toBeTruthy();
  expect(screen.getByTestId('photos-inline-error')).toBeTruthy();
  expect(screen.getByText('Cannot reach the server.')).toBeTruthy();
});

it('keeps an empty gallery refreshable when a background reconcile fails', async () => {
  const loadFirstPage = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(
    hookState({
      errorSource: 'background',
      error: { kind: 'network', message: 'Cannot reach the server.' },
      loadFirstPage,
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-empty')).toBeTruthy();
  expect(screen.getByTestId('photo-grid')).toBeTruthy();
  expect(screen.getByTestId('photos-inline-error')).toBeTruthy();

  screen.getByTestId('photo-grid').props.refreshControl.props.onRefresh();
  expect(loadFirstPage).toHaveBeenCalledWith('refresh');
});

it('renders viewer and stale-selection feedback after their modal UI closes', async () => {
  const dismissViewer = jest.fn();
  mockUseTripPhotos.mockReturnValue(hookState());
  mockUsePhotoViewer.mockReturnValue(
    viewerState({
      action: { status: 'message', message: 'Photo deleted.' },
      dismissAction: dismissViewer,
    }),
  );
  const first = await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-feedback-toast')).toBeTruthy();
  expect(screen.getByText('Photo deleted.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Dismiss message'));
  expect(dismissViewer).toHaveBeenCalledTimes(1);

  const dismissSelection = jest.fn();
  mockUsePhotoViewer.mockReturnValue(viewerState());
  mockUsePhotoSelection.mockReturnValue(
    selectionState({
      feedback: {
        kind: 'message',
        message: 'Some selected photos are no longer available.',
      },
      dismissFeedback: dismissSelection,
    }),
  );
  await first.rerender(<PhotosScreen />);

  expect(screen.getByText('Some selected photos are no longer available.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Dismiss message'));
  expect(dismissSelection).toHaveBeenCalledTimes(1);
});

it('shows and dismisses a picker failure without opening an upload sheet', async () => {
  const dismissPickFailure = jest.fn();
  mockUseTripPhotos.mockReturnValue(hookState());
  mockUsePhotoUpload.mockReturnValue(
    uploadState({
      pickFailure: { kind: 'server', message: 'Something went wrong. Please try again.' },
      dismissPickFailure,
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-feedback-toast')).toBeTruthy();
  expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
  expect(screen.queryByTestId('photo-upload-sheet')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Dismiss message'));
  expect(dismissPickFailure).toHaveBeenCalledTimes(1);
});

it('routes a page failure to the footer instead of the banner', async () => {
  mockUseTripPhotos.mockReturnValue(
    hookState({
      photos: [photo('p1')],
      errorSource: 'loadMore',
      error: { kind: 'server', message: 'Could not load more photos.' },
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photo-grid-page-error')).toBeTruthy();
  expect(screen.queryByTestId('photos-inline-error')).toBeNull();
});

it('offers an upload affordance from the empty state', async () => {
  const pick = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(hookState());
  mockUsePhotoUpload.mockReturnValue(uploadState({ pick }));
  await render(<PhotosScreen />);

  await fireEvent.press(screen.getByText('Upload photos'));

  expect(pick).toHaveBeenCalledTimes(1);
});

it('keeps retained selection controls reachable when the gallery becomes empty', async () => {
  const pick = jest.fn(async () => undefined);
  const exit = jest.fn();
  const startSave = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(hookState());
  mockUsePhotoUpload.mockReturnValue(uploadState({ pick }));
  mockUsePhotoSelection.mockReturnValue(
    selectionState({
      selectionMode: true,
      selectedIds: ['p1'],
      selectedCount: 1,
      saveSnapshot: {
        phase: 'completed',
        stage: null,
        total: 1,
        currentOrdinal: null,
        counts: {
          committed: 0,
          terminalSkipped: 0,
          retryableFailed: 0,
          unknown: 0,
          unattempted: 1,
        },
        ledger: [{ photoId: 'p1', status: 'unattempted' }],
        failure: null,
        permissionDenied: { canAskAgain: false },
      },
      exit,
      startSave,
    }),
  );
  await render(<PhotosScreen />);

  expect(screen.getByTestId('photos-empty')).toBeTruthy();
  expect(screen.getByTestId('photo-selection-bar')).toBeTruthy();
  const uploadActions = screen.getAllByLabelText('Upload photos');
  expect(uploadActions).toHaveLength(2);
  for (const upload of uploadActions) {
    expect(upload.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(upload);
  }
  await fireEvent.press(screen.getByLabelText('Retry'));
  await fireEvent.press(screen.getByLabelText('Exit selection'));

  expect(pick).not.toHaveBeenCalled();
  expect(startSave).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledTimes(1);
});

it('offers Select in the header and enters selection mode without preselecting a photo', async () => {
  const enterSelectionMode = jest.fn();
  const enterSelection = jest.fn();
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoSelection.mockReturnValue(
    selectionState({ enterSelectionMode, enterSelection }),
  );
  await render(<PhotosScreen />);

  await fireEvent.press(screen.getByLabelText('Select photos'));

  expect(enterSelectionMode).toHaveBeenCalledTimes(1);
  expect(enterSelection).not.toHaveBeenCalled();
});

it('keeps long press as a shortcut that selects the pressed tile', async () => {
  const enterSelection = jest.fn();
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoSelection.mockReturnValue(selectionState({ enterSelection }));
  await render(<PhotosScreen />);

  await fireEvent(screen.getByTestId('photo-tile-p1'), 'longPress');

  expect(enterSelection).toHaveBeenCalledWith('p1');
});

it('keeps Upload disabled in selection mode before a save starts', async () => {
  const pick = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoUpload.mockReturnValue(uploadState({ pick }));
  mockUsePhotoSelection.mockReturnValue(
    selectionState({
      selectionMode: true,
      selectedIds: ['p1'],
      selectedCount: 1,
      saveSnapshot: null,
    }),
  );
  await render(<PhotosScreen />);

  const upload = screen.getByLabelText('Upload photos');
  expect(upload.props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(upload);

  expect(pick).not.toHaveBeenCalled();
});

it('keeps Upload disabled throughout an active selection save', async () => {
  const pick = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoUpload.mockReturnValue(uploadState({ pick }));
  mockUsePhotoSelection.mockReturnValue(
    selectionState({
      selectionMode: true,
      selectedIds: ['p1'],
      selectedCount: 1,
      saveSnapshot: {
        phase: 'running',
        stage: 'saving',
        total: 1,
        currentOrdinal: 1,
        counts: {
          committed: 0,
          terminalSkipped: 0,
          retryableFailed: 0,
          unknown: 0,
          unattempted: 1,
        },
        ledger: [{ photoId: 'p1', status: 'unattempted' }],
        failure: null,
        permissionDenied: null,
      },
    }),
  );
  await render(<PhotosScreen />);

  const upload = screen.getByLabelText('Upload photos');
  expect(upload.props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(upload);

  expect(pick).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Select photos')).toBeNull();
});

it('disables selection entry while an upload session owns the photo surface', async () => {
  const enterSelectionMode = jest.fn();
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoUpload.mockReturnValue(
    uploadState({
      snapshot: {
        phase: 'selected',
        items: [],
        selectedCount: 1,
        processedCount: 0,
        uploadedCount: 0,
        rejectedCount: 0,
        pendingCount: 1,
        unknownCount: 0,
        failedCount: 0,
        batchesUploaded: 0,
        activePreparation: null,
        activeBatch: null,
        stopping: false,
        error: null,
      },
    }),
  );
  mockUsePhotoSelection.mockReturnValue(selectionState({ enterSelectionMode }));
  await render(<PhotosScreen />);

  const select = screen.getByLabelText('Select photos');
  expect(select.props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(select);

  expect(enterSelectionMode).not.toHaveBeenCalled();
});

it('shows the upload sheet once a selection exists', async () => {
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')] }));
  mockUsePhotoUpload.mockReturnValue(
    uploadState({
      isOpen: true,
      snapshot: {
        phase: 'selected',
        items: [],
        selectedCount: 12,
        processedCount: 0,
        uploadedCount: 0,
        rejectedCount: 0,
        pendingCount: 12,
        unknownCount: 0,
        failedCount: 0,
        batchesUploaded: 0,
        activePreparation: null,
        activeBatch: null,
        stopping: false,
        error: null,
      },
    }),
  );

  await render(<PhotosScreen />);

  expect(screen.getByTestId('photo-upload-sheet')).toBeTruthy();
  expect(screen.getByText('12 selected')).toBeTruthy();
  // Nothing is uploaded until the user says so.
  expect(screen.getByLabelText('Start upload')).toBeTruthy();
});

it('feeds uploaded photos into the grid and reconciles on an uncertain outcome', async () => {
  const prependUploaded = jest.fn();
  const reconcile = jest.fn(async () => undefined);
  mockUseTripPhotos.mockReturnValue(hookState({ photos: [photo('p1')], prependUploaded, reconcile }));
  await render(<PhotosScreen />);

  const options = mockUsePhotoUpload.mock.calls[0][0] as {
    tripId: string;
    onUploaded: (photos: unknown[]) => void;
    onReconcile: () => void;
  };
  expect(options.tripId).toBe('trip-1');

  options.onUploaded([photo('new')]);
  expect(prependUploaded).toHaveBeenCalledWith([photo('new')]);

  options.onReconcile();
  expect(reconcile).toHaveBeenCalledTimes(1);
});
