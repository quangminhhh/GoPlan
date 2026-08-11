import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  Dimensions,
  Keyboard,
  StyleSheet,
  type KeyboardEvent,
} from 'react-native';
import { makeDraftFixture } from '../ai/__fixtures__/drafts';
import { aiActionDraftSourceIdentity } from '../ai/drafts';
import { createAIReconciliationCoordinator } from '../ai/reconciliation';
import type { ChatApiFailure, ChatMessage } from '../types';
import {
  chatKeyboardBottomInset,
  ChatScreen,
  stableChatKeyboardFrame,
} from '../screens/ChatScreen';

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
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual<
    typeof import('react-native-safe-area-context')
  >('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
jest.mock('../ai/api', () => {
  const actual = jest.requireActual<typeof import('../ai/api')>('../ai/api');
  return {
    ...actual,
    getAIActionDraft: jest.fn(),
    cancelAIActionDraft: jest.fn(),
  };
});

// eslint-disable-next-line import/first
import { cancelAIActionDraft, getAIActionDraft } from '../ai/api';

const mockGetAIActionDraft = jest.mocked(getAIActionDraft);
const mockCancelAIActionDraft = jest.mocked(cancelAIActionDraft);

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
    aiTypingState: { active: null },
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
    applyAIDraftSnapshot: jest.fn(),
    ...overrides,
  };
}

