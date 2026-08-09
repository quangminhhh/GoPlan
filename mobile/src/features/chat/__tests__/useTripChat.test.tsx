import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockUseFocusEffect = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
}));

const mockUseSession = jest.fn();
jest.mock('@/features/auth/session', () => ({
  useSession: () => mockUseSession(),
}));

const mockUseTripDetail = jest.fn();
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (tripId: string | undefined) => mockUseTripDetail(tripId),
}));

const mockSendRealtime = jest.fn();
const mockSubscribeAll = jest.fn();
let mockRealtimeSnapshot: RealtimeSnapshot = {
  status: 'connected',
  connectionEpoch: 1,
};
const mockRealtimeTransport = {
  send: mockSendRealtime,
  subscribe: jest.fn(),
  subscribeAll: mockSubscribeAll,
};
jest.mock('@/features/realtime/application/RealtimeProvider', () => ({
  useRealtimeTransport: () => mockRealtimeTransport,
  useRealtimeSnapshot: () => mockRealtimeSnapshot,
}));

jest.mock('../api', () => ({
  addChatReaction: jest.fn(),
  deleteChatMessage: jest.fn(),
  gapFillChatMessages: jest.fn(),
  hideChatMessages: jest.fn(),
  listChatHistory: jest.fn(),
  normalizeChatApiError: jest.fn(),
  removeChatReaction: jest.fn(),
  sendChatMessage: jest.fn(),
  syncChangedChatMessages: jest.fn(),
}));

// eslint-disable-next-line import/first
import {
  addChatReaction,
  deleteChatMessage,
  gapFillChatMessages,
  hideChatMessages,
  listChatHistory,
  normalizeChatApiError,
  sendChatMessage,
  syncChangedChatMessages,
} from '../api';
// eslint-disable-next-line import/first
import {
  createChatClientMessageId,
  useTripChat,
  type ChatMutationOutcome,
  type ChatSendOutcome,
} from '../hooks/useTripChat';
// eslint-disable-next-line import/first
import type { ChatApiFailure, ChatMessage } from '../types';
// eslint-disable-next-line import/first
import type {
  RealtimeEnvelope,
  RealtimeSnapshot,
} from '@/features/realtime/types';
// eslint-disable-next-line import/first
import { useLayoutEffect } from 'react';

const mockListChatHistory = jest.mocked(listChatHistory);
const mockGapFillChatMessages = jest.mocked(gapFillChatMessages);
const mockSyncChangedChatMessages = jest.mocked(syncChangedChatMessages);
const mockSendChatMessage = jest.mocked(sendChatMessage);
const mockAddChatReaction = jest.mocked(addChatReaction);
const mockDeleteChatMessage = jest.mocked(deleteChatMessage);
const mockHideChatMessages = jest.mocked(hideChatMessages);
const mockNormalizeChatApiError = jest.mocked(normalizeChatApiError);

const TRIP_ID = 'a1111111-b111-4111-8111-c11111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const networkFailure: ChatApiFailure = {
  kind: 'network',
  message: 'Cannot reach the server.',
  errorCode: null,
  status: null,
  retryAfterMs: null,
  fieldErrors: null,
};

