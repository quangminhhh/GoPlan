import { fireEvent, render, screen } from '@testing-library/react-native';
import { PhotoSelectionBar } from '../components/PhotoSelectionBar';
import type { SelectedSaveSnapshot } from '../selectedPhotoSaveSession';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const noop = () => undefined;

function snapshot(overrides: Partial<SelectedSaveSnapshot> = {}): SelectedSaveSnapshot {
  return {
    phase: 'running',
    stage: 'saving',
    total: 40,
    currentOrdinal: 12,
    counts: {
      committed: 11,
      terminalSkipped: 0,
      retryableFailed: 0,
      unknown: 0,
      unattempted: 29,
    },
    ledger: [],
    failure: null,
    permissionDenied: null,
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    selectedCount: 2,
    loadedCount: 20,
    saveSnapshot: null,
    feedback: null,
    onSelectLoaded: noop,
    onClear: noop,
    onExit: noop,
    onSave: noop,
    onCancelSave: noop,
    ...overrides,
  };
}

it('reports its dynamic height and exposes exact native-save progress', async () => {
  const onHeightChange = jest.fn();
  const onCancelSave = jest.fn();
  await render(
    <PhotoSelectionBar
      {...props({ saveSnapshot: snapshot(), onHeightChange, onCancelSave })}
    />,
  );

  await fireEvent(screen.getByTestId('photo-selection-bar'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 430, height: 142 } },
  });

  expect(onHeightChange).toHaveBeenCalledWith(142);
  expect(screen.getByText('Saving 12 of 40')).toBeTruthy();
  expect(screen.getByLabelText('Select all loaded').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByLabelText('Cancel saving photos'));
  expect(onCancelSave).toHaveBeenCalledTimes(1);
});

it('uses truthful loaded/cap copy and preserves the 100-photo guard', async () => {
  const view = await render(<PhotoSelectionBar {...props()} />);
  expect(screen.getByLabelText('Select all loaded')).toBeTruthy();
  expect(screen.getByText('You can save up to 100 photos at a time.')).toBeTruthy();

  await view.rerender(
    <PhotoSelectionBar {...props({ loadedCount: 140, selectedCount: 20 })} />,
  );
  expect(screen.getByLabelText('Select up to 100')).toBeTruthy();

  await view.rerender(
    <PhotoSelectionBar {...props({ loadedCount: 140, selectedCount: 100 })} />,
  );
  expect(screen.getByText('100 selected (maximum)')).toBeTruthy();
  expect(screen.getByLabelText('Select up to 100').props.accessibilityState.disabled).toBe(true);
});

it('offers Settings only when Photos permission cannot be requested again', async () => {
  const onOpenSettings = jest.fn();
  await render(
    <PhotoSelectionBar
      {...props({
        saveSnapshot: snapshot({
          phase: 'completed',
          stage: null,
          currentOrdinal: null,
          permissionDenied: { canAskAgain: false },
        }),
        onOpenSettings,
      })}
    />,
  );

  await fireEvent.press(screen.getByLabelText('Open Settings'));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Retry')).toBeTruthy();
});

it('announces the actual result text rather than a generic label', async () => {
  await render(
    <PhotoSelectionBar
      {...props({
        feedback: {
          kind: 'error',
          message: 'This photo may already be saved. Check Photos before trying again.',
        },
      })}
    />,
  );

  const notice = screen.getByTestId('photo-selection-notice');
  expect(notice.props.accessibilityRole).toBe('alert');
  expect(notice.props.children).toContain('Check Photos');
});

it('never labels an action Retry when the result contains an unknown native outcome', async () => {
  await render(
    <PhotoSelectionBar
      {...props({
        selectedCount: 1,
        saveSnapshot: snapshot({
          phase: 'completed',
          stage: null,
          currentOrdinal: null,
          counts: {
            committed: 0,
            terminalSkipped: 0,
            retryableFailed: 0,
            unknown: 1,
            unattempted: 1,
          },
        }),
      })}
    />,
  );

  expect(screen.queryByLabelText('Retry')).toBeNull();
  expect(screen.getByLabelText('Save remaining')).toBeTruthy();
});
