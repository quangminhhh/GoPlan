import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Text } from 'react-native';
import type { ChatMessage } from '../types';
import {
  CHAT_HIDE_SELECTION_LIMIT,
  canDeleteMessageForEveryoneAt,
  ChatMessageList,
  toggleChatMessageSelection,
} from '../components/ChatMessageList';

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
const emptySet = new Set<string>();

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    trip_id: 'trip-1',
    sender: {
      id: 'user-other',
      display_name: 'Mai',
      identify_tag: '@mai',
      avatar_url: null,
    },
    sender_kind: 'USER',
    ai_status: null,
    content: `Content ${id}`,
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
    messages: [] as readonly ChatMessage[],
    currentUserId,
    pendingClientIds: emptySet,
    failedClientIds: emptySet,
    failedByClientId: new Map(),
    pendingReactionMessageIds: emptySet,
    pendingDeleteMessageIds: emptySet,
    hasMoreOlder: false,
    isLoadingOlder: false,
    olderLoadError: null,
    actionsEnabled: true,
    isHidingMessages: false,
    bottomAccessory: <Text>Composer accessory</Text>,
    onLoadOlder: jest.fn(),
    onRetry: jest.fn(),
    onToggleReaction: jest.fn(),
    onDeleteMessage: jest.fn(),
    onHideMessagesForMe: jest.fn().mockResolvedValue({
      applied: true,
      feedback: null,
    }),
    ...overrides,
  };
}

