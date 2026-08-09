import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import { ChatSelectionToolbar } from '../components/ChatSelectionToolbar';

describe('ChatSelectionToolbar', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms bulk hide as a destructive, irreversible operation', async () => {
    const onConfirmHide = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatSelectionToolbar
        selectedCount={2}
        feedback={null}
        onCancel={() => undefined}
        onConfirmHide={onConfirmHide}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Hide selected messages'));
    expect(alert).toHaveBeenCalledWith(
      'Hide 2 messages?',
      'They will disappear only from your chat history. This cannot be undone.',
      expect.any(Array),
    );
    const buttons = alert.mock.calls[0]?.[2];
    expect(buttons?.[1]?.style).toBe('destructive');
    buttons?.[1]?.onPress?.();
    expect(onConfirmHide).toHaveBeenCalledTimes(1);
  });

  it('announces the selection cap and any attempted overflow feedback', async () => {
    await render(
      <ChatSelectionToolbar
        selectedCount={100}
        feedback="You can select up to 100 messages at once."
        onCancel={() => undefined}
        onConfirmHide={() => undefined}
      />,
    );

    expect(screen.getByText('100 selected (maximum)')).toBeTruthy();
    const feedback = screen.getByText('You can select up to 100 messages at once.');
    expect(feedback.props.accessibilityRole).toBe('alert');
    expect(feedback.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText('You can hide up to 100 messages at a time.')).toBeTruthy();
  });

  it('keeps the count and actions in responsive rows for Dynamic Type', async () => {
    await render(
      <ChatSelectionToolbar
        selectedCount={100}
        feedback={null}
        onCancel={() => undefined}
        onConfirmHide={() => undefined}
      />,
    );

    expect(
      StyleSheet.flatten(screen.getByTestId('chat-selection-summary').props.style),
    ).toMatchObject({ minHeight: 44 });
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-selection-actions').props.style),
    ).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', minHeight: 44 });
    expect(
      StyleSheet.flatten(screen.getByLabelText('Cancel message selection').props.style),
    ).toMatchObject({ minWidth: 44, minHeight: 44 });
    expect(
      StyleSheet.flatten(screen.getByLabelText('Hide selected messages').props.style),
    ).toMatchObject({ minWidth: 44, minHeight: 44 });
  });

  it('disables actions while a hide is running and allows cancellation otherwise', async () => {
    const onCancel = jest.fn();
    const view = await render(
      <ChatSelectionToolbar
        selectedCount={1}
        feedback={null}
        hiding
        onCancel={onCancel}
        onConfirmHide={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Hide selected messages').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    expect(screen.getByLabelText('Cancel message selection').props.accessibilityState.disabled).toBe(true);

    await view.rerender(
      <ChatSelectionToolbar
        selectedCount={1}
        feedback={null}
        onCancel={onCancel}
        onConfirmHide={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Cancel message selection'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