const throttledFailure: ChatApiFailure = {
  kind: 'throttled',
  message: 'Try again later.',
  errorCode: 'THROTTLED',
  status: 429,
  retryAfterMs: 30_000,
  fieldErrors: null,
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    trip_id: TRIP_ID,
    sender: {
      id: USER_ID,
      display_name: 'Minh',
      identify_tag: '@minh',
      avatar_url: null,
    },
    sender_kind: 'USER',
    ai_status: null,
    content: 'Hello',
    client_message_id: null,
    created_at: '2026-08-09T10:00:00.000Z',
    updated_at: '2026-08-09T10:00:00.000Z',
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: '2026-08-09T10:05:00.000Z',
    can_delete_for_everyone: true,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

let focusEffect: (() => (() => void) | void) | null = null;
let realtimeListener: ((event: RealtimeEnvelope) => void) | null = null;
const refreshTripDetail = jest.fn();

function readyTripDetail(
  tripId: string = TRIP_ID,
  status: 'ONGOING' | 'COMPLETED' | 'CANCELLED' = 'ONGOING',
) {
  return {
    detail: {
      trip: { id: tripId, status },
      my_membership: { status: 'ACTIVE' as const },
      members: [],
    },
    status: 'ready' as const,
    error: null,
    refreshing: false,
    refresh: refreshTripDetail,
    applyTrip: jest.fn(),
    applyStatus: jest.fn(),
  };
}

async function enterFocus(): Promise<() => void> {
  if (focusEffect === null) {
    throw new Error('Expected useFocusEffect to register a callback.');
  }
  let cleanup: (() => void) | void = undefined;
  await act(async () => {
    cleanup = focusEffect?.();
  });
  return typeof cleanup === 'function' ? cleanup : () => undefined;
}

async function captureInAct<T>(operation: () => Promise<T>): Promise<T> {
  let captured: T | undefined;
  await act(async () => {
    captured = await operation();
  });
  if (captured === undefined) {
    throw new Error('Expected the operation to produce an outcome.');
  }
  return captured;
}

async function emitRealtime(event: RealtimeEnvelope): Promise<void> {
  if (realtimeListener === null) {
    throw new Error('Expected a stable realtime listener.');
  }
  await act(async () => {
    realtimeListener?.(event);
  });
}

interface LayoutSendProbeOptions {
  readonly tripId: string;
  readonly sendDuringLayout: boolean;
  readonly onSend: (outcome: Promise<ChatSendOutcome>) => void;
}

function useTripChatWithLayoutSend({
  tripId,
  sendDuringLayout,
  onSend,
}: LayoutSendProbeOptions) {
  const chat = useTripChat({ tripId });
  const sendMessage = chat.sendMessage;
  useLayoutEffect(() => {
    if (sendDuringLayout) {
      onSend(sendMessage('Must not cross trip resources'));
    }
  }, [onSend, sendDuringLayout, sendMessage]);
  return chat;
}

describe('useTripChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    focusEffect = null;
    realtimeListener = null;
    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 1 };
    mockUseFocusEffect.mockImplementation(
      (effect: () => (() => void) | void) => {
        focusEffect = effect;
      },
    );
    mockUseSession.mockReturnValue({
      status: 'signedIn',
      user: {
        id: USER_ID,
        display_name: 'Minh',
        identify_tag: '@minh',
        avatar_url: null,
      },
    });
    mockUseTripDetail.mockReturnValue(readyTripDetail());
    mockSendRealtime.mockReturnValue(true);
    mockSubscribeAll.mockImplementation(
      (listener: (event: RealtimeEnvelope) => void) => {
        realtimeListener = listener;
        return () => {
          if (realtimeListener === listener) realtimeListener = null;
        };
      },
    );
    mockListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    mockGapFillChatMessages.mockResolvedValue({ results: [], has_more: false });
    mockSyncChangedChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    mockNormalizeChatApiError.mockReturnValue(networkFailure);
  });

  it.each([undefined, 'not-a-uuid'])(
    'suppresses all network and socket work for invalid route id %s',
    async (tripId) => {
    const { result } = await renderHook(() =>
      useTripChat({ tripId }),
    );
    await enterFocus();

    expect(result.current.isReadOnly).toBe(true);
    expect(mockListChatHistory).not.toHaveBeenCalled();
    expect(mockSendRealtime).not.toHaveBeenCalled();
    expect(mockSubscribeAll).not.toHaveBeenCalled();
    },
  );

  it('subscribes only on focus and once per connected epoch without rebinding listeners', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(mockSendRealtime).not.toHaveBeenCalled();
    expect(mockSubscribeAll).toHaveBeenCalledTimes(1);

    const blur = await enterFocus();
    expect(mockSendRealtime).toHaveBeenCalledWith({
      type: 'chat.subscribe',
      trip_id: TRIP_ID,
    });
    expect(mockSendRealtime).toHaveBeenCalledTimes(1);

    await view.rerender({});
    expect(mockSendRealtime).toHaveBeenCalledTimes(1);
    expect(mockSubscribeAll).toHaveBeenCalledTimes(1);

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    await waitFor(() => expect(mockSendRealtime).toHaveBeenCalledTimes(2));
    expect(mockSubscribeAll).toHaveBeenCalledTimes(1);

    await act(async () => blur());
    expect(mockSendRealtime).toHaveBeenLastCalledWith({
      type: 'chat.unsubscribe',
      trip_id: TRIP_ID,
    });
  });

  it('canonicalizes an uppercase deep-link id across detail, commands, ACKs, and messages', async () => {
    const uppercaseTripId = TRIP_ID.toUpperCase();
    const liveMessage = message({
      id: 'f3333333-a333-4333-8333-b33333333333',
      trip_id: uppercaseTripId,
      content: 'Canonical room event',
      change_sequence: 2,
    });
    const view = await renderHook(() =>
      useTripChat({ tripId: uppercaseTripId }),
    );
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(mockUseTripDetail).toHaveBeenLastCalledWith(TRIP_ID);

    const blur = await enterFocus();
    expect(mockSendRealtime).toHaveBeenLastCalledWith({
      type: 'chat.subscribe',
      trip_id: TRIP_ID,
    });
    await emitRealtime({
      type: 'chat.subscribed',
      trip_id: uppercaseTripId,
    });
    await emitRealtime({
      type: 'chat.message',
      trip_id: uppercaseTripId,
      message: liveMessage,
    });

    expect(view.result.current.subscriptionStatus).toBe('subscribed');
    expect(view.result.current.messages).toEqual([
      expect.objectContaining({
        id: liveMessage.id,
        trip_id: TRIP_ID,
      }),
    ]);
    await act(async () => blur());
    expect(mockSendRealtime).toHaveBeenLastCalledWith({
      type: 'chat.unsubscribe',
      trip_id: TRIP_ID,
    });
  });

  it('waits for subscribe acknowledgement and captures update cursor before gap-fill', async () => {
    const existing = message({ change_sequence: 10 });
    const missed = message({
      id: '44444444-4444-4444-8444-444444444444',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 11,
    });
    mockListChatHistory.mockResolvedValue({
      results: [existing],
      next_cursor: null,
    });
    mockGapFillChatMessages.mockResolvedValue({
      results: [missed],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    await enterFocus();
    expect(mockGapFillChatMessages).not.toHaveBeenCalled();

    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { since: existing.id, limit: 100 },
        expect.any(AbortSignal),
      ),
    );
    expect(mockSyncChangedChatMessages).toHaveBeenCalledWith(
      TRIP_ID,
      {
        changedSince: existing.change_sequence,
        changedSinceId: existing.id,
        limit: 100,
      },
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(view.result.current.messages).toHaveLength(2));
  });

  it('converges a websocket confirmation that arrives before a failed HTTP response', async () => {
    const pendingResponse = deferred<never>();
    mockSendChatMessage.mockReturnValueOnce(pendingResponse.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    let outcomePromise: Promise<ReturnType<typeof view.result.current.sendMessage> extends Promise<infer T> ? T : never>;
    await act(async () => {
      outcomePromise = view.result.current.sendMessage('Hello live');
      await Promise.resolve();
    });
    const sendInput = mockSendChatMessage.mock.calls[0]?.[1];
    if (sendInput === undefined) throw new Error('Expected a send request.');
    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: message({
        content: 'Hello live',
        client_message_id: sendInput.clientMessageId,
      }),
    });
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    pendingResponse.reject(new Error('timeout'));

    await expect(outcomePromise!).resolves.toMatchObject({ kind: 'created' });
    await waitFor(() => {
      expect(view.result.current.messages).toHaveLength(1);
      expect(view.result.current.pendingClientIds.size).toBe(0);
      expect(view.result.current.failedClientIds.size).toBe(0);
    });
  });

  it('retains a failed bubble and the same client id when its retry is throttled', async () => {
    mockSendChatMessage.mockRejectedValueOnce(new Error('offline'));
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    const firstOutcome: ChatSendOutcome = await captureInAct(() =>
      view.result.current.sendMessage('Keep this text'),
    );
    if (firstOutcome.kind !== 'failed') {
      throw new Error('Expected a retryable failed bubble.');
    }
    const clientMessageId = firstOutcome.clientMessageId;
    mockSendChatMessage.mockRejectedValueOnce(new Error('throttled'));
    mockNormalizeChatApiError.mockReturnValueOnce(throttledFailure);

    const retryOutcome = await captureInAct(() =>
      view.result.current.retryPending(clientMessageId),
    );

    expect(retryOutcome).toEqual({
      kind: 'failed',
      clientMessageId,
      error: throttledFailure,
    });
    expect(mockSendChatMessage.mock.calls[1]?.[1]).toMatchObject({
      clientMessageId,
      content: 'Keep this text',
    });
    expect(view.result.current.failedClientIds.has(clientMessageId)).toBe(true);
    expect(view.result.current.messages[0]?.content).toBe('Keep this text');
  });

  it('preserves history for a subscription-limit error but clears it on kicked', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    await enterFocus();
    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'SUBSCRIPTION_LIMIT_REACHED',
      detail: 'Too many chat subscriptions.',
    });

    expect(view.result.current.subscriptionStatus).toBe('rejected');
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.messages).toHaveLength(1);

    await emitRealtime({ type: 'chat.kicked', trip_id: TRIP_ID });
    expect(view.result.current.roomStatus).toBe('kicked');
    expect(view.result.current.messages).toEqual([]);
  });

  it('rejects an open pre-ack subscription error and accepts a later valid ack', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'FUTURE_SUBSCRIBE_REJECTION',
      detail: 'This subscription attempt was rejected.',
    });
    expect(view.result.current.subscriptionStatus).toBe('rejected');
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.roomError).toEqual({
      errorCode: 'FUTURE_SUBSCRIBE_REJECTION',
      detail: 'This subscription attempt was rejected.',
    });

    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    expect(view.result.current.subscriptionStatus).toBe('subscribed');
    expect(view.result.current.isReadOnly).toBe(false);
    expect(view.result.current.roomError).toBeNull();

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'POST_ACK_WARNING',
      detail: 'The healthy subscription remains active.',
    });
    expect(view.result.current.subscriptionStatus).toBe('subscribed');
    expect(view.result.current.isReadOnly).toBe(false);
    expect(view.result.current.roomError).toEqual({
      errorCode: 'POST_ACK_WARNING',
      detail: 'The healthy subscription remains active.',
    });
  });

  it('rolls a failed optimistic reaction back to the latest websocket base', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const pendingReaction = deferred<never>();
    mockAddChatReaction.mockReturnValueOnce(pendingReaction.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.toggleReaction(
        message().id,
        '👍',
      );
      await Promise.resolve();
    });
    expect(view.result.current.messages[0]?.reactions[0]?.emoji).toBe('👍');

    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: message().id,
      reactions: [{ emoji: '😂', count: 1, reacted_by_ids: ['other-user'] }],
      change_sequence: 2,
      updated_at: '2026-08-09T10:01:00.000Z',
    });
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    let outcome!: ChatMutationOutcome;
    await act(async () => {
      pendingReaction.reject(new Error('offline'));
      outcome = await outcomePromise;
    });

    expect(outcome.kind).toBe('rejected');
    expect(view.result.current.mutationError?.error).toEqual(networkFailure);
    expect(view.result.current.messages[0]?.reactions).toEqual([
      { emoji: '😂', count: 1, reacted_by_ids: ['other-user'] },
    ]);
  });

  it('accepts a matching live reaction echo when the HTTP response times out', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const pendingReaction = deferred<never>();
    mockAddChatReaction.mockReturnValueOnce(pendingReaction.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.toggleReaction(message().id, '👍');
      await Promise.resolve();
    });
    if (realtimeListener === null) {
      throw new Error('Expected a stable realtime listener.');
    }
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    let outcome!: ChatMutationOutcome;
    await act(async () => {
      realtimeListener?.({
        type: 'chat.reaction_update',
        trip_id: TRIP_ID,
        message_id: message().id,
        reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
        change_sequence: 2,
        updated_at: '2026-08-09T10:01:00.000Z',
      });
      pendingReaction.reject(new Error('timeout'));
      outcome = await outcomePromise;
    });

    expect(outcome).toEqual({ kind: 'applied' });
    await waitFor(() =>
      expect(view.result.current.pendingReactionMessageIds.size).toBe(0),
    );
    expect(view.result.current.mutationError).toBeNull();
    expect(view.result.current.messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, reacted_by_ids: [USER_ID] },
    ]);
  });

  it('retains the highest live reaction proof when callbacks arrive in reverse order', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const pendingReaction = deferred<never>();
    mockAddChatReaction.mockReturnValueOnce(pendingReaction.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.toggleReaction(message().id, '👍');
      await Promise.resolve();
    });
    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: message().id,
      reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
      change_sequence: 3,
      updated_at: '2026-08-09T10:03:00.000Z',
    });
    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: message().id,
      reactions: [{ emoji: '😂', count: 1, reacted_by_ids: ['other-user'] }],
      change_sequence: 2,
      updated_at: '2026-08-09T10:04:00.000Z',
    });
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    await act(async () => {
      pendingReaction.reject(new Error('timeout'));
    });

    await expect(outcomePromise).resolves.toEqual({ kind: 'applied' });
    expect(view.result.current.messages[0]).toMatchObject({
      change_sequence: 3,
      reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
    });
  });

  it('keeps a newer websocket reaction when an older REST success resolves later', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const pendingReaction = deferred<{
      reactions: readonly [];
      change_sequence: number;
      updated_at: string;
    }>();
    mockAddChatReaction.mockReturnValueOnce(pendingReaction.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.toggleReaction(message().id, '👍');
      await Promise.resolve();
    });
    const newestReactions = [
      { emoji: '😂' as const, count: 1, reacted_by_ids: ['other-user'] },
    ];
    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: message().id,
      reactions: newestReactions,
      change_sequence: 3,
      updated_at: '2026-08-09T10:03:00.000Z',
    });
    await act(async () => {
      pendingReaction.resolve({
        reactions: [],
        change_sequence: 2,
        updated_at: '2026-08-09T10:02:00.000Z',
      });
    });

    await expect(outcomePromise).resolves.toEqual({ kind: 'applied' });
    expect(view.result.current.messages[0]).toMatchObject({
      change_sequence: 3,
      reactions: newestReactions,
    });
  });

  it('accepts a live delete tombstone when the HTTP response times out', async () => {
    const original = message();
    const tombstone = message({
      content: '',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:01:00.000Z',
      deleted_for_everyone_by_id: USER_ID,
      can_delete_for_everyone: false,
    });
    mockListChatHistory.mockResolvedValue({
      results: [original],
      next_cursor: null,
    });
    const pendingDelete = deferred<never>();
    mockDeleteChatMessage.mockReturnValueOnce(pendingDelete.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.deleteMessage(
        original.id,
        'for_everyone',
      );
      await Promise.resolve();
    });
    if (realtimeListener === null) {
      throw new Error('Expected a stable realtime listener.');
    }
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    let outcome!: ChatMutationOutcome;
    await act(async () => {
      realtimeListener?.({
        type: 'chat.message_deleted',
        trip_id: TRIP_ID,
        message: tombstone,
      });
      pendingDelete.reject(new Error('timeout'));
      outcome = await outcomePromise;
    });

    expect(outcome).toEqual({ kind: 'applied' });
    await waitFor(() =>
      expect(view.result.current.pendingDeleteMessageIds.size).toBe(0),
    );
    expect(view.result.current.mutationError).toBeNull();
    expect(view.result.current.messages[0]?.is_deleted_for_everyone).toBe(true);
  });

  it('rejects a delete timeout when the live update is not a tombstone', async () => {
    const original = message();
    mockListChatHistory.mockResolvedValue({
      results: [original],
      next_cursor: null,
    });
    const pendingDelete = deferred<never>();
    mockDeleteChatMessage.mockReturnValueOnce(pendingDelete.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let outcomePromise!: Promise<ChatMutationOutcome>;
    await act(async () => {
      outcomePromise = view.result.current.deleteMessage(
        original.id,
        'for_everyone',
      );
      await Promise.resolve();
    });
    if (realtimeListener === null) {
      throw new Error('Expected a stable realtime listener.');
    }
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    let outcome!: ChatMutationOutcome;
    await act(async () => {
      realtimeListener?.({
        type: 'chat.message',
        trip_id: TRIP_ID,
        message: message({ content: 'Unrelated live edit' }),
      });
      pendingDelete.reject(new Error('timeout'));
      outcome = await outcomePromise;
    });

    expect(outcome).toEqual({ kind: 'rejected', error: networkFailure });
    expect(view.result.current.mutationError?.error).toEqual(networkFailure);
    expect(view.result.current.messages[0]?.is_deleted_for_everyone).toBe(false);
  });

  it('treats a transient trip-detail failure as retryable and recovers without remounting', async () => {
    const transientTripError = {
      kind: 'network' as const,
      message: 'Cannot reach the server.',
      status: 404,
    };
    const errorTripState = {
      ...readyTripDetail(),
      detail: null,
      status: 'error' as const,
      error: transientTripError,
    };
    let tripState: ReturnType<typeof readyTripDetail> | typeof errorTripState =
      errorTripState;
    refreshTripDetail.mockImplementation(async () => {
      tripState = readyTripDetail();
    });
    mockUseTripDetail.mockImplementation(() => tripState);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));

    expect(view.result.current.accessStatus).toBe('error');
    expect(view.result.current.roomError?.detail).toBe('Cannot reach the server.');
    expect(view.result.current.roomStatus).toBe('error');
    expect(mockListChatHistory).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.retryInitialLoad();
    });
    expect(mockListChatHistory).not.toHaveBeenCalled();
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('granted'));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));
    expect(mockListChatHistory.mock.calls[0]?.[2]?.aborted).toBe(false);
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(mockListChatHistory).toHaveBeenCalledTimes(1);
  });

  it('makes blur cleanup idempotent and never subscribes a reconnect while blurred', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const blur = await enterFocus();
    expect(mockSendRealtime).toHaveBeenCalledTimes(1);

    await act(async () => {
      blur();
      blur();
    });
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.unsubscribe',
      ),
    ).toHaveLength(1);

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.subscribe',
      ),
    ).toHaveLength(1);
    await view.unmount();
  });

  it('clears a hanging catch-up phase on blur before a rejected refocus', async () => {
    const hangingGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    mockGapFillChatMessages.mockReturnValueOnce(hangingGap.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const blurFirstFocus = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(true));

    await act(async () => blurFirstFocus());
    expect(view.result.current.isGapFilling).toBe(false);
    const blurSecondFocus = await enterFocus();
    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'FUTURE_SUBSCRIBE_REJECTION',
      detail: 'The refocused attempt was rejected.',
    });
    expect(view.result.current.subscriptionStatus).toBe('rejected');
    expect(view.result.current.isGapFilling).toBe(false);
    expect(view.result.current.isUpdating).toBe(false);

    await act(async () => {
      hangingGap.resolve({ results: [], has_more: false });
      await hangingGap.promise;
    });
    expect(view.result.current.isGapFilling).toBe(false);
    await act(async () => blurSecondFocus());
  });

  it('defers an acknowledgement catch-up until the first history anchor resolves', async () => {
    const history = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const anchor = message();
    mockListChatHistory.mockReturnValueOnce(history.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    expect(mockGapFillChatMessages).not.toHaveBeenCalled();

    await act(async () => {
      history.resolve({ results: [anchor], next_cursor: null });
      await history.promise;
    });
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { since: anchor.id, limit: 100 },
        expect.any(AbortSignal),
      ),
    );
  });

  it('keeps a newer catch-up active when an aborted older run settles later', async () => {
    const anchor = message();
    const olderRun = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const newerRun = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockReturnValueOnce(olderRun.promise)
      .mockReturnValueOnce(newerRun.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    const blurOlderRun = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));
    expect(view.result.current.isGapFilling).toBe(true);

    await act(async () => blurOlderRun());
    const blurNewerRun = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(view.result.current.isGapFilling).toBe(true);

    await act(async () => {
      olderRun.resolve({ results: [], has_more: false });
      await olderRun.promise;
      await Promise.resolve();
    });
    expect(view.result.current.isGapFilling).toBe(true);

    await act(async () => {
      newerRun.resolve({ results: [], has_more: false });
      await newerRun.promise;
    });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));
    await act(async () => blurNewerRun());
  });

  it('restarts catch-up after a stale unsubscribe overtakes rapid blur and refocus', async () => {
    const anchor = message();
    const staleResult = message({
      id: '88888888-8888-4888-8888-888888888888',
      content: 'Stale unsubscribe ordering',
    });
    const currentResult = message({
      id: '99999999-9999-4999-8999-999999999999',
      content: 'Fresh subscription ordering',
    });
    const staleGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const currentGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockReturnValueOnce(staleGap.promise)
      .mockReturnValueOnce(currentGap.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    const blurFirstAttempt = await enterFocus();
    await act(async () => blurFirstAttempt());
    const blurCurrentAttempt = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));

    await emitRealtime({ type: 'chat.unsubscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(view.result.current.isGapFilling).toBe(true);

    await act(async () => {
      staleGap.resolve({ results: [staleResult], has_more: false });
      await staleGap.promise;
      await Promise.resolve();
    });
    expect(view.result.current.isGapFilling).toBe(true);
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === staleResult.id,
      ),
    ).toBe(false);

    await act(async () => {
      currentGap.resolve({ results: [currentResult], has_more: false });
      await currentGap.promise;
    });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === currentResult.id,
      ),
    ).toBe(true);
    await act(async () => blurCurrentAttempt());
  });

  it('reconciles a new connection epoch before the previous catch-up request settles', async () => {
    const anchor = message();
    const staleMessage = message({
      id: '66666666-6666-4666-8666-666666666666',
      content: 'Stale epoch result',
    });
    const currentMessage = message({
      id: '77777777-7777-4777-8777-777777777777',
      content: 'Current epoch result',
    });
    const staleGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const currentGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockReturnValueOnce(staleGap.promise)
      .mockReturnValueOnce(currentGap.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const blur = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));
    expect(view.result.current.isGapFilling).toBe(true);

    mockRealtimeSnapshot = { status: 'reconnecting', connectionEpoch: 1 };
    await view.rerender({});
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    await waitFor(() =>
      expect(mockSendRealtime).toHaveBeenLastCalledWith({
        type: 'chat.subscribe',
        trip_id: TRIP_ID,
      }),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(view.result.current.isGapFilling).toBe(true);

    await act(async () => {
      staleGap.resolve({ results: [staleMessage], has_more: false });
      await staleGap.promise;
      await Promise.resolve();
    });
    expect(view.result.current.isGapFilling).toBe(true);
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === staleMessage.id,
      ),
    ).toBe(false);

    await act(async () => {
      currentGap.resolve({ results: [currentMessage], has_more: false });
      await currentGap.promise;
    });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === currentMessage.id,
      ),
    ).toBe(true);
    await act(async () => blur());
  });

  it('derives an update cursor after an empty-anchor fallback and recovers unknown patches', async () => {
    const fallbackHistory = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const oldSnapshot = message({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: 'Old snapshot',
      created_at: '2026-08-09T10:10:00.000Z',
      updated_at: '2026-08-09T10:10:00.000Z',
    });
    const authoritativeSnapshot = message({
      ...oldSnapshot,
      content: '',
      updated_at: '2026-08-09T10:11:00.000Z',
      change_sequence: 2,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:11:00.000Z',
      deleted_for_everyone_by_id: USER_ID,
      can_delete_for_everyone: false,
      reactions: [{ emoji: '😂', count: 1, reacted_by_ids: ['other-user'] }],
    });
    mockListChatHistory
      .mockResolvedValueOnce({ results: [], next_cursor: null })
      .mockReturnValueOnce(fallbackHistory.promise);
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [authoritativeSnapshot],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(view.result.current.messages).toEqual([]);
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(2));

    await emitRealtime({
      type: 'chat.message_deleted',
      trip_id: TRIP_ID,
      message: authoritativeSnapshot,
    });
    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: oldSnapshot.id,
      reactions: authoritativeSnapshot.reactions,
      change_sequence: authoritativeSnapshot.change_sequence,
      updated_at: authoritativeSnapshot.updated_at,
    });
    expect(view.result.current.messages).toEqual([]);

    await act(async () => {
      fallbackHistory.resolve({ results: [oldSnapshot], next_cursor: null });
      await fallbackHistory.promise;
    });
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          changedSince: oldSnapshot.change_sequence,
          changedSinceId: oldSnapshot.id,
          limit: 100,
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(view.result.current.messages[0]).toMatchObject({
        id: oldSnapshot.id,
        is_deleted_for_everyone: true,
        reactions: authoritativeSnapshot.reactions,
      }),
    );
  });

  it('uses the post-init version when a live message advances an empty fallback clock', async () => {
    const fallbackHistory = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const unrelatedLive = message({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      content: 'Unrelated live message',
      created_at: '2026-08-09T10:20:00.000Z',
      updated_at: '2026-08-09T10:20:00.000Z',
      change_sequence: 3,
    });
    const oldHistoryMessage = message({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      content: 'Old fallback snapshot',
      created_at: '2026-08-09T10:10:00.000Z',
      updated_at: '2026-08-09T10:10:00.000Z',
    });
    const authoritativeMessage = message({
      ...oldHistoryMessage,
      content: '',
      updated_at: '2026-08-09T10:11:00.000Z',
      change_sequence: 2,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:11:00.000Z',
      deleted_for_everyone_by_id: USER_ID,
      can_delete_for_everyone: false,
      reactions: [{ emoji: '😮', count: 1, reacted_by_ids: ['other-user'] }],
    });
    mockListChatHistory
      .mockResolvedValueOnce({ results: [], next_cursor: null })
      .mockReturnValueOnce(fallbackHistory.promise);
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [authoritativeMessage],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(2));

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: unrelatedLive,
    });
    expect(view.result.current.messages.map((item) => item.id)).toEqual([
      unrelatedLive.id,
    ]);

    await act(async () => {
      fallbackHistory.resolve({
        results: [oldHistoryMessage],
        next_cursor: null,
      });
      await fallbackHistory.promise;
    });
    await waitFor(() =>
      expect(view.result.current.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: unrelatedLive.id }),
          expect.objectContaining({
            id: oldHistoryMessage.id,
            is_deleted_for_everyone: true,
            reactions: authoritativeMessage.reactions,
          }),
        ]),
      ),
    );
  });

  it('exhausts gap and update pages with their independent cursors', async () => {
    const anchor = message();
    const gapOne = message({
      id: '44444444-4444-4444-8444-444444444444',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
    });
    const gapTwo = message({
      id: '55555555-5555-4555-8555-555555555555',
      created_at: '2026-08-09T10:02:00.000Z',
      updated_at: '2026-08-09T10:02:00.000Z',
      change_sequence: 3,
    });
    const updateOne = message({
      updated_at: '2026-08-09T10:03:00.000Z',
      change_sequence: 4,
      reactions: [{ emoji: '👍', count: 1, reacted_by_ids: ['other'] }],
    });
    const updateTwo = message({
      id: gapOne.id,
      created_at: gapOne.created_at,
      updated_at: '2026-08-09T10:04:00.000Z',
      change_sequence: 5,
      reactions: [{ emoji: '😂', count: 1, reacted_by_ids: ['other'] }],
    });
    mockListChatHistory.mockResolvedValue({ results: [anchor], next_cursor: null });
    mockGapFillChatMessages
      .mockResolvedValueOnce({ results: [gapOne], has_more: true })
      .mockResolvedValueOnce({ results: [gapTwo], has_more: false });
    mockSyncChangedChatMessages
      .mockResolvedValueOnce({ results: [updateOne], has_more: true })
      .mockResolvedValueOnce({ results: [updateTwo], has_more: false });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(mockGapFillChatMessages.mock.calls[1]?.[1]).toMatchObject({
      since: gapOne.id,
    });
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(2),
    );
    expect(mockSyncChangedChatMessages.mock.calls[1]?.[1]).toMatchObject({
      changedSince: updateOne.change_sequence,
      changedSinceId: updateOne.id,
    });
  });

  it('locks only the exact terminal code while unknown chat errors stay recoverable', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'FUTURE_CONFLICT',
      detail: 'A future recoverable conflict.',
    });
    expect(view.result.current.subscriptionStatus).not.toBe('rejected');
    expect(view.result.current.isReadOnly).toBe(false);
    expect(view.result.current.roomError).toEqual({
      errorCode: 'FUTURE_CONFLICT',
      detail: 'A future recoverable conflict.',
    });

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip is complete.',
    });
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.messages).toHaveLength(1);
  });

  it('clears optimistic mutation state when trip detail becomes terminal', async () => {
    const confirmed = message();
    let tripState = readyTripDetail();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({
      results: [confirmed],
      next_cursor: null,
    });
    mockSendChatMessage.mockRejectedValueOnce(new Error('offline'));
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    const outcome = await captureInAct(() =>
      view.result.current.sendMessage('Pending when terminal arrives'),
    );
    expect(outcome.kind).toBe('failed');
    expect(view.result.current.failedClientIds.size).toBe(1);
    expect(view.result.current.messages).toHaveLength(2);

    tripState = readyTripDetail(TRIP_ID, 'COMPLETED');
    await view.rerender({});
    await waitFor(() => expect(view.result.current.isReadOnly).toBe(true));
    await waitFor(() => expect(view.result.current.failedClientIds.size).toBe(0));
    expect(view.result.current.pendingClientIds.size).toBe(0);
    expect(view.result.current.messages).toEqual([confirmed]);

    await view.rerender({});
    expect(view.result.current.messages).toEqual([confirmed]);
    expect(view.result.current.failedClientIds.size).toBe(0);
  });

  it('single-flights older pagination and exposes a later page failure', async () => {
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockListChatHistory
      .mockResolvedValueOnce({ results: [message()], next_cursor: 'older-1' })
      .mockReturnValueOnce(olderPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    await act(async () => {
      void view.result.current.loadOlder();
      void view.result.current.loadOlder();
      await Promise.resolve();
    });
    expect(mockListChatHistory).toHaveBeenCalledTimes(2);
    await act(async () => {
      olderPage.resolve({
        results: [
          message({
            id: '66666666-6666-4666-8666-666666666666',
            created_at: '2026-08-09T09:59:00.000Z',
          }),
        ],
        next_cursor: 'older-2',
      });
      await olderPage.promise;
    });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(2));

    mockListChatHistory.mockRejectedValueOnce(new Error('offline'));
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(view.result.current.olderLoadError).toEqual(networkFailure);
  });

  it('applies delete-for-everyone, delete-for-me, and bulk hide outcomes', async () => {
    const first = message();
    const second = message({ id: '77777777-7777-4777-8777-777777777777' });
    const third = message({ id: '88888888-8888-4888-8888-888888888888' });
    mockListChatHistory.mockResolvedValue({
      results: [first, second, third],
      next_cursor: null,
    });
    mockDeleteChatMessage.mockResolvedValueOnce({
      mode: 'for_everyone',
      message: message({
        is_deleted_for_everyone: true,
        content: '',
        change_sequence: 2,
        reactions: [],
      }),
    });
    mockDeleteChatMessage.mockResolvedValueOnce({
      mode: 'for_me',
      hidden_message_ids: [second.id],
    });
    mockHideChatMessages.mockResolvedValueOnce({
      hidden_message_ids: [third.id],
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(3));

    await captureInAct(() =>
      view.result.current.deleteMessage(first.id, 'for_everyone'),
    );
    expect(
      view.result.current.messages.find((item) => item.id === first.id)
        ?.is_deleted_for_everyone,
    ).toBe(true);
    await captureInAct(() =>
      view.result.current.deleteMessage(second.id, 'for_me'),
    );
    expect(view.result.current.messages.some((item) => item.id === second.id)).toBe(
      false,
    );
    await captureInAct(() =>
      view.result.current.hideMessagesForMe([third.id]),
    );
    expect(view.result.current.messages).toHaveLength(1);
  });

  it('loads the new trip when the previous resource first page is still pending', async () => {
    const TRIP_B = '99999999-9999-4999-8999-999999999999';
    const firstPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockUseTripDetail.mockImplementation((id: string) => readyTripDetail(id));
    mockListChatHistory
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({
        results: [message({ trip_id: TRIP_B, content: 'Trip B' })],
        next_cursor: null,
      });
    const view = await renderHook(
      ({ id }: { id: string }) => useTripChat({ tripId: id }),
      { initialProps: { id: TRIP_ID } },
    );
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));
    const oldSignal = mockListChatHistory.mock.calls[0]?.[2];

    await view.rerender({ id: TRIP_B });
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(view.result.current.messages.map((item) => item.content)).toEqual([
        'Trip B',
      ]),
    );
    firstPage.resolve({ results: [message({ content: 'Stale A' })], next_cursor: null });
    await act(async () => {
      await firstPage.promise;
    });
    expect(view.result.current.messages.map((item) => item.content)).toEqual([
      'Trip B',
    ]);
  });

  it('fails closed during the commit before a switched resource resets', async () => {
    const tripB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const tripBHistory = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockUseTripDetail.mockImplementation((id: string) => readyTripDetail(id));
    mockListChatHistory
      .mockResolvedValueOnce({ results: [message()], next_cursor: null })
      .mockReturnValueOnce(tripBHistory.promise);
    let transitionOutcome: Promise<ChatSendOutcome> | null = null;
    const captureTransition = (outcome: Promise<ChatSendOutcome>) => {
      transitionOutcome ??= outcome;
    };
    const view = await renderHook(useTripChatWithLayoutSend, {
      initialProps: {
        tripId: TRIP_ID,
        sendDuringLayout: false,
        onSend: captureTransition,
      },
    });
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    await view.rerender({
      tripId: tripB,
      sendDuringLayout: true,
      onSend: captureTransition,
    });
    if (transitionOutcome === null) {
      throw new Error('Expected the layout transition to attempt a send.');
    }
    await expect(transitionOutcome).resolves.toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'CHAT_NOT_READY' },
    });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.pendingClientIds.size).toBe(0);

    await view.rerender({
      tripId: tripB,
      sendDuringLayout: false,
      onSend: captureTransition,
    });
    await act(async () => {
      tripBHistory.resolve({ results: [], next_cursor: null });
      await tripBHistory.promise;
    });
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    mockSendChatMessage.mockResolvedValueOnce({
      message: message({
        trip_id: tripB,
        content: 'Trip B message',
        client_message_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      disposition: 'created',
    });
    const normalOutcome = await captureInAct(() =>
      view.result.current.sendMessage('Trip B message'),
    );
    expect(normalOutcome.kind).toBe('created');
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    expect(mockSendChatMessage.mock.calls[0]?.[0]).toBe(tripB);
  });

  it('upserts live messages but applies delete patches only to known rows', async () => {
    const unknown = message({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await emitRealtime({
      type: 'chat.message_deleted',
      trip_id: TRIP_ID,
      message: { ...unknown, is_deleted_for_everyone: true, content: '' },
    });
    expect(view.result.current.messages).toHaveLength(0);

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: unknown,
    });
    expect(view.result.current.messages).toHaveLength(1);
    await emitRealtime({
      type: 'chat.message_deleted',
      trip_id: TRIP_ID,
      message: {
        ...unknown,
        is_deleted_for_everyone: true,
        content: '',
        change_sequence: 2,
      },
    });
    expect(view.result.current.messages[0]?.is_deleted_for_everyone).toBe(true);
  });

  it('generates an RFC4122 v4-shaped id when randomUUID is unavailable', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });
    try {
      expect(createChatClientMessageId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});
