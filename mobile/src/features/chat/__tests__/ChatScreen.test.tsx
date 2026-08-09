import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ChatApiFailure, ChatMessage } from '../types';
import { CHAT_KEYBOARD_BEHAVIOR, ChatScreen } from '../screens/ChatScreen';

let mockParams: { tripId?: string | string[] } = { tripId: 'trip-1' };
const mockUseTripChat = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../hooks/useTripChat', () => ({
  useTripChat: (input: unknown) => mockUseTripChat(input),
}), { virtual: true });
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/features/auth/components/UserAvatar', () => ({ UserAvatar: () => null }));

const emptySet = new Set<string>();
const emptyMap = new Map<string, ChatApiFailure>();

function failure(
  message: string,
  overrides: Partial<ChatApiFailure> = {},
): ChatApiFailure {
  return {
    kind: 'message',
    message,
    errorCode: null,
    status: null,
    retryAfterMs: null,
    fieldErrors: null,
    ...overrides,
  };
}

function message(id: string, content = `Content ${id}`): ChatMessage {
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
    content,
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
  };
}

function chatResult(overrides: Record<string, unknown> = {}) {
  return {
    roomStatus: 'ready',
    subscriptionStatus: 'subscribed',
    roomError: null,
    messages: [] as readonly ChatMessage[],
    pendingClientIds: emptySet,
    failedClientIds: emptySet,
    failedByClientId: emptyMap,
    hasMoreOlder: false,
    isLoadingOlder: false,
    olderLoadError: null,
    isGapFilling: false,
    isUpdating: false,
    connectionStatus: 'connected',
    connectionEpoch: 1,
    isReadOnly: false,
    pendingReactionMessageIds: emptySet,
    pendingDeleteMessageIds: emptySet,
    isHidingMessages: false,
    mutationError: null,
    currentUserId: 'user-me',
    tripStatus: 'PLANNING',
    accessStatus: 'granted',
    loadOlder: jest.fn().mockResolvedValue(undefined),
    retryInitialLoad: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue({
      kind: 'created',
      clientMessageId: 'client-1',
    }),
    retryPending: jest.fn().mockResolvedValue({
      kind: 'created',
      clientMessageId: 'client-1',
    }),
    toggleReaction: jest.fn().mockResolvedValue({ kind: 'applied' }),
    deleteMessage: jest.fn().mockResolvedValue({ kind: 'applied' }),
    hideMessagesForMe: jest.fn().mockResolvedValue({ kind: 'applied' }),
    ...overrides,
  };
}

