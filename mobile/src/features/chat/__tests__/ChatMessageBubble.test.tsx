import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ChatMessage } from '../types';
import { ChatMessageBubble } from '../components/ChatMessageBubble';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/features/auth/components/UserAvatar', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    UserAvatar: (props: { accessibilityLabel: string }) =>
      React.createElement(View, {
        accessibilityRole: 'image',
        accessibilityLabel: props.accessibilityLabel,
      }),
  };
});

const currentUserId = 'user-me';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    trip_id: 'trip-1',
    sender: {
      id: 'user-other',
      display_name: 'Mai',
      identify_tag: '@mai',
      avatar_url: null,
    },
    sender_kind: 'USER',
    ai_status: null,
    content: 'Hello from the trip',
    client_message_id: null,
    created_at: '2026-08-09T08:30:00.000Z',
    updated_at: '2026-08-09T08:30:00.000Z',
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: null,
    can_delete_for_everyone: false,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    message: message(),
    currentUserId,
    isOwn: false,
    showSender: true,
    showAvatar: true,
    showMeta: true,
    pending: false,
    failed: false,
    failure: null,
    deleting: false,
    reactionBusy: false,
    actionsEnabled: true,
    selectionMode: false,
    selected: false,
    onOpenActions: jest.fn(),
    onToggleSelection: jest.fn(),
    onRetry: jest.fn(),
    onToggleReaction: jest.fn(),
    ...overrides,
  };
}