describe('ChatMessageList', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('caps one explicit bulk selection at exactly 100 confirmed ids', () => {
    let selected: ReadonlySet<string> = new Set();
    for (let index = 0; index < CHAT_HIDE_SELECTION_LIMIT; index += 1) {
      selected = toggleChatMessageSelection(selected, `message-${index}`).selectedMessageIds;
    }

    const capped = toggleChatMessageSelection(selected, 'message-100');
    expect(capped.limitReached).toBe(true);
    expect(capped.selectedMessageIds).toBe(selected);
    expect(capped.selectedMessageIds).toHaveProperty('size', 100);

    const deselected = toggleChatMessageSelection(selected, 'message-0');
    expect(deselected.limitReached).toBe(false);
    expect(deselected.selectedMessageIds.has('message-0')).toBe(false);
    expect(deselected.selectedMessageIds).toHaveProperty('size', 99);
  });

  it('renders an inverted newest-first transcript while grouping adjacent messages', async () => {
    const older = message('older', {
      content: 'Older message',
      created_at: '2026-08-09T08:30:00.000Z',
    });
    const newer = message('newer', {
      content: 'Newer message',
      created_at: '2026-08-09T08:32:00.000Z',
    });

    await render(<ChatMessageList {...props({ messages: [older, newer] })} />);

    const list = screen.getByTestId('chat-message-list');
    expect(list.props.inverted).toBe(true);
    const bubbles = screen.getAllByTestId(/^chat-message-(?!list$)/);
    expect(bubbles.map((bubble) => bubble.props.testID)).toEqual([
      'chat-message-newer',
      'chat-message-older',
    ]);
    expect(screen.getAllByText('Mai')).toHaveLength(1);
    expect(screen.getAllByLabelText("Mai's profile picture")).toHaveLength(1);
  });

  it('shows an honest empty state and keeps the composer accessory mounted', async () => {
    await render(<ChatMessageList {...props()} />);

    expect(screen.getByText('No messages yet')).toBeTruthy();
    expect(
      screen.getByText('Composer accessory', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('never groups nullable deleted senders under one invented identity', async () => {
    const deletedSender = {
      id: null,
      display_name: '',
      identify_tag: null,
      avatar_url: null,
    } as const;
    await render(
      <ChatMessageList
        {...props({
          messages: [
            message('older', {
              sender: deletedSender,
              created_at: '2026-08-09T08:30:00.000Z',
            }),
            message('newer', {
              sender: deletedSender,
              created_at: '2026-08-09T08:31:00.000Z',
            }),
          ],
        })}
      />,
    );

    expect(screen.getAllByText('Deleted user')).toHaveLength(2);
    expect(screen.getAllByLabelText("Deleted user's profile picture")).toHaveLength(2);
  });

  it('does not auto-page before user interaction and retains a manual retry path', async () => {
    const onLoadOlder = jest.fn();
    await render(
      <ChatMessageList
        {...props({
          messages: [message('message-1')],
          hasMoreOlder: true,
          olderLoadError: 'Could not load earlier messages.',
          onLoadOlder,
        })}
      />,
    );

    const list = screen.getByTestId('chat-message-list');
    await fireEvent(list, 'endReached');
    expect(onLoadOlder).not.toHaveBeenCalled();

    await fireEvent(list, 'scrollBeginDrag');
    await fireEvent(list, 'endReached');
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load earlier messages.');

    await fireEvent.press(screen.getByLabelText('Load earlier messages'));
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it('shows a single pagination progress state while loading older history', async () => {
    await render(
      <ChatMessageList
        {...props({
          messages: [message('message-1')],
          hasMoreOlder: true,
          isLoadingOlder: true,
        })}
      />,
    );

    expect(screen.getByLabelText('Loading earlier messages')).toBeTruthy();
    expect(screen.queryByLabelText('Load earlier messages')).toBeNull();
  });

  it('requires server permission, ownership, and a live deadline for remove-for-everyone', () => {
    const deadline = Date.parse('2026-08-09T08:35:00.000Z');
    const owned = message('owned', {
      sender: {
        id: currentUserId,
        display_name: 'Quang Minh',
        identify_tag: '@quangminh',
        avatar_url: null,
      },
      can_delete_for_everyone: true,
      delete_for_everyone_until: '2026-08-09T08:35:00.000Z',
    });

    expect(canDeleteMessageForEveryoneAt(owned, currentUserId, deadline)).toBe(true);
    expect(canDeleteMessageForEveryoneAt(owned, currentUserId, deadline + 1)).toBe(false);
    expect(
      canDeleteMessageForEveryoneAt(
        { ...owned, can_delete_for_everyone: false },
        currentUserId,
        deadline - 1,
      ),
    ).toBe(false);
    expect(canDeleteMessageForEveryoneAt(owned, 'someone-else', deadline - 1)).toBe(false);
  });

  it('expires remove-for-everyone with one transcript clock without a row interaction', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T08:30:00.000Z'));
    const owned = message('owned', {
      sender: {
        id: currentUserId,
        display_name: 'Quang Minh',
        identify_tag: '@quangminh',
        avatar_url: null,
      },
      can_delete_for_everyone: true,
      delete_for_everyone_until: '2026-08-09T08:30:01.000Z',
    });
    await render(<ChatMessageList {...props({ messages: [owned] })} />);

    await fireEvent(screen.getByTestId('chat-message-owned'), 'longPress');
    expect(screen.getByLabelText('Remove for everyone')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    expect(screen.queryByLabelText('Remove for everyone')).toBeNull();
  });

  it('rechecks the live remove deadline when a delayed destructive alert is confirmed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T08:30:00.000Z'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const onDeleteMessage = jest.fn();
    const owned = message('owned', {
      sender: {
        id: currentUserId,
        display_name: 'Quang Minh',
        identify_tag: '@quangminh',
        avatar_url: null,
      },
      can_delete_for_everyone: true,
      delete_for_everyone_until: '2026-08-09T08:30:01.000Z',
    });
    await render(
      <ChatMessageList
        {...props({ messages: [owned], onDeleteMessage })}
      />,
    );

    await fireEvent(screen.getByTestId('chat-message-owned'), 'longPress');
    await fireEvent.press(screen.getByLabelText('Remove for everyone'));
    const buttons = alert.mock.calls[0]?.[2];
    await act(async () => {
      jest.advanceTimersByTime(1001);
      buttons?.[1]?.onPress?.();
    });

    expect(onDeleteMessage).not.toHaveBeenCalled();
  });

  it('keeps selection and announces server feedback when atomic bulk hide is rejected', async () => {
    const onHideMessagesForMe = jest.fn().mockResolvedValue({
      applied: false,
      feedback: 'Some messages are no longer available.',
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatMessageList
        {...props({
          messages: [message('message-1')],
          onHideMessagesForMe,
        })}
      />,
    );

    await fireEvent(screen.getByTestId('chat-message-message-1'), 'longPress');
    await fireEvent.press(screen.getByLabelText('Select messages'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(
      screen.getByText('Composer accessory', { includeHiddenElements: true }),
    ).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Hide selected messages'));
    const buttons = alert.mock.calls[0]?.[2];
    await act(async () => {
      await buttons?.[1]?.onPress?.();
    });

    expect(onHideMessagesForMe).toHaveBeenCalledWith(['message-1']);
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Some messages are no longer available.',
    );
  });

  it('refuses a stale bulk-hide confirmation after the room becomes read-only', async () => {
    const onHideMessagesForMe = jest.fn().mockResolvedValue({
      applied: true,
      feedback: null,
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const baseProps = props({
      messages: [message('message-1')],
      onHideMessagesForMe,
    });
    const view = await render(<ChatMessageList {...baseProps} />);

    await fireEvent(screen.getByTestId('chat-message-message-1'), 'longPress');
    await fireEvent.press(screen.getByLabelText('Select messages'));
    await fireEvent.press(screen.getByLabelText('Hide selected messages'));
    const buttons = alert.mock.calls[0]?.[2];

    await view.rerender(
      <ChatMessageList {...baseProps} actionsEnabled={false} />,
    );
    await act(async () => {
      await buttons?.[1]?.onPress?.();
    });

    expect(onHideMessagesForMe).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByLabelText('Hide selected messages').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('removes all mutation entry points when chat is read-only', async () => {
    const failed = message('optimistic:client-read-only', {
      client_message_id: 'client-read-only',
      reactions: [{ emoji: '👍', count: 2, reacted_by_ids: [] }],
    });
    await render(
      <ChatMessageList
        {...props({
          messages: [failed],
          failedClientIds: new Set(['client-read-only']),
          failedByClientId: new Map([
            ['client-read-only', {
              kind: 'message',
              message: 'The connection was interrupted.',
              errorCode: null,
              status: null,
              retryAfterMs: null,
              fieldErrors: null,
            }],
          ]),
          actionsEnabled: false,
        })}
      />,
    );

    const bubble = screen.getByTestId('chat-message-optimistic:client-read-only');
    expect(bubble.props.accessibilityActions).toEqual([]);
    expect(screen.getByLabelText('Thumbs up, 2 reactions').props.accessibilityRole).toBeUndefined();
    expect(screen.queryByLabelText('Message actions')).toBeNull();
    expect(screen.queryByLabelText(/Retry sending message/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
