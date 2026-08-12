import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Platform, StyleSheet } from 'react-native';
import { ALLOWED_REACTION_EMOJIS } from '../types';
import { ChatMessageActionsModal } from '../components/ChatMessageActionsModal';
import { REACTION_ACCESSIBILITY_LABELS } from '../components/ChatReactionBar';

jest.mock('@expo/vector-icons', () => ({
  FontAwesome6: () => null,
  Ionicons: () => null,
}));

function props(overrides: Record<string, unknown> = {}) {
  return {
    visible: true,
    currentReaction: null,
    canReact: true,
    canHide: true,
    canDeleteForEveryone: true,
    canSelect: true,
    onClose: jest.fn(),
    onReact: jest.fn(),
    onHide: jest.fn(),
    onDeleteForEveryone: jest.fn(),
    onSelect: jest.fn(),
    ...overrides,
  };
}

describe('ChatMessageActionsModal', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('presents exactly the canonical seven reactions with selected state', async () => {
    await render(<ChatMessageActionsModal {...props({ currentReaction: '😮' })} />);

    const options = ALLOWED_REACTION_EMOJIS.map((emoji) =>
      screen.getByLabelText(`React with ${REACTION_ACCESSIBILITY_LABELS[emoji].toLowerCase()}`),
    );
    expect(options).toHaveLength(7);
    expect(options.map((option) => option.props.accessibilityState.selected)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(options[2]?.props.accessibilityHint).toBe('Removes your reaction');
    expect(options[0]?.props.accessibilityHint).toBe('Adds this reaction');
    expect(
      screen.getByTestId('chat-reaction-option-selected-😮', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-reaction-option-😮').props.style),
    ).toMatchObject({ borderWidth: 2 });
    expect(screen.getByTestId('chat-message-actions-modal').props.accessibilityViewIsModal).toBe(true);
  });

  it('wraps growing reaction controls without shrinking their touch targets', async () => {
    await render(<ChatMessageActionsModal {...props()} />);

    expect(
      StyleSheet.flatten(screen.getByTestId('chat-reaction-options').props.style),
    ).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    for (const emoji of ALLOWED_REACTION_EMOJIS) {
      expect(
        StyleSheet.flatten(screen.getByTestId(`chat-reaction-option-${emoji}`).props.style),
      ).toMatchObject({ minWidth: 44, minHeight: 44 });
    }
  });

  it('closes and dispatches the exact selected reaction', async () => {
    const onClose = jest.fn();
    const onReact = jest.fn();
    await render(<ChatMessageActionsModal {...props({ onClose, onReact })} />);

    await fireEvent.press(screen.getByLabelText('React with heart'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith('❤️');
  });

  it('locks the sheet after its first reaction press to prevent a double mutation', async () => {
    const onClose = jest.fn();
    const onReact = jest.fn();
    await render(<ChatMessageActionsModal {...props({ onClose, onReact })} />);

    const option = screen.getByLabelText('React with heart');
    await fireEvent.press(option);
    await fireEvent.press(option);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith('❤️');
  });

  it('forwards native dismissal so callers can restore accessibility focus after animation', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const onDismiss = jest.fn();
    await render(
      <ChatMessageActionsModal {...props({ onDismiss })} />,
    );

    screen.getByTestId('chat-message-actions-modal').parent?.props.onDismiss?.();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('waits for native onDismiss before completing a normal iOS close', async () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'ios');
    const onDismiss = jest.fn();
    await render(<ChatMessageActionsModal {...props({ onDismiss })} />);

    await fireEvent.press(screen.getByLabelText('Close message actions'));
    jest.runOnlyPendingTimers();
    expect(onDismiss).not.toHaveBeenCalled();

    screen.getByTestId('chat-message-actions-modal').parent?.props.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'requestClose', 'reaction', 'selection'] as const)(
    'completes the Android %s path after the modal host teardown task',
    async (action) => {
      jest.useFakeTimers();
      jest.replaceProperty(Platform, 'OS', 'android');
      const onDismiss = jest.fn();
      await render(<ChatMessageActionsModal {...props({ onDismiss })} />);

      if (action === 'close') {
        await fireEvent.press(screen.getByLabelText('Close message actions'));
      } else if (action === 'requestClose') {
        screen.getByTestId('chat-message-actions-modal').parent?.props
          .onRequestClose?.();
      } else if (action === 'reaction') {
        await fireEvent.press(screen.getByLabelText('React with heart'));
      } else {
        await fireEvent.press(screen.getByLabelText('Select messages'));
      }

      expect(onDismiss).not.toHaveBeenCalled();
      jest.runOnlyPendingTimers();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels a deferred Android dismissal callback when the owner unmounts', async () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    const onDismiss = jest.fn();
    const rendered = await render(
      <ChatMessageActionsModal {...props({ onDismiss })} />,
    );

    await fireEvent.press(screen.getByLabelText('Close message actions'));
    await rendered.unmount();
    jest.runOnlyPendingTimers();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: 'Hide for me',
      title: 'Hide this message?',
      destructiveLabel: 'Hide',
      callback: 'onHide',
    },
    {
      action: 'Remove for everyone',
      title: 'Remove this message for everyone?',
      destructiveLabel: 'Remove',
      callback: 'onDeleteForEveryone',
    },
  ] as const)('confirms $action with a destructive native alert', async (scenario) => {
    jest.useFakeTimers();
    const callback = jest.fn();
    const onClose = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatMessageActionsModal
        {...props({ [scenario.callback]: callback, onClose })}
      />,
    );

    await fireEvent.press(screen.getByLabelText(scenario.action));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    screen.getByTestId('chat-message-actions-modal').parent?.props.onDismiss?.();
    expect(alert).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(alert).toHaveBeenCalledWith(scenario.title, expect.any(String), expect.any(Array));
    const buttons = alert.mock.calls[0]?.[2];
    expect(buttons?.[1]).toMatchObject({
      text: scenario.destructiveLabel,
      style: 'destructive',
    });
    buttons?.[1]?.onPress?.();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('uses a no-focus handoff before opening a native destructive alert', async () => {
    jest.useFakeTimers();
    const onClose = jest.fn();
    const onCloseWithoutFocus = jest.fn();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatMessageActionsModal
        {...props({ onClose, onCloseWithoutFocus })}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Hide for me'));

    expect(onCloseWithoutFocus).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    screen.getByTestId('chat-message-actions-modal').parent?.props.onDismiss?.();
    expect(Alert.alert).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('opens destructive confirmation on Android without waiting for unsupported onDismiss', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const onClose = jest.fn();
    const onDismiss = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatMessageActionsModal {...props({ onClose, onDismiss })} />,
    );

    await fireEvent.press(screen.getByLabelText('Hide for me'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'Hide this message?',
      expect.any(String),
      expect.any(Array),
    );
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('enters bulk selection without treating selection as destructive', async () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<ChatMessageActionsModal {...props({ onSelect, onClose })} />);

    await fireEvent.press(screen.getByLabelText('Select messages'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('removes unavailable and expired mutation controls', async () => {
    await render(
      <ChatMessageActionsModal
        {...props({
          canReact: false,
          canHide: false,
          canDeleteForEveryone: false,
          canSelect: false,
        })}
      />,
    );

    expect(screen.queryByText('React')).toBeNull();
    expect(screen.queryByLabelText('Hide for me')).toBeNull();
    expect(screen.queryByLabelText('Remove for everyone')).toBeNull();
    expect(screen.queryByLabelText('Select messages')).toBeNull();
    expect(screen.getByLabelText('Close message actions')).toBeTruthy();
  });
});