describe('ChatMessageBubble', () => {
  it('renders sender identity and exposes long-press plus a discoverable accessibility action', async () => {
    const onOpenActions = jest.fn();
    await render(<ChatMessageBubble {...props({ onOpenActions })} />);

    expect(screen.getByText('Mai')).toBeTruthy();
    expect(screen.getByText('@mai')).toBeTruthy();
    expect(screen.getByLabelText("Mai's profile picture")).toBeTruthy();
    const bubble = screen.getByTestId('chat-message-message-1');
    expect(bubble.props.accessibilityActions).toEqual([
      { name: 'openMessageActions', label: 'Open message actions' },
    ]);

    await fireEvent(bubble, 'longPress');
    expect(onOpenActions).toHaveBeenCalledWith('message-1');
    await fireEvent(bubble, 'accessibilityAction', {
      nativeEvent: { actionName: 'openMessageActions' },
    });
    expect(onOpenActions).toHaveBeenCalledTimes(2);
  });

  it('labels own messages as You and keeps the content readable', async () => {
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            sender: {
              id: currentUserId,
              display_name: 'Quang Minh',
              identify_tag: '@quangminh',
              avatar_url: null,
            },
          }),
          isOwn: true,
          showSender: false,
          showAvatar: false,
        })}
      />,
    );

    expect(screen.getByText('Hello from the trip')).toBeTruthy();
    expect(screen.getByTestId('chat-message-message-1').props.accessibilityLabel).toContain(
      'You, Hello from the trip',
    );
  });

  it('renders AI as distinct plain text while keeping opaque action drafts hidden', async () => {
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            sender: {
              id: null,
              display_name: '',
              identify_tag: null,
              avatar_url: null,
            },
            sender_kind: 'AI',
            ai_status: 'SUCCESS',
            content: 'Here is a simple answer.',
            action_drafts: [{ title: 'MUST STAY HIDDEN', nested: { amount: 42 } }],
          }),
        })}
      />,
    );

    expect(screen.getByText('GoPlanAI')).toBeTruthy();
    expect(screen.getByText('Here is a simple answer.')).toBeTruthy();
    expect(screen.queryByText('MUST STAY HIDDEN')).toBeNull();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('preserves nullable deleted-user identity without rendering null as text', async () => {
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            sender: {
              id: null,
              display_name: '',
              identify_tag: null,
              avatar_url: null,
            },
          }),
        })}
      />,
    );

    expect(screen.getByText('Deleted user')).toBeTruthy();
    expect(screen.queryByText('null')).toBeNull();
  });

  it('renders a tombstone instead of leaked content, reactions, or action drafts', async () => {
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            content: 'SECRET REMOVED CONTENT',
            is_deleted_for_everyone: true,
            deleted_for_everyone_at: '2026-08-09T08:31:00.000Z',
            reactions: [{ emoji: '❤️', count: 1, reacted_by_ids: [currentUserId] }],
            action_drafts: [{ secret: 'HIDDEN DRAFT' }],
          }),
        })}
      />,
    );

    expect(screen.getByText('Message removed for everyone')).toBeTruthy();
    expect(screen.queryByText('SECRET REMOVED CONTENT')).toBeNull();
    expect(screen.queryByText('HIDDEN DRAFT')).toBeNull();
    expect(screen.queryByTestId('chat-reaction-bar')).toBeNull();
  });

  it('keeps a failed optimistic bubble visible and retries its original client id', async () => {
    const onRetry = jest.fn();
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            id: 'optimistic:client-1',
            sender: {
              id: currentUserId,
              display_name: 'Quang Minh',
              identify_tag: '@quangminh',
              avatar_url: null,
            },
            client_message_id: 'client-1',
            content: 'Please retry this',
          }),
          isOwn: true,
          failed: true,
          failure: {
            kind: 'message',
            message: 'The connection was interrupted.',
            errorCode: null,
            status: null,
            retryAfterMs: null,
            fieldErrors: null,
          },
          onRetry,
        })}
      />,
    );

    expect(screen.getByText('Please retry this')).toBeTruthy();
    const retry = screen.getByLabelText(
      'Retry sending message. The connection was interrupted.',
    );
    expect(screen.getByText('Not sent. The connection was interrupted. Retry')).toBeTruthy();
    await fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledWith('client-1');
    expect(screen.getByTestId('chat-message-optimistic:client-1').props.accessibilityLabel).toContain(
      'Not sent',
    );
  });

  it('supports accessible selection without exposing a second checkbox stop', async () => {
    const onToggleSelection = jest.fn();
    await render(
      <ChatMessageBubble
        {...props({
          selectionMode: true,
          selected: true,
          onToggleSelection,
        })}
      />,
    );

    const bubble = screen.getByTestId('chat-message-message-1');
    expect(bubble.props.accessibilityState.selected).toBe(true);
    expect(bubble.props.accessibilityActions).toContainEqual({
      name: 'toggleSelection',
      label: 'Deselect message',
    });
    await fireEvent.press(bubble);
    expect(onToggleSelection).toHaveBeenCalledWith('message-1');
  });

  it('removes mutation actions and buttons from terminal/read-only messages', async () => {
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [] }],
          }),
          actionsEnabled: false,
        })}
      />,
    );

    const bubble = screen.getByTestId('chat-message-message-1');
    expect(bubble.props.accessibilityActions).toEqual([]);
    expect(screen.getByLabelText('Thumbs up, 1 reaction').props.accessibilityRole).toBeUndefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('turns a failed bubble retry into non-actionable text when chat becomes read-only', async () => {
    const onRetry = jest.fn();
    await render(
      <ChatMessageBubble
        {...props({
          message: message({
            id: 'optimistic:client-read-only',
            client_message_id: 'client-read-only',
          }),
          actionsEnabled: false,
          failed: true,
          failure: {
            kind: 'message',
            message: 'The connection was interrupted.',
            errorCode: null,
            status: null,
            retryAfterMs: null,
            fieldErrors: null,
          },
          onRetry,
        })}
      />,
    );

    const bubble = screen.getByTestId('chat-message-optimistic:client-read-only');
    expect(bubble.props.accessibilityActions).toEqual([]);
    expect(screen.getByText('Not sent. The connection was interrupted.')).toBeTruthy();
    expect(screen.queryByLabelText(/Retry sending message/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('announces pending and deleting delivery states truthfully', async () => {
    const view = await render(
      <ChatMessageBubble {...props({ pending: true, isOwn: true })} />,
    );
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(screen.getByTestId('chat-message-message-1').props.accessibilityLabel).toContain(
      'Sending',
    );

    await view.rerender(
      <ChatMessageBubble {...props({ deleting: true, isOwn: true })} />,
    );
    expect(screen.getByText('Removing…')).toBeTruthy();
    expect(screen.getByTestId('chat-message-message-1').props.accessibilityLabel).toContain(
      'Removing',
    );
  });
});
