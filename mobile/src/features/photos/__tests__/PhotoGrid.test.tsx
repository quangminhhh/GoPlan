jest.mock('@/shared/media/AuthenticatedImage', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return {
    AuthenticatedImage: (props: Record<string, unknown>) =>
      createElement(View, { ...props, testID: `authenticated-${String(props.assetKey)}` }),
  };
});

// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { StyleSheet, useWindowDimensions } from 'react-native';
// eslint-disable-next-line import/first
import { PHOTO_GRID_GAP, PHOTO_GRID_MIN_COLUMNS } from '../constants';
// eslint-disable-next-line import/first
import { computePhotoGridLayout, PhotoGrid } from '../components/PhotoGrid';
// eslint-disable-next-line import/first
import type { TripPhoto } from '../types';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

const mockUseWindowDimensions = useWindowDimensions as jest.MockedFunction<
  typeof useWindowDimensions
>;

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

const noop = () => undefined;

async function renderGrid(photos: TripPhoto[], overrides: Record<string, unknown> = {}) {
  return render(
    <PhotoGrid
      tripId="trip-1"
      photos={photos}
      refreshing={false}
      loadingMore={false}
      hasNextPage={false}
      pageError={null}
      onRefresh={noop}
      onEndReached={noop}
      onRetryPage={noop}
      onPhotoPress={noop}
      onAssetNotFound={noop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  mockUseWindowDimensions.mockReturnValue({ width: 375, height: 812, scale: 3, fontScale: 1 });
});

describe('computePhotoGridLayout', () => {
  it('gives three columns that fit at the narrowest supported width', () => {
    const { columnCount, tileSize } = computePhotoGridLayout(375);

    expect(columnCount).toBe(3);
    // Three tiles plus two gaps must not exceed the viewport.
    expect(tileSize * columnCount + PHOTO_GRID_GAP * (columnCount - 1)).toBeLessThanOrEqual(375);
  });

  it('adds columns on a wider viewport but never drops below the floor', () => {
    expect(computePhotoGridLayout(768).columnCount).toBe(6);
    expect(computePhotoGridLayout(1024).columnCount).toBe(9);
    expect(computePhotoGridLayout(200).columnCount).toBe(PHOTO_GRID_MIN_COLUMNS);
  });

  it.each([320, 375, 390, 430, 768])('never overflows at %i pt', (width) => {
    const { columnCount, tileSize } = computePhotoGridLayout(width);
    expect(tileSize * columnCount + PHOTO_GRID_GAP * (columnCount - 1)).toBeLessThanOrEqual(width);
    expect(tileSize).toBeGreaterThan(0);
  });
});

describe('PhotoGrid', () => {
  it('renders a square tile per photo and requests only the thumbnail variant', async () => {
    await renderGrid([photo('p1'), photo('p2')]);

    const tile = screen.getByTestId('authenticated-trip-photo:trip-1:p1:thumbnail');
    expect(tile.props.path).toBe('/trips/trip-1/photos/p1/thumbnail');
    expect(tile.props.width).toBe(tile.props.height);
    // A medium variant in the grid is a delayed, device-only memory problem.
    expect(screen.queryByTestId('authenticated-trip-photo:trip-1:p1:medium')).toBeNull();
  });

  it('reserves the tile before the asset resolves and passes the thumbnail dimensions', async () => {
    await renderGrid([photo('p1')]);

    const tile = screen.getByTestId('authenticated-trip-photo:trip-1:p1:thumbnail');
    const { tileSize } = computePhotoGridLayout(375);
    expect(tile.props.width).toBe(tileSize);
    expect(tile.props.sourceWidth).toBe(480);
    expect(tile.props.sourceHeight).toBe(360);
  });

  it('labels each tile with the uploader for VoiceOver', async () => {
    await renderGrid([photo('p1')]);

    expect(screen.getByLabelText('Open photo uploaded by Mai')).toBeTruthy();
  });

  it('opens a photo on tap', async () => {
    const onPhotoPress = jest.fn();
    await renderGrid([photo('p1')], { onPhotoPress });

    await fireEvent.press(screen.getByTestId('photo-tile-p1'));

    expect(onPhotoPress).toHaveBeenCalledWith('p1');
  });

  it('shows a paging spinner while the next page loads', async () => {
    await renderGrid([photo('p1')], { loadingMore: true, hasNextPage: true });

    expect(screen.getByTestId('photo-grid-loading-more')).toBeTruthy();
  });

  it('offers a footer retry on a page failure without discarding loaded photos', async () => {
    const onRetryPage = jest.fn();
    await renderGrid([photo('p1')], {
      pageError: { kind: 'server', message: 'Could not load more photos.' },
      onRetryPage,
    });

    expect(screen.getByTestId('photo-grid-page-error')).toBeTruthy();
    expect(screen.getByText('Could not load more photos.')).toBeTruthy();
    expect(screen.getByTestId('photo-tile-p1')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Retry loading more photos'));
    expect(onRetryPage).toHaveBeenCalledTimes(1);
  });

  it('recomputes the tile size when the viewport width changes', async () => {
    // FlatList renders a ScrollView, so `numColumns` is not readable off the
    // host element. The observable consequence is the tile size, which is also
    // the thing that would break layout if the recompute were missed. The list
    // `key` derived from the column count is what lets RN apply the new value at
    // all — it refuses to change `numColumns` on a mounted list.
    const view = await renderGrid([photo('p1')]);
    const narrowTile = screen.getByTestId('authenticated-trip-photo:trip-1:p1:thumbnail').props.width;
    expect(narrowTile).toBe(computePhotoGridLayout(375).tileSize);

    mockUseWindowDimensions.mockReturnValue({ width: 768, height: 1024, scale: 2, fontScale: 1 });
    await view.rerender(
      <PhotoGrid
        tripId="trip-1"
        photos={[photo('p1')]}
        refreshing={false}
        loadingMore={false}
        hasNextPage={false}
        pageError={null}
        onRefresh={noop}
        onEndReached={noop}
        onRetryPage={noop}
        onPhotoPress={noop}
        onAssetNotFound={noop}
      />,
    );

    const wideTile = screen.getByTestId('authenticated-trip-photo:trip-1:p1:thumbnail').props.width;
    expect(wideTile).toBe(computePhotoGridLayout(768).tileSize);
    expect(wideTile).not.toBe(narrowTile);
  });

  it('adds the measured selection overlay height below the final row', async () => {
    await renderGrid([photo('p1')], { bottomInset: 142 });

    const style = StyleSheet.flatten(screen.getByTestId('photo-grid').props.contentContainerStyle);
    expect(style.paddingBottom).toBeGreaterThan(142);
  });
});