describe('ChatScreen', () => {
  beforeEach(() => {
    mockParams = { tripId: 'trip-1' };
    mockUseTripChat.mockReset();
    mockUseTripChat.mockReturnValue(chatResult());
  });

  it('passes only the normalized route id into the authority-owning chat hook', async () => {
    mockParams = { tripId: [' trip-1 ', 'ignored'] };
    await render(<ChatScreen />);

    expect(mockUseTripChat).toHaveBeenCalledWith({ tripId: 'trip-1' });
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });

  it('fails closed for a missing route id while still obeying hook call order', async () => {
    mockParams = {};
    await render(<ChatScreen />);

    expect(mockUseTripChat).toHaveBeenCalledWith({ tripId: undefined });
    expect(screen.getByTestId('chat-invalid-route')).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('suppresses the transcript in kicked or denied states', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        roomStatus: 'kicked',
        accessStatus: 'denied',
        isReadOnly: true,
        messages: [message('secret', 'Transcript must not remain visible')],
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-access-denied')).toBeTruthy();
    expect(screen.getByText('This chat is no longer available.')).toBeTruthy();
    expect(screen.queryByText('Transcript must not remain visible')).toBeNull();
    expect(screen.queryByTestId('chat-message-list')).toBeNull();
  });

  it('keeps transient access errors distinct and offers an accessible retry', async () => {
    const retryInitialLoad = jest.fn().mockResolvedValue(undefined);
    mockUseTripChat.mockReturnValue(
      chatResult({
        accessStatus: 'error',
        roomStatus: 'error',
        roomError: {
          errorCode: 'NETWORK_ERROR',
          detail: 'The trip could not be checked right now.',
        },
        retryInitialLoad,
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-initial-error')).toBeTruthy();
    expect(screen.getByText('The trip could not be checked right now.')).toBeTruthy();
    expect(screen.queryByText('This chat is no longer available.')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Retry loading chat'));
    expect(retryInitialLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps history but removes every composer mutation when subscription is rejected', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        subscriptionStatus: 'rejected',
        isReadOnly: true,
        roomError: {
          errorCode: 'SUBSCRIPTION_LIMIT_REACHED',
          detail: 'Too many chat rooms are subscribed.',
        },
        messages: [message('message-1')],
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByText('Content message-1')).toBeTruthy();
    expect(screen.getByTestId('chat-subscription-rejected')).toHaveTextContent(
      'Too many chat rooms are subscribed.',
    );
    expect(screen.getByTestId('chat-read-only-footer')).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(screen.getByTestId('chat-message-message-1').props.accessibilityActions).toEqual([]);
  });

  it('preserves a local draft while a temporary subscription rejection hides mutations', async () => {
    const readyResult = chatResult();
    mockUseTripChat.mockReturnValue(readyResult);
    const view = await render(<ChatScreen />);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Draft survives');

    mockUseTripChat.mockReturnValue(
      chatResult({
        subscriptionStatus: 'rejected',
        isReadOnly: true,
        roomError: {
          errorCode: 'SUBSCRIPTION_LIMIT_REACHED',
          detail: 'Too many chat rooms are subscribed.',
        },
      }),
    );
    await view.rerender(<ChatScreen />);

    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(
      screen.getByLabelText('Message', { includeHiddenElements: true }).props.value,
    ).toBe('Draft survives');

    mockUseTripChat.mockReturnValue(readyResult);
    await view.rerender(<ChatScreen />);
    expect(screen.getByLabelText('Message').props.value).toBe('Draft survives');
  });

  it('resets the local transcript state before a different trip can send', async () => {
    const tripASend = jest.fn().mockResolvedValue({
      kind: 'created',
      clientMessageId: 'client-a',
    });
    const tripBSend = jest.fn().mockResolvedValue({
      kind: 'created',
      clientMessageId: 'client-b',
    });
    mockParams = { tripId: 'trip-a' };
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage: tripASend }));
    const view = await render(<ChatScreen />);
    await fireEvent.changeText(
      screen.getByLabelText('Message'),
      'Private draft for trip A',
    );

    mockParams = { tripId: 'trip-b' };
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage: tripBSend }));
    await view.rerender(<ChatScreen />);

    const tripBInput = screen.getByLabelText('Message');
    expect(mockUseTripChat).toHaveBeenLastCalledWith({ tripId: 'trip-b' });
    expect(tripBInput.props.value).toBe('');
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(tripASend).not.toHaveBeenCalled();
    expect(tripBSend).not.toHaveBeenCalled();

    await fireEvent.changeText(tripBInput, 'Message for trip B');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await act(async () => undefined);
    expect(tripBSend).toHaveBeenCalledWith('Message for trip B');
    expect(tripASend).not.toHaveBeenCalled();
  });

  it.each([
    ['COMPLETED', 'This completed trip’s chat is read-only.'],
    ['CANCELLED', 'This cancelled trip’s chat is read-only.'],
  ])('renders %s trip history as explicitly read-only', async (tripStatus, copy) => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        tripStatus,
        isReadOnly: true,
        messages: [message('message-1')],
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-terminal-notice')).toHaveTextContent(copy);
    expect(screen.getByTestId('chat-read-only-footer')).toHaveTextContent(copy);
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('uses an authoritative terminal room error while trip status catches up', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        tripStatus: 'ONGOING',
        isReadOnly: true,
        roomError: {
          errorCode: 'TRIP_TERMINAL',
          detail: 'This trip no longer accepts chat changes.',
        },
        mutationError: {
          messageId: null,
          error: failure('This trip no longer accepts chat changes.', {
            errorCode: 'TRIP_TERMINAL',
            status: 409,
          }),
        },
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-terminal-notice')).toHaveTextContent(
      'This trip no longer accepts chat changes.',
    );
    expect(screen.getByTestId('chat-read-only-footer')).toHaveTextContent(
      'This trip no longer accepts chat changes.',
    );
    expect(screen.queryByTestId('chat-room-error')).toBeNull();
    expect(screen.queryByTestId('chat-mutation-error')).toBeNull();
  });

  it('uses native-stack-safe insets and an iOS keyboard-aware layout', async () => {
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-safe-area').props.edges).toEqual({
      top: 'off',
      left: 'additive',
      right: 'additive',
      bottom: 'additive',
    });
    expect(CHAT_KEYBOARD_BEHAVIOR).toBe('padding');
  });

  it('clears the composer for created and transient-failed outcomes', async () => {
    const sendMessage = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'created', clientMessageId: 'client-1' })
      .mockResolvedValueOnce({
        kind: 'failed',
        clientMessageId: 'client-2',
        error: failure('Network interrupted.'),
      });
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage }));
    await render(<ChatScreen />);

    const input = screen.getByLabelText('Message');
    await fireEvent.changeText(input, 'First message');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'First message');
    expect(input.props.value).toBe('');

    await fireEvent.changeText(input, 'Second message');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'Second message');
    expect(input.props.value).toBe('');
  });

  it('preserves the exact local draft and surfaces Retry-After for a blocked send', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      kind: 'blocked',
      error: failure('Too many messages.', {
        errorCode: 'THROTTLED',
        status: 429,
        retryAfterMs: 2500,
      }),
    });
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage }));
    await render(<ChatScreen />);

    const input = screen.getByLabelText('Message');
    await fireEvent.changeText(input, '  Keep this exact draft  ');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await act(async () => undefined);

    expect(sendMessage).toHaveBeenCalledWith('Keep this exact draft');
    expect(input.props.value).toBe('  Keep this exact draft  ');
    expect(screen.getByTestId('chat-composer-feedback')).toHaveTextContent(
      'Too many messages. Try again in 3 seconds.',
    );
  });

  it('surfaces catch-up, mutation, and older-page failures without hiding history', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        messages: [message('message-1')],
        isGapFilling: true,
        mutationError: {
          messageId: 'message-1',
          error: failure('Reaction could not be saved.'),
        },
        hasMoreOlder: true,
        olderLoadError: failure('Earlier messages could not be loaded.'),
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-catch-up-status')).toHaveTextContent(
      'Catching up on messages…',
    );
    expect(screen.getByTestId('chat-mutation-error')).toHaveTextContent(
      'Reaction could not be saved.',
    );
    expect(screen.getByText('Earlier messages could not be loaded.')).toBeTruthy();
    expect(screen.getByText('Content message-1')).toBeTruthy();
  });

  it('surfaces an unknown room protocol error without disabling a healthy transcript', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        messages: [message('message-1')],
        roomError: {
          errorCode: 'FUTURE_ROOM_ERROR',
          detail: 'The server reported a future room condition.',
        },
      }),
    );
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-room-error')).toHaveTextContent(
      'The server reported a future room condition.',
    );
    expect(screen.getByText('Content message-1')).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBeTruthy();
  });
});
