import { fireEvent, render, screen } from '@testing-library/react-native';
import { PhotoSelectionBar } from '../components/PhotoSelectionBar';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const noop = () => undefined;

it('reports its real dynamic height so the grid can clear the absolute overlay', async () => {
  const onHeightChange = jest.fn();
  await render(
    <PhotoSelectionBar
      selectedCount={2}
      hasNextPage
      download={{ status: 'downloading', bytesWritten: 10, totalBytes: 100 }}
      onSelectLoaded={noop}
      onClear={noop}
      onExit={noop}
      onDownload={noop}
      onCancelDownload={noop}
      onHeightChange={onHeightChange}
    />,
  );

  await fireEvent(screen.getByTestId('photo-selection-bar'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 430, height: 142 } },
  });

  expect(onHeightChange).toHaveBeenCalledWith(142);
  expect(screen.getByLabelText('Cancel download')).toBeTruthy();
  expect(screen.getByLabelText('Select loaded photos').props.accessibilityState.disabled).toBe(
    true,
  );
  expect(screen.getByLabelText('Clear selection').props.accessibilityState.disabled).toBe(true);
});