describe('ChatScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockParams = { tripId: 'trip-1' };
    mockUseTripChat.mockReset();
    mockGetAIActionDraft.mockReset();
    mockCancelAIActionDraft.mockReset();
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

  it('resets the composer when the signed-in user resource changes inside the same trip', async () => {
    const coordinatorA = createAIReconciliationCoordinator({
      resourceKey: 'user-a:trip-1',
      tripId: 'trip-1',
    });
    const coordinatorB = createAIReconciliationCoordinator({
      resourceKey: 'user-b:trip-1',
      tripId: 'trip-1',
    });
    mockUseTripChat.mockReturnValue(
      chatResult({ aiReconciliationCoordinator: coordinatorA }),
    );
    const view = await render(<ChatScreen />);
    await fireEvent.changeText(
      screen.getByLabelText('Message'),
      'Private draft for user A',
    );

    mockUseTripChat.mockReturnValue(
      chatResult({ aiReconciliationCoordinator: coordinatorB }),
    );
    await view.rerender(<ChatScreen />);

    expect(screen.getByLabelText('Message').props.value).toBe('');
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

  it('calculates the keyboard inset from the viewport intersection', () => {
    const dockedFrame = { height: 291, screenY: 376 };
    expect(chatKeyboardBottomInset(667, dockedFrame, 34)).toBe(257);
    expect(
      chatKeyboardBottomInset(667, { height: 200, screenY: 300 }, 34),
    ).toBe(166);
    expect(
      chatKeyboardBottomInset(667, { height: 291, screenY: 600 }, 34),
    ).toBe(33);
    expect(
      chatKeyboardBottomInset(667, { height: 291, screenY: 700 }, 34),
    ).toBe(0);
    expect(
      chatKeyboardBottomInset(667, { height: 291, screenY: 0 }, 34),
    ).toBe(0);
    expect(chatKeyboardBottomInset(Number.NaN, dockedFrame, 34)).toBe(0);
  });

  it('retains the last stable keyboard frame during an iOS cross-fade', () => {
    const current = { height: 291, screenY: 376 };
    expect(stableChatKeyboardFrame(current, { height: 320, screenY: 0 })).toBe(
      current,
    );
    expect(stableChatKeyboardFrame(current, undefined)).toBe(current);
    expect(stableChatKeyboardFrame(current, { height: 0, screenY: 667 })).toBeNull();
    expect(
      stableChatKeyboardFrame(current, { height: 216, screenY: 451 }),
    ).toEqual({ height: 216, screenY: 451 });
  });

  it('uses native-stack-safe insets and follows stable keyboard frame changes', async () => {
    let onKeyboardFrameChange: ((event: KeyboardEvent) => void) | undefined;
    let onKeyboardHide: ((event: KeyboardEvent) => void) | undefined;
    const addKeyboardListener = Keyboard.addListener.bind(Keyboard);
    const listenerSpy = jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((eventType, listener) => {
        if (eventType === 'keyboardWillChangeFrame') {
          onKeyboardFrameChange = listener;
        } else if (eventType === 'keyboardWillHide') {
          onKeyboardHide = listener;
        }
        return addKeyboardListener(eventType, listener);
      });
    jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
    jest
      .spyOn(Keyboard, 'scheduleLayoutAnimation')
      .mockImplementation(() => undefined);
    await render(<ChatScreen />);

    expect(screen.getByTestId('chat-safe-area').props.edges).toEqual({
      top: 'off',
      left: 'additive',
      right: 'additive',
      bottom: 'additive',
    });
    expect(onKeyboardFrameChange).toBeDefined();
    expect(onKeyboardHide).toBeDefined();

    const viewportHeight = Dimensions.get('window').height;

    await act(async () => {
      onKeyboardFrameChange?.({
        duration: 250,
        easing: 'keyboard',
        endCoordinates: {
          height: 291,
          screenX: 0,
          screenY: viewportHeight - 291,
          width: 375,
        },
      });
    });

    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
    ).toMatchObject({ flex: 1, paddingBottom: 291 });

    await act(async () => {
      onKeyboardFrameChange?.({
        duration: 100,
        easing: 'keyboard',
        endCoordinates: {
          height: 320,
          screenX: 0,
          screenY: 0,
          width: 375,
        },
      });
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
    ).toMatchObject({ flex: 1, paddingBottom: 291 });

    await act(async () => {
      onKeyboardFrameChange?.({
        duration: 250,
        easing: 'keyboard',
        endCoordinates: {
          height: 216,
          screenX: 0,
          screenY: viewportHeight - 216,
          width: 375,
        },
      });
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
    ).toMatchObject({ flex: 1, paddingBottom: 216 });

    await act(async () => {
      onKeyboardHide?.({
        duration: 250,
        easing: 'keyboard',
        endCoordinates: {
          height: 0,
          screenX: 0,
          screenY: viewportHeight,
          width: 375,
        },
      });
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
    ).toMatchObject({ flex: 1, paddingBottom: 0 });
    listenerSpy.mockRestore();
  });

  it('refreshes keyboard metrics after a viewport orientation change', async () => {
    const originalWindow = Dimensions.get('window');
    const originalScreen = Dimensions.get('screen');
    const portrait = { width: 375, height: 667, scale: 2, fontScale: 1 };
    const landscape = { width: 667, height: 375, scale: 2, fontScale: 1 };
    let metrics = {
      height: 291,
      screenX: 0,
      screenY: portrait.height - 291,
      width: portrait.width,
    };
    const metricsSpy = jest
      .spyOn(Keyboard, 'metrics')
      .mockImplementation(() => metrics);
    jest
      .spyOn(Keyboard, 'scheduleLayoutAnimation')
      .mockImplementation(() => undefined);

    let view: Awaited<ReturnType<typeof render>> | null = null;
    try {
      await act(async () => {
        Dimensions.set({ window: portrait, screen: portrait });
      });
      view = await render(<ChatScreen />);
      expect(
        StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
      ).toMatchObject({ flex: 1, paddingBottom: 291 });

      metrics = {
        height: 216,
        screenX: 0,
        screenY: landscape.height - 216,
        width: landscape.width,
      };
      await act(async () => {
        Dimensions.set({ window: landscape, screen: landscape });
      });

      expect(metricsSpy).toHaveBeenLastCalledWith();
      expect(
        StyleSheet.flatten(screen.getByTestId('chat-keyboard-layout').props.style),
      ).toMatchObject({ flex: 1, paddingBottom: 216 });
    } finally {
      if (view !== null) {
        await view.unmount();
      }
      await act(async () => {
        Dimensions.set({ window: originalWindow, screen: originalScreen });
      });
    }
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

  it('maps only an AI-mention 429 to the explicit 20-per-hour quota and keeps Retry-After', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      kind: 'blocked',
      error: failure('Generic throttle detail.', {
        errorCode: 'THROTTLED',
        status: 429,
        retryAfterMs: 2500,
      }),
    });
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage }));
    await render(<ChatScreen />);

    const input = screen.getByLabelText('Message');
    await fireEvent.changeText(input, '  @goplanai Keep my AI prompt  ');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await act(async () => undefined);

    expect(input.props.value).toBe('  @goplanai Keep my AI prompt  ');
    expect(screen.getByTestId('chat-composer-feedback')).toHaveTextContent(
      'GoPlanAI allows 20 prompts per hour. Your prompt was not sent; try again later. Try again in 3 seconds.',
    );
  });

  it('does not call the chat send path for a bare GoPlanAI mention', async () => {
    const sendMessage = jest.fn().mockResolvedValue({
      kind: 'created',
      clientMessageId: 'client-ai-bare',
    });
    mockUseTripChat.mockReturnValue(chatResult({ sendMessage }));
    await render(<ChatScreen />);

    await fireEvent.changeText(
      screen.getByLabelText('Message'),
      '@GoPlanAI   ',
    );
    await fireEvent.press(screen.getByLabelText('Send message'));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('goplan-ai-prompt-hint')).toBeTruthy();
  });

  it.each([
    ['AI_BUSY', 409, 'The current GoPlanAI interaction is still active.'],
    ['INVALID_AI_PROMPT', 400, 'Please include a concrete AI prompt.'],
  ])(
    'preserves backend detail and the local composer draft for %s',
    async (errorCode, status, detail) => {
      const sendMessage = jest.fn().mockResolvedValue({
        kind: 'blocked',
        error: failure(detail, { errorCode, status }),
      });
      mockUseTripChat.mockReturnValue(chatResult({ sendMessage }));
      await render(<ChatScreen />);

      const input = screen.getByLabelText('Message');
      const localDraft = '  @GoPlanAI Preserve this draft  ';
      await fireEvent.changeText(input, localDraft);
      await fireEvent.press(screen.getByLabelText('Send message'));
      await act(async () => undefined);

      expect(input.props.value).toBe(localDraft);
      expect(screen.getByTestId('chat-composer-feedback')).toHaveTextContent(
        detail,
      );
    },
  );

  it('passes the correlated AI typing interaction to the transcript header', async () => {
    mockUseTripChat.mockReturnValue(
      chatResult({
        aiTypingState: {
          active: {
            interactionId: 'interaction-screen',
            requestedByUserId: 'user-me',
            startedAtMs: 1,
            visualExpiresAtMs: 120_001,
          },
        },
      }),
    );
    await render(<ChatScreen />);

    expect(
      screen.getByTestId('goplan-ai-typing-interaction-screen'),
    ).toBeTruthy();
  });

  it('plumbs a draft HTTP snapshot back through the resource-guarded hook callback', async () => {
    const tripId = '11111111-1111-4111-8111-111111111111';
    const source = makeDraftFixture();
    const cancelled = makeDraftFixture({
      status: 'CANCELLED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-10T00:01:00.000Z',
    });
    const applyAIDraftSnapshot = jest.fn();
    mockParams = { tripId };
    mockGetAIActionDraft.mockResolvedValue({ draft: source });
    mockCancelAIActionDraft.mockResolvedValue({ draft: cancelled });
    mockUseTripChat.mockReturnValue(
      chatResult({
        applyAIDraftSnapshot,
        messages: [
          {
            ...message('ai-message', 'Review this proposal.'),
            trip_id: tripId,
            sender: {
              id: null,
              display_name: 'GoPlanAI',
              identify_tag: null,
              avatar_url: null,
            },
            sender_kind: 'AI',
            ai_status: 'SUCCESS',
            action_drafts: [source],
          },
        ],
      }),
    );
    await render(<ChatScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Cancel this draft' }),
    );
    await act(async () => undefined);

    expect(mockGetAIActionDraft).toHaveBeenCalledWith(
      tripId,
      source.id,
      expect.any(AbortSignal),
    );
    expect(mockCancelAIActionDraft).toHaveBeenCalledWith(
      tripId,
      source.id,
      expect.any(AbortSignal),
    );
    expect(applyAIDraftSnapshot).toHaveBeenCalledWith({
      messageId: 'ai-message',
      draftId: source.id,
      expectedSourceIdentity: aiActionDraftSourceIdentity(source),
      draft: cancelled,
    });
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
