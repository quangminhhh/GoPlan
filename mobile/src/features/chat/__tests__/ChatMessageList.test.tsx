import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  Alert,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
} from 'react-native';
import { focusAccessibilityNode } from '../ai/accessibilityFocus';
import { makeDraftFixture } from '../ai/__fixtures__/drafts';
import { createAIReconciliationCoordinator } from '../ai/reconciliation';
import { AIReconciliationCoordinatorProvider } from '../ai/reconciliationContext';
import type { ChatMessage } from '../types';
import {
  CHAT_HIDE_SELECTION_LIMIT,
  canDeleteMessageForEveryoneAt,
  ChatMessageList,
  toggleChatMessageSelection,
} from '../components/ChatMessageList';

jest.mock('@expo/vector-icons', () => ({
  FontAwesome6: () => null,
  Ionicons: () => null,
}));
jest.mock('../ai/accessibilityFocus', () => ({
  focusAccessibilityNode: jest.fn(),
}));
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
const mockFocusAccessibilityNode = jest.mocked(focusAccessibilityNode);

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
    ambiguousAIDraftIds: emptySet,
    aiTypingInteractionId: null,
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
    onApplyAIDraftSnapshot: jest.fn(),
    ...overrides,
  };
}

describe('ChatMessageList', () => {
  afterEach(() => {
    mockFocusAccessibilityNode.mockClear();
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
    expect(list.props.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 80,
    });
    const bubbles = screen.getAllByTestId(/^chat-message-(?!list$|footer-)/);
    expect(bubbles.map((bubble) => bubble.props.testID)).toEqual([
      'chat-message-newer',
      'chat-message-older',
    ]);
    expect(screen.getAllByText('Mai')).toHaveLength(1);
    expect(screen.getAllByLabelText("Mai's profile picture")).toHaveLength(1);
  });

  it('renders correlated AI typing at the inverted newest-edge header without synthetic message data', async () => {
    const onlyMessage = message('message-1');
    const rendered = await render(
      <ChatMessageList
        {...props({
          aiTypingInteractionId: 'interaction-7',
          messages: [onlyMessage],
        })}
      />,
    );

    const list = screen.getByTestId('chat-message-list');
    expect(list.props.data).toEqual([onlyMessage]);
    expect(list.props.ListHeaderComponent).not.toBeNull();
    expect(screen.getByTestId('goplan-ai-typing-interaction-7')).toBeTruthy();
    expect(screen.getAllByTestId(/^chat-message-(?!list$|footer-)/)).toHaveLength(1);

    await rendered.rerender(
      <ChatMessageList
        {...props({ aiTypingInteractionId: null, messages: [onlyMessage] })}
      />,
    );
    expect(screen.queryByTestId('goplan-ai-typing-interaction-7')).toBeNull();
    expect(screen.getByTestId('chat-message-list').props.data).toEqual([
      onlyMessage,
    ]);
  });

  it('fails every actionable card closed when two messages carry the same draft UUID', async () => {
    const draft = makeDraftFixture({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      display: { title: 'First authority', kicker: 'Expense' },
    });
    const aiMessage = (id: string, title: string) =>
      message(id, {
        trip_id: '11111111-1111-4111-8111-111111111111',
        sender: {
          id: null,
          display_name: 'GoPlanAI',
          identify_tag: null,
          avatar_url: null,
        },
        sender_kind: 'AI',
        ai_status: 'SUCCESS',
        action_drafts: [
          {
            ...draft,
            display: { title, kicker: 'Expense' },
          },
        ],
      });

    await render(
      <ChatMessageList
        {...props({
          messages: [
            aiMessage('ai-one', 'First authority'),
            aiMessage('ai-two', 'Conflicting authority'),
          ],
          ambiguousAIDraftIds: new Set([draft.id]),
        })}
      />,
    );

    expect(
      screen.queryAllByTestId(`ai-action-draft-${draft.id}`),
    ).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Confirm' })).toHaveLength(
      0,
    );
    expect(
      screen.getAllByText(
        'An AI action draft could not be displayed safely.',
      ),
    ).toHaveLength(2);
  });

  it('does not transfer a stale editor session when duplicate ambiguity later clears to another message', async () => {
    const draft = makeDraftFixture({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_edit: true,
      missing_fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
      ],
    });
    const aiMessage = (id: string) =>
      message(id, {
        trip_id: '11111111-1111-4111-8111-111111111111',
        sender: {
          id: null,
          display_name: 'GoPlanAI',
          identify_tag: null,
          avatar_url: null,
        },
        sender_kind: 'AI',
        ai_status: 'SUCCESS',
        action_drafts: [draft],
      });
    const first = aiMessage('ai-one');
    const second = aiMessage('ai-two');
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: 'user-me:11111111-1111-4111-8111-111111111111',
      tripId: '11111111-1111-4111-8111-111111111111',
    });
    const transcript = (
      messages: readonly ChatMessage[],
      ambiguousAIDraftIds: ReadonlySet<string> = emptySet,
    ) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        <ChatMessageList
          {...props({ messages, ambiguousAIDraftIds })}
        />
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(transcript([first]));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(
      screen.getByLabelText('Title'),
      'Must not transfer',
    );

    await rendered.rerender(
      transcript([first, second], new Set([draft.id])),
    );
    expect(screen.queryAllByTestId(`ai-action-draft-${draft.id}`)).toHaveLength(
      0,
    );
    await rendered.rerender(transcript([second]));

    expect(screen.getByTestId(`ai-action-draft-${draft.id}`)).toBeTruthy();
    expect(screen.queryByTestId('ai-draft-field-editor')).toBeNull();
    expect(screen.queryByText('Must not transfer')).toBeNull();
  });

  it('shows an honest empty state and keeps the composer accessory mounted', async () => {
    await render(<ChatMessageList {...props()} />);

    expect(screen.getByText('No messages yet')).toBeTruthy();
    const emptyStyle = screen.getByTestId('chat-empty-state').props.style;
    expect(StyleSheet.flatten(emptyStyle)).toMatchObject({
      flex: 1,
      transform: [{ scaleY: -1 }],
    });
    expect(screen.getByTestId('chat-message-list').props.inverted).toBe(true);
    expect(
      screen.getByText('Composer accessory', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('gives every confirmed mutable bubble one compact reaction entry point without breaking grouping', async () => {
    const onOpenMessages = [
      message('older', { created_at: '2026-08-09T08:30:00.000Z' }),
      message('newer', { created_at: '2026-08-09T08:31:00.000Z' }),
      message('pending', {
        client_message_id: 'client-pending',
        created_at: '2026-08-09T08:32:00.000Z',
      }),
      message('removed', {
        is_deleted_for_everyone: true,
        created_at: '2026-08-09T08:33:00.000Z',
      }),
    ];
    await render(
      <ChatMessageList
        {...props({
          messages: onOpenMessages,
          pendingClientIds: new Set(['client-pending']),
        })}
      />,
    );

    expect(screen.getAllByLabelText('React to this message')).toHaveLength(2);
    expect(screen.getByTestId('chat-reaction-affordance-older')).toBeTruthy();
    expect(screen.getByTestId('chat-reaction-affordance-newer')).toBeTruthy();
    expect(screen.queryByTestId('chat-reaction-affordance-pending')).toBeNull();
    expect(screen.queryByTestId('chat-reaction-affordance-removed')).toBeNull();
    for (const id of ['older', 'newer']) {
      expect(
        StyleSheet.flatten(screen.getByTestId(`chat-bubble-action-row-${id}`).props.style),
      ).toMatchObject({ minHeight: 44, flexDirection: 'row' });
    }
    expect(screen.getAllByText('Mai')).toHaveLength(1);
    expect(screen.getAllByLabelText("Mai's profile picture")).toHaveLength(1);
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

  it('dismisses the software keyboard when the transcript starts dragging', async () => {
    const dismissKeyboard = jest
      .spyOn(Keyboard, 'dismiss')
      .mockImplementation(() => undefined);
    await render(
      <ChatMessageList
        {...props({ messages: [message('message-1')] })}
      />,
    );

    const list = screen.getByTestId('chat-message-list');
    expect(list.props.keyboardDismissMode).toBe('on-drag');
    await fireEvent(list, 'scrollBeginDrag');
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
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

  it('restores screen-reader focus to the affordance only after the sheet dismisses', async () => {
    jest.useFakeTimers();
    await render(
      <ChatMessageList {...props({ messages: [message('message-1')] })} />,
    );

    await fireEvent.press(screen.getByLabelText('React to this message'));
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Close message actions'));
    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
    await act(() => onDismiss?.());
    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({
          testID: 'chat-reaction-affordance-message-1',
        }),
      }),
    );
  });

  it.each(['close', 'requestClose', 'reaction', 'selection'] as const)(
    'restores Android screen-reader focus after a normal %s dismissal',
    async (action) => {
      jest.useFakeTimers();
      jest.replaceProperty(Platform, 'OS', 'android');
      await render(
        <ChatMessageList {...props({ messages: [message('message-1')] })} />,
      );

      await fireEvent.press(screen.getByLabelText('React to this message'));
      if (action === 'close') {
        await fireEvent.press(screen.getByLabelText('Close message actions'));
      } else if (action === 'requestClose') {
        const requestClose = screen.getByTestId('chat-message-actions-modal')
          .parent?.props.onRequestClose;
        await act(() => requestClose?.());
      } else if (action === 'reaction') {
        await fireEvent.press(screen.getByLabelText('React with heart'));
      } else {
        await fireEvent.press(screen.getByLabelText('Select messages'));
      }

      expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
      await act(() => jest.advanceTimersToNextTimer());
      expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
      await act(() => jest.advanceTimersToNextTimer());

      expect(mockFocusAccessibilityNode).toHaveBeenCalledWith(
        expect.objectContaining({
          props: expect.objectContaining({
            testID:
              action === 'selection'
                ? 'chat-message-message-1'
                : 'chat-reaction-affordance-message-1',
          }),
        }),
      );
    },
  );

  it('cancels Android focus restoration when another action session opens', async () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <ChatMessageList
        {...props({ messages: [message('message-1'), message('message-2')] })}
      />,
    );

    await fireEvent.press(screen.getAllByLabelText('React to this message')[0]);
    await fireEvent.press(screen.getByLabelText('Close message actions'));
    await fireEvent.press(screen.getAllByLabelText('React to this message')[1]);
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-message-actions-modal')).toBeTruthy();
  });

  it('falls back to the originating bubble when selection removes the affordance', async () => {
    jest.useFakeTimers();
    await render(
      <ChatMessageList {...props({ messages: [message('message-1')] })} />,
    );

    await fireEvent.press(screen.getByLabelText('React to this message'));
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Select messages'));
    expect(screen.queryByLabelText('React to this message')).toBeNull();
    await act(() => onDismiss?.());
    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ testID: 'chat-message-message-1' }),
      }),
    );
  });

  it('does not restore stale or duplicate focus after the originating row unmounts', async () => {
    jest.useFakeTimers();
    const baseProps = props({ messages: [message('message-1')] });
    const rendered = await render(<ChatMessageList {...baseProps} />);

    await fireEvent(
      screen.getByTestId('chat-message-message-1'),
      'longPress',
    );
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await rendered.rerender(
      <ChatMessageList {...baseProps} messages={[]} />,
    );
    await act(() => onDismiss?.());
    await act(() => onDismiss?.());
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
  });

  it('cancels a deferred focus restore when another message action session opens', async () => {
    jest.useFakeTimers();
    await render(
      <ChatMessageList
        {...props({ messages: [message('message-1'), message('message-2')] })}
      />,
    );

    const affordances = screen.getAllByLabelText('React to this message');
    await fireEvent.press(affordances[0]);
    const firstDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Close message actions'));
    await act(() => firstDismiss?.());
    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();

    await fireEvent.press(affordances[1]);
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
  });

  it('does not focus a row that unmounts after dismissal but before the deferred task', async () => {
    jest.useFakeTimers();
    const baseProps = props({ messages: [message('message-1')] });
    const rendered = await render(<ChatMessageList {...baseProps} />);

    await fireEvent.press(screen.getByLabelText('React to this message'));
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Close message actions'));
    await act(() => onDismiss?.());
    await rendered.rerender(<ChatMessageList {...baseProps} messages={[]} />);
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
  });

  it('cancels a deferred focus restore when the chat list unmounts', async () => {
    jest.useFakeTimers();
    const rendered = await render(
      <ChatMessageList {...props({ messages: [message('message-1')] })} />,
    );

    await fireEvent.press(screen.getByLabelText('React to this message'));
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Close message actions'));
    await act(() => onDismiss?.());
    await rendered.unmount();
    await act(() => jest.runOnlyPendingTimers());

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
  });

  it('leaves focus with a native destructive alert instead of reclaiming it', async () => {
    jest.useFakeTimers();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <ChatMessageList {...props({ messages: [message('message-1')] })} />,
    );

    await fireEvent.press(screen.getByLabelText('React to this message'));
    const onDismiss = screen.getByTestId('chat-message-actions-modal').parent
      ?.props.onDismiss;
    await fireEvent.press(screen.getByLabelText('Hide for me'));
    expect(alert).not.toHaveBeenCalled();
    await act(() => onDismiss?.());
    expect(alert).not.toHaveBeenCalled();
    await act(() => jest.runOnlyPendingTimers());
    expect(alert).toHaveBeenCalledWith(
      'Hide this message?',
      expect.any(String),
      expect.any(Array),
    );

    expect(mockFocusAccessibilityNode).not.toHaveBeenCalled();
  });
});
