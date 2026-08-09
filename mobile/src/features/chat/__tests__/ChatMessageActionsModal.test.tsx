import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import { ALLOWED_REACTION_EMOJIS } from '../types';
import { ChatMessageActionsModal } from '../components/ChatMessageActionsModal';
import { REACTION_ACCESSIBILITY_LABELS } from '../components/ChatReactionBar';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

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
    expect(alert).toHaveBeenCalledWith(scenario.title, expect.any(String), expect.any(Array));
    const buttons = alert.mock.calls[0]?.[2];
    expect(buttons?.[1]).toMatchObject({
      text: scenario.destructiveLabel,
      style: 'destructive',
    });
    buttons?.[1]?.onPress?.();
    expect(callback).toHaveBeenCalledTimes(1);
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
