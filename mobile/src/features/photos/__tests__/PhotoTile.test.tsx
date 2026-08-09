const mockAcquireProtectedAsset = jest.fn();

jest.mock('@/shared/media/protectedAssetStore', () => ({
  ...jest.requireActual('@/shared/media/protectedAssetStore'),
  acquireProtectedAsset: (...args: unknown[]) => mockAcquireProtectedAsset(...args),
}));

jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: jest.fn(),
}));

jest.mock('@/shared/media/privateMediaLifecycle', () => ({
  ...jest.requireActual('@/shared/media/privateMediaLifecycle'),
  isPrivateMediaSessionOpen: jest.fn(() => true),
  subscribeToPrivateMediaGeneration: jest.fn(() => () => undefined),
}));

jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return { Image: (props: Record<string, unknown>) => createElement(View, props) };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// eslint-disable-next-line import/first
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ProtectedAssetError } from '@/shared/media/protectedAssetTypes';
// eslint-disable-next-line import/first
import { PhotoTile } from '../components/PhotoTile';

const noop = () => undefined;

function props(overrides: Record<string, unknown> = {}) {
  return {
    tripId: 'trip-1',
    photoId: 'photo-1',
    size: 120,
    thumbnailWidth: 480,
    thumbnailHeight: 360,
    uploaderName: 'Mai',
    onPress: noop,
    onLongPress: noop,
    onAssetNotFound: noop,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquireProtectedAsset.mockResolvedValue({
    uri: 'file:///private/photo.webp',
    release: jest.fn(),
  });
});

it('renders one actionable accessibility node when the real composite is ready', async () => {
  await render(<PhotoTile {...props()} />);
  await waitFor(() => expect(mockAcquireProtectedAsset).toHaveBeenCalledTimes(1));

  const tile = screen.getByLabelText('Open photo uploaded by Mai');
  expect(tile.props.accessibilityRole).toBe('button');
  expect(tile.props.accessibilityActions).toEqual([
    { name: 'toggleSelection', label: 'Select photo' },
  ]);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByRole('image')).toBeNull();
});

it('opens normally and exposes a discoverable Select photo action', async () => {
  const onPress = jest.fn();
  const onLongPress = jest.fn();
  await render(<PhotoTile {...props({ onPress, onLongPress })} />);
  const tile = await screen.findByLabelText('Open photo uploaded by Mai');

  await fireEvent.press(tile);
  expect(onPress).toHaveBeenCalledWith('photo-1');

  await fireEvent(tile, 'accessibilityAction', {
    nativeEvent: { actionName: 'toggleSelection' },
  });
  expect(onLongPress).toHaveBeenCalledWith('photo-1');
});

it('keeps selection tiles actionable and announces selected state and toggle action', async () => {
  const onPress = jest.fn();
  const view = await render(
    <PhotoTile {...props({ selectionMode: true, selected: false, onPress })} />,
  );
  let tile = screen.getByLabelText('Photo uploaded by Mai');

  expect(tile.props.accessibilityRole).toBe('button');
  expect(tile.props.accessibilityState).toEqual({ selected: false });
  expect(tile.props.accessibilityActions).toContainEqual({
    name: 'toggleSelection',
    label: 'Select photo',
  });
  await fireEvent.press(tile);
  expect(onPress).toHaveBeenCalledWith('photo-1');

  await view.rerender(
    <PhotoTile {...props({ selectionMode: true, selected: true, onPress })} />,
  );
  tile = screen.getByLabelText('Photo uploaded by Mai');
  expect(tile.props.accessibilityState).toEqual({ selected: true });
  expect(tile.props.accessibilityActions).toContainEqual({
    name: 'toggleSelection',
    label: 'Deselect photo',
  });

  await fireEvent(tile, 'accessibilityAction', {
    nativeEvent: { actionName: 'toggleSelection' },
  });
  expect(onPress).toHaveBeenCalledTimes(2);
});

it('keeps loading and unavailable states inside the single tile node', async () => {
  let resolveLoad: ((value: { uri: string; release(): void }) => void) | undefined;
  mockAcquireProtectedAsset.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveLoad = resolve;
    }),
  );
  const onAssetNotFound = jest.fn();
  const view = await render(<PhotoTile {...props({ onAssetNotFound })} />);

  expect(screen.getAllByRole('button')).toHaveLength(1);
  await act(async () => {
    resolveLoad?.({ uri: 'file:///private/photo.webp', release: noop });
  });

  mockAcquireProtectedAsset.mockRejectedValueOnce(
    new ProtectedAssetError('notFound', 'Photo not found.', {
      status: 404,
      errorCode: 'PHOTO_NOT_FOUND',
    }),
  );
  await view.rerender(<PhotoTile {...props({ photoId: 'photo-2', onAssetNotFound })} />);
  await waitFor(() => expect(onAssetNotFound).toHaveBeenCalledTimes(1));
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByLabelText('Image unavailable')).toBeNull();
});

it('raises thumbnail retry to the tile without adding a nested VoiceOver stop', async () => {
  mockAcquireProtectedAsset
    .mockRejectedValueOnce(new ProtectedAssetError('network', 'Offline.'))
    .mockResolvedValueOnce({ uri: 'file:///private/retry.webp', release: jest.fn() });
  await render(<PhotoTile {...props()} />);

  await waitFor(() =>
    expect(
      screen.getByLabelText('Open photo uploaded by Mai').props.accessibilityActions,
    ).toContainEqual({ name: 'retryImage', label: 'Retry loading photo' }),
  );
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByLabelText('Retry loading this image')).toBeNull();

  await fireEvent(screen.getByLabelText('Open photo uploaded by Mai'), 'accessibilityAction', {
    nativeEvent: { actionName: 'retryImage' },
  });
  await waitFor(() => expect(mockAcquireProtectedAsset).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByLabelText('Open photo uploaded by Mai').props.accessibilityActions,
    ).not.toContainEqual({ name: 'retryImage', label: 'Retry loading photo' }),
  );
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
