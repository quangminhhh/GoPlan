const mockUseTripPhotos = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ tripId: 'trip-1' }),
}));

jest.mock('../hooks/useTripPhotos', () => ({
  useTripPhotos: (...args: unknown[]) => mockUseTripPhotos(...args),
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
    tripNotFound: false,
    loadFirstPage: jest.fn(async () => undefined),
    loadMore: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => undefined),
    prependUploaded: jest.fn(),
    removePhoto: jest.fn(),
    markPhotoStale: jest.fn(),
    handleAssetNotFound: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('passes the route trip id to the hook', async () => {
  mockUseTripPhotos.mockReturnValue(hookState());
  await render(<PhotosScreen />);

  expect(mockUseTripPhotos).toHaveBeenCalledWith('trip-1');
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
