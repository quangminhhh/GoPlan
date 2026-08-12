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

jest.mock('@/features/expenses/expenseEvents', () => ({
  publishExpenseEvent: jest.fn(),
}));

const mockSendRealtime = jest.fn();
const mockRetryConnection = jest.fn();
const mockSubscribeAll = jest.fn();
let mockRealtimeSnapshot: RealtimeSnapshot = {
  status: 'connected',
  connectionEpoch: 1,
};
const mockRealtimeTransport = {
  send: mockSendRealtime,
  retryConnection: mockRetryConnection,
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
  CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS,
  CHAT_SUBSCRIPTION_MAX_ATTEMPTS,
  CHAT_SUBSCRIPTION_RETRY_DELAY_MS,
  createChatClientMessageId,
  useTripChat,
  type ChatMutationOutcome,
  type ChatSendOutcome,
} from '../hooks/useTripChat';
// eslint-disable-next-line import/first
import { makeDraftFixture } from '../ai/__fixtures__/drafts';
// eslint-disable-next-line import/first
import { aiActionDraftSourceIdentity } from '../ai/drafts';
// eslint-disable-next-line import/first
import type { ChatApiFailure, ChatMessage } from '../types';
// eslint-disable-next-line import/first
import type {
  RealtimeEnvelope,
  RealtimeSnapshot,
} from '@/features/realtime/types';
// eslint-disable-next-line import/first
import { publishExpenseEvent } from '@/features/expenses/expenseEvents';
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
const mockPublishExpenseEvent = jest.mocked(publishExpenseEvent);

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

const terminalFailure: ChatApiFailure = {
  kind: 'message',
  message: 'This trip chat is read-only because the trip has ended.',
  errorCode: 'TRIP_TERMINAL',
  status: 409,
  retryAfterMs: null,
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

function aiDraftMessage(
  draft = makeDraftFixture(),
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return message({
    sender_kind: 'AI',
    ai_status: 'SUCCESS',
    sender: {
      id: null,
      display_name: 'GoPlanAI',
      identify_tag: null,
      avatar_url: null,
    },
    action_drafts: [draft],
    ...overrides,
  });
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

function retainedTripDetailFailure(message: string) {
  return {
    ...readyTripDetail(),
    error: {
      kind: 'network' as const,
      message,
      status: 500,
    },
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
    mockRetryConnection.mockReturnValue(false);
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
    mockPublishExpenseEvent.mockResolvedValue(undefined);
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

  it('forwards an explicit transport retry without changing chat ownership', async () => {
    mockRetryConnection.mockReturnValue(true);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    expect(view.result.current.retryConnection()).toBe(true);
    expect(mockRetryConnection).toHaveBeenCalledTimes(1);
    expect(mockSendRealtime).not.toHaveBeenCalled();
  });

  it('applies terminal authority reported by an AI draft controller to the room', async () => {
    const existing = message();
    mockListChatHistory.mockResolvedValue({
      results: [existing],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    await act(async () => {
      view.result.current.aiReconciliationCoordinator.reportAuthoritativeFailure(
        terminalFailure,
      );
    });

    expect(view.result.current.roomStatus).toBe('ready');
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.messages).toEqual([existing]);
    expect(view.result.current.roomError).toMatchObject({
      errorCode: 'TRIP_TERMINAL',
    });
  });

  it('kicks the room for exact access authority reported by an AI draft controller', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    await act(async () => {
      view.result.current.aiReconciliationCoordinator.reportAuthoritativeFailure({
        kind: 'message',
        message: 'You no longer have access to this trip.',
        errorCode: 'FORBIDDEN',
        status: 403,
        retryAfterMs: null,
        fieldErrors: null,
      });
    });

    expect(view.result.current.roomStatus).toBe('kicked');
    expect(view.result.current.messages).toEqual([]);
    expect(view.result.current.roomError).toMatchObject({
      errorCode: 'FORBIDDEN',
    });

    await act(async () => {
      view.result.current.aiReconciliationCoordinator.reportAuthoritativeFailure(
        terminalFailure,
      );
    });
    expect(view.result.current.roomStatus).toBe('kicked');
    expect(view.result.current.roomError).toMatchObject({
      errorCode: 'FORBIDDEN',
    });
  });

  it('fences an AI draft authority reporter after switching chat resources', async () => {
    const tripB = 'b2222222-c222-4222-8222-d22222222222';
    mockUseTripDetail.mockImplementation((id: string) => readyTripDetail(id));
    mockListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    const view = await renderHook(
      ({ id }: { id: string }) => useTripChat({ tripId: id }),
      { initialProps: { id: TRIP_ID } },
    );
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const staleCoordinator = view.result.current.aiReconciliationCoordinator;

    await view.rerender({ id: tripB });
    await waitFor(() =>
      expect(view.result.current.aiReconciliationCoordinator).not.toBe(
        staleCoordinator,
      ),
    );
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await act(async () => {
      staleCoordinator.reportAuthoritativeFailure(terminalFailure);
    });

    expect(view.result.current.isReadOnly).toBe(false);
    expect(view.result.current.roomError).toBeNull();
  });

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

  it('bounds missing subscription ACK recovery and exposes an in-place retry', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    jest.useFakeTimers();
    try {
      const blur = await enterFocus();
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);

      for (
        let attempt = 1;
        attempt < CHAT_SUBSCRIPTION_MAX_ATTEMPTS;
        attempt += 1
      ) {
        await act(async () => {
          jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS);
        });
        expect(
          mockSendRealtime.mock.calls.filter(
            ([command]) => command.type === 'chat.subscribe',
          ),
        ).toHaveLength(attempt + 1);
        expect(view.result.current.subscriptionStatus).toBe('subscribing');
      }

      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS);
      });
      expect(view.result.current.subscriptionStatus).toBe('rejected');
      expect(view.result.current.roomError).toEqual({
        errorCode: 'CHAT_SUBSCRIPTION_TIMEOUT',
        detail:
          'Live chat could not confirm this room after several attempts. Tap Retry live chat or reopen chat.',
      });

      await act(async () => view.result.current.retrySubscription());
      expect(view.result.current.subscriptionStatus).toBe('subscribing');
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(CHAT_SUBSCRIPTION_MAX_ATTEMPTS + 1);

      await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
      await waitFor(() =>
        expect(view.result.current.subscriptionStatus).toBe('subscribed'),
      );
      await waitFor(() =>
        expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1),
      );
      await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
      expect(mockListChatHistory).toHaveBeenCalledTimes(1);
      expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 2);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(CHAT_SUBSCRIPTION_MAX_ATTEMPTS + 1);
      await act(async () => blur());
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps subscription recovery alive when the room becomes terminal', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    jest.useFakeTimers();
    try {
      await enterFocus();
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);

      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'TRIP_TERMINAL',
        detail: 'The trip ended before subscription acknowledgement.',
      });
      expect(view.result.current.subscriptionStatus).toBe('subscribing');

      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
      expect(view.result.current.subscriptionStatus).toBe('subscribing');

      await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
      expect(view.result.current.subscriptionStatus).toBe('subscribed');
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 2);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('subscribes an already terminal trip for read updates only', async () => {
    mockUseTripDetail.mockReturnValue(readyTripDetail(TRIP_ID, 'COMPLETED'));
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    expect(view.result.current.isReadOnly).toBe(true);

    await enterFocus();

    expect(view.result.current.subscriptionStatus).toBe('subscribing');
    expect(
      mockSendRealtime.mock.calls.some(
        ([command]) => command.type === 'chat.subscribe',
      ),
    ).toBe(true);
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    expect(view.result.current.subscriptionStatus).toBe('subscribed');
    const blocked = await captureInAct(() =>
      view.result.current.sendMessage('Terminal rooms remain write-locked'),
    );
    expect(blocked).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'TRIP_TERMINAL' },
    });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it('cancels subscription recovery when chat loses focus', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    jest.useFakeTimers();
    try {
      const blur = await enterFocus();
      await act(async () => blur());
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 4);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);
      expect(view.result.current.subscriptionStatus).toBe('inactive');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['auth-loss', 'unmount'] as const)(
    'cancels subscription recovery on %s',
    async (lifecycleEvent) => {
      const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
      await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

      jest.useFakeTimers();
      try {
        await enterFocus();
        if (lifecycleEvent === 'auth-loss') {
          mockUseSession.mockReturnValue({ status: 'signedOut', user: null });
          await view.rerender({});
          await act(async () => {
            await Promise.resolve();
          });
        } else {
          await view.unmount();
        }

        await act(async () => {
          jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 4);
        });
        expect(
          mockSendRealtime.mock.calls.filter(
            ([command]) => command.type === 'chat.subscribe',
          ),
        ).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('invalidates the prior ACK timer when the connection epoch changes', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    jest.useFakeTimers();
    try {
      const blur = await enterFocus();
      mockRealtimeSnapshot = { status: 'reconnecting', connectionEpoch: 1 };
      await view.rerender({});
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 2);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);

      mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
      await view.rerender({});
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
      await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 2);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
      await act(async () => blur());
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a cleared stale subscription recovery callback', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    const scheduledTimeouts: {
      readonly callback: () => void;
      readonly delayMs: number | undefined;
    }[] = [];
    const setTimeoutSpy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(
        ((callback: () => void, delayMs?: number) => {
          scheduledTimeouts.push({ callback, delayMs });
          return scheduledTimeouts.length as unknown as ReturnType<
            typeof setTimeout
          >;
        }) as typeof setTimeout,
      );
    const clearTimeoutSpy = jest
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    try {
      const blur = await enterFocus();
      expect(scheduledTimeouts.map(({ delayMs }) => delayMs)).toEqual([
        CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS,
      ]);

      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'TRANSIENT_SUBSCRIPTION_FAILURE',
        detail: 'Retry this subscription.',
      });
      expect(scheduledTimeouts.map(({ delayMs }) => delayMs)).toEqual([
        CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS,
        CHAT_SUBSCRIPTION_RETRY_DELAY_MS,
      ]);

      await act(async () => {
        scheduledTimeouts[0]?.callback();
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);
      expect(view.result.current.subscriptionStatus).toBe('waiting');

      await act(async () => {
        scheduledTimeouts[1]?.callback();
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
      expect(view.result.current.subscriptionStatus).toBe('subscribing');
      await act(async () => blur());
    } finally {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('bounds recovery when the transport initially refuses subscription sends', async () => {
    mockSendRealtime.mockReturnValue(false);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    jest.useFakeTimers();
    try {
      const blur = await enterFocus();
      expect(view.result.current.subscriptionStatus).toBe('waiting');
      await act(async () => {
        jest.advanceTimersByTime(
          CHAT_SUBSCRIPTION_RETRY_DELAY_MS * CHAT_SUBSCRIPTION_MAX_ATTEMPTS,
        );
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(CHAT_SUBSCRIPTION_MAX_ATTEMPTS);
      expect(view.result.current.subscriptionStatus).toBe('rejected');
      await act(async () => blur());
    } finally {
      jest.useRealTimers();
    }
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

  it('correlates AI typing only inside the current focused acknowledged subscription', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'before-focus',
      requested_by_user_id: USER_ID,
    });
    expect(view.result.current.aiTypingState.active).toBeNull();

    const blur = await enterFocus();
    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'before-ack',
      requested_by_user_id: USER_ID,
    });
    expect(view.result.current.aiTypingState.active).toBeNull();

    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'interaction-old',
      requested_by_user_id: USER_ID,
    });
    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'interaction-current',
      requested_by_user_id: null,
    });
    await emitRealtime({
      type: 'chat.ai_typing_stopped',
      trip_id: TRIP_ID,
      interaction_id: 'interaction-old',
    });

    expect(view.result.current.aiTypingState.active).toMatchObject({
      interactionId: 'interaction-current',
      requestedByUserId: null,
    });

    await act(async () => blur());
    expect(view.result.current.aiTypingState.active).toBeNull();
    await emitRealtime({
      type: 'chat.ai_typing_stopped',
      trip_id: TRIP_ID,
      interaction_id: 'interaction-current',
    });
    expect(view.result.current.aiTypingState.active).toBeNull();
  });

  it('uses the 120-second AI typing fallback only as a disposable visual timer', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const blur = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    jest.useFakeTimers();
    try {
      await emitRealtime({
        type: 'chat.ai_typing_started',
        trip_id: TRIP_ID,
        interaction_id: 'interaction-timeout',
        requested_by_user_id: USER_ID,
      });
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        'interaction-timeout',
      );

      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(view.result.current.aiTypingState.active).toBeNull();
      expect(mockSendRealtime).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat.ai_typing_stopped' }),
      );

      await emitRealtime({
        type: 'chat.ai_typing_started',
        trip_id: TRIP_ID,
        interaction_id: 'interaction-dispose',
        requested_by_user_id: USER_ID,
      });
      await act(async () => blur());
      expect(view.result.current.aiTypingState.active).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(view.result.current.aiTypingState.active).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears AI typing on unsubscribe, connection epoch change, kick, and resource switch', async () => {
    const tripB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockUseTripDetail.mockImplementation((id: string) => readyTripDetail(id));
    const view = await renderHook(
      ({ id }: { id: string }) => useTripChat({ tripId: id }),
      { initialProps: { id: TRIP_ID } },
    );
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    const start = async (interactionId: string) => {
      await emitRealtime({
        type: 'chat.ai_typing_started',
        trip_id: TRIP_ID,
        interaction_id: interactionId,
        requested_by_user_id: USER_ID,
      });
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        interactionId,
      );
    };

    await start('before-unsubscribe');
    await emitRealtime({ type: 'chat.unsubscribed', trip_id: TRIP_ID });
    expect(view.result.current.aiTypingState.active).toBeNull();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await start('before-reconnect');
    mockRealtimeSnapshot = { status: 'reconnecting', connectionEpoch: 1 };
    await view.rerender({ id: TRIP_ID });
    expect(view.result.current.aiTypingState.active).toBeNull();

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({ id: TRIP_ID });
    await waitFor(() =>
      expect(mockSendRealtime).toHaveBeenLastCalledWith({
        type: 'chat.subscribe',
        trip_id: TRIP_ID,
      }),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await start('before-kick');
    await emitRealtime({ type: 'chat.kicked', trip_id: TRIP_ID });
    expect(view.result.current.aiTypingState.active).toBeNull();
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.unsubscribe',
      ),
    ).toHaveLength(1);

    await view.rerender({ id: tripB });
    expect(view.result.current.aiTypingState.active).toBeNull();
  });

  it('exposes a stable resource-guarded AI draft snapshot projection', async () => {
    const tripB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const source = makeDraftFixture();
    const projected = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      updated_at: '2026-08-09T10:01:00.000Z',
    });
    const aiRow = message({
      sender_kind: 'AI',
      ai_status: 'SUCCESS',
      sender: {
        id: null,
        display_name: 'GoPlanAI',
        identify_tag: null,
        avatar_url: null,
      },
      action_drafts: [source],
      change_sequence: 10,
    });
    mockUseTripDetail.mockImplementation((id: string) => readyTripDetail(id));
    mockListChatHistory
      .mockResolvedValueOnce({ results: [aiRow], next_cursor: null })
      .mockResolvedValueOnce({ results: [], next_cursor: null });
    const view = await renderHook(
      ({ id }: { id: string }) => useTripChat({ tripId: id }),
      { initialProps: { id: TRIP_ID } },
    );
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    const callback = view.result.current.applyAIDraftSnapshot;

    await act(async () => {
      callback({
        messageId: aiRow.id,
        draftId: source.id,
        expectedSourceIdentity: aiActionDraftSourceIdentity(source),
        draft: projected,
      });
    });
    expect(view.result.current.messages[0]).toMatchObject({
      change_sequence: 10,
      action_drafts: [projected],
    });
    expect(view.result.current.applyAIDraftSnapshot).toBe(callback);

    await view.rerender({ id: tripB });
    await act(async () => {
      callback({
        messageId: aiRow.id,
        draftId: source.id,
        expectedSourceIdentity: aiActionDraftSourceIdentity(projected),
        draft: source,
      });
    });
    expect(view.result.current.messages).toEqual([]);
  });

  it('reconciles an offscreen websocket CONFIRMED transition without a mounted draft card', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-offscreen' },
    });
    const aiRow = aiDraftMessage(source, { change_sequence: 10 });
    mockListChatHistory.mockResolvedValue({
      results: [aiRow],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: {
        ...aiRow,
        action_drafts: [confirmed],
        change_sequence: 11,
      },
    });
    await waitFor(() => expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1));
    expect(mockPublishExpenseEvent).toHaveBeenCalledWith({
      type: 'expensesChanged',
      tripId: TRIP_ID,
    });
  });

  it('retains an offscreen reconciliation failure across a reconnect acknowledgement', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-reconnect-failure' },
    });
    const aiRow = aiDraftMessage(source, { change_sequence: 10 });
    mockListChatHistory.mockResolvedValue({
      results: [aiRow],
      next_cursor: null,
    });
    mockPublishExpenseEvent.mockRejectedValueOnce(
      new Error('Expense refresh publisher failed.'),
    );
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: {
        ...aiRow,
        action_drafts: [confirmed],
        change_sequence: 11,
      },
    });
    await waitFor(() =>
      expect(view.result.current.roomError).toMatchObject({
        errorCode: 'AI_RECONCILIATION_FAILED',
      }),
    );

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'SUBSCRIPTION_LIMIT_REACHED',
      detail: 'The reconnect subscription was rejected.',
    });
    expect(view.result.current.roomError).toEqual({
      errorCode: 'SUBSCRIPTION_LIMIT_REACHED',
      detail: 'The reconnect subscription was rejected.',
    });
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    expect(view.result.current.roomError).toMatchObject({
      errorCode: 'AI_RECONCILIATION_FAILED',
    });
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip has ended.',
    });
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip has ended.',
    });

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 3 };
    await view.rerender({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.subscribe',
      ),
    ).toHaveLength(3);
    expect(view.result.current.subscriptionStatus).toBe('subscribing');
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    expect(view.result.current.subscriptionStatus).toBe('subscribed');
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip has ended.',
    });
  });

  it('seeds initially CONFIRMED history without publishing reconciliation', async () => {
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      result: { expense_id: 'expense-history' },
    });
    mockListChatHistory.mockResolvedValue({
      results: [aiDraftMessage(confirmed)],
      next_cursor: null,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();
  });

  it('shares one reconciliation claim between a local HTTP snapshot and websocket confirmation', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-shared' },
    });
    const aiRow = aiDraftMessage(source, { change_sequence: 10 });
    mockListChatHistory.mockResolvedValue({
      results: [aiRow],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    await act(async () => {
      await view.result.current.applyAIDraftSnapshot({
        messageId: aiRow.id,
        draftId: source.id,
        expectedSourceIdentity: aiActionDraftSourceIdentity(source),
        draft: confirmed,
      });
      realtimeListener?.({
        type: 'chat.message',
        trip_id: TRIP_ID,
        message: {
          ...aiRow,
          action_drafts: [confirmed],
          change_sequence: 11,
        },
      });
      await Promise.resolve();
    });

    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
  });

  it('reconciles a CONFIRMED transition accepted through changed-message catch-up', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-catch-up' },
    });
    const aiRow = aiDraftMessage(source, { change_sequence: 10 });
    mockListChatHistory.mockResolvedValue({
      results: [aiRow],
      next_cursor: null,
    });
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [],
      has_more: false,
    });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [
        {
          ...aiRow,
          action_drafts: [confirmed],
          change_sequence: 11,
        },
      ],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() => expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1));
  });

  it('reconciles deferred CONFIRMED authority exactly once when older history materializes it', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-deferred-history' },
    });
    const anchor = message({
      id: '44444444-4444-4444-8444-444444444444',
      change_sequence: 20,
      created_at: '2026-08-09T11:00:00.000Z',
      updated_at: '2026-08-09T11:00:00.000Z',
    });
    const unloadedReady = aiDraftMessage(source, {
      id: '55555555-5555-4555-8555-555555555555',
      change_sequence: 10,
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const deferredConfirmed = {
      ...unloadedReady,
      action_drafts: [confirmed],
      change_sequence: 21,
      updated_at: '2026-08-09T10:01:00.000Z',
    };
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockResolvedValueOnce({ results: [unloadedReady], next_cursor: null });
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [],
      has_more: false,
    });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [deferredConfirmed],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(1),
    );
    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.loadOlder();
    });

    await waitFor(() => expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1));
    expect(
      view.result.current.messages.find(
        (candidate) => candidate.id === unloadedReady.id,
      )?.action_drafts,
    ).toEqual([confirmed]);

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: { ...deferredConfirmed, change_sequence: 22 },
    });
    expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1);
  });

  it('does not republish a draft already CONFIRMED in the raw older row', async () => {
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T09:00:00.000Z',
      result: { expense_id: 'expense-already-confirmed' },
    });
    const anchor = message({
      id: '44444444-4444-4444-8444-444444444444',
      change_sequence: 20,
      created_at: '2026-08-09T11:00:00.000Z',
      updated_at: '2026-08-09T11:00:00.000Z',
    });
    const rawConfirmed = aiDraftMessage(confirmed, {
      id: '55555555-5555-4555-8555-555555555555',
      content: 'Older confirmed snapshot',
      change_sequence: 10,
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const deferredContentChange = {
      ...rawConfirmed,
      content: 'Confirmed row with a later non-draft change',
      change_sequence: 21,
      updated_at: '2026-08-09T10:01:00.000Z',
    };
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockResolvedValueOnce({ results: [rawConfirmed], next_cursor: null });
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [],
      has_more: false,
    });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [deferredContentChange],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      await view.result.current.loadOlder();
    });

    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();
    expect(
      view.result.current.messages.find(
        (candidate) => candidate.id === rawConfirmed.id,
      )?.content,
    ).toBe(deferredContentChange.content);
  });

  it('reconciles a CONFIRMED initial response that overtakes a live READY row while history is pending', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-init-overlap' },
    });
    const readyRow = aiDraftMessage(source, { change_sequence: 10 });
    const initialPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: null;
    }>();
    mockListChatHistory.mockReturnValueOnce(initialPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));
    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: readyRow,
    });

    await act(async () => {
      initialPage.resolve({
        results: [
          {
            ...readyRow,
            action_drafts: [confirmed],
            change_sequence: 11,
          },
        ],
        next_cursor: null,
      });
      await initialPage.promise;
    });

    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await waitFor(() => expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1));
  });

  it('reconciles a CONFIRMED older page that overtakes a live READY row while pagination is pending', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'expense-older-overlap' },
    });
    const anchor = message({
      id: '44444444-4444-4444-8444-444444444444',
      change_sequence: 20,
    });
    const readyRow = aiDraftMessage(source, {
      id: '55555555-5555-4555-8555-555555555555',
      change_sequence: 10,
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: null;
    }>();
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockReturnValueOnce(olderPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    let loadPromise!: Promise<void>;
    await act(async () => {
      loadPromise = view.result.current.loadOlder();
      await Promise.resolve();
    });
    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: readyRow,
    });
    await act(async () => {
      olderPage.resolve({
        results: [
          {
            ...readyRow,
            action_drafts: [confirmed],
            change_sequence: 11,
          },
        ],
        next_cursor: null,
      });
      await loadPromise;
    });

    await waitFor(() => expect(mockPublishExpenseEvent).toHaveBeenCalledTimes(1));
  });

  it('does not reparse existing AI drafts for ordinary user UPSERT or PATCH_KNOWN rows', async () => {
    let draftPropertyReads = 0;
    const trackedDraft = new Proxy(makeDraftFixture(), {
      get(target, property, receiver) {
        draftPropertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    mockListChatHistory.mockResolvedValue({
      results: [aiDraftMessage(trackedDraft)],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const readsAfterSeed = draftPropertyReads;
    const userRow = message({
      id: '66666666-6666-4666-8666-666666666666',
      change_sequence: 30,
    });

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: userRow,
    });
    await emitRealtime({
      type: 'chat.message_deleted',
      trip_id: TRIP_ID,
      message: {
        ...userRow,
        content: '',
        is_deleted_for_everyone: true,
        change_sequence: 31,
      },
    });

    expect(draftPropertyReads).toBe(readsAfterSeed);
  });

  it('fails closed when a confirmed transition still has a duplicate draft id elsewhere in the room', async () => {
    const source = makeDraftFixture();
    const confirmed = makeDraftFixture({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      updated_at: '2026-08-09T10:01:00.000Z',
      result: { expense_id: 'must-not-publish-duplicate' },
    });
    const first = aiDraftMessage(source, { change_sequence: 10 });
    const duplicate = aiDraftMessage(source, {
      id: '77777777-7777-4777-8777-777777777777',
      change_sequence: 9,
    });
    mockListChatHistory.mockResolvedValue({
      results: [first, duplicate],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(2));
    expect(view.result.current.ambiguousAIDraftIds.has(source.id)).toBe(true);

    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: {
        ...first,
        action_drafts: [confirmed],
        change_sequence: 11,
      },
    });

    expect(mockPublishExpenseEvent).not.toHaveBeenCalled();
    expect(view.result.current.ambiguousAIDraftIds.has(source.id)).toBe(true);
  });

  it('trims only outer message whitespace before sending while preserving internal spacing', async () => {
    const rawContent = '  @goplanai Keep  internal\nspacing  ';
    mockSendChatMessage.mockImplementationOnce(async (_tripId, input) => ({
      disposition: 'created',
      message: message({
        client_message_id: input.clientMessageId,
        content: '@GoPlanAI Keep internal spacing',
      }),
    }));
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));

    const outcome = await captureInAct(() =>
      view.result.current.sendMessage(rawContent),
    );
    expect(outcome.kind).toBe('created');
    expect(mockSendChatMessage.mock.calls[0]?.[1].content).toBe(
      '@goplanai Keep  internal\nspacing',
    );

    const empty = await captureInAct(() =>
      view.result.current.sendMessage(' \n '),
    );
    expect(empty).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'INVALID_CONTENT' },
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
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

  it('blocks a second same-render send after terminal authority settles the first', async () => {
    mockSendChatMessage.mockRejectedValueOnce(new Error('trip ended'));
    mockNormalizeChatApiError.mockReturnValueOnce(terminalFailure);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    const staleSend = view.result.current.sendMessage;
    let firstOutcome!: ChatSendOutcome;
    let secondOutcome!: ChatSendOutcome;

    await act(async () => {
      firstOutcome = await staleSend('First terminal send');
      secondOutcome = await staleSend('Must be synchronously blocked');
    });

    expect(firstOutcome).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'TRIP_TERMINAL' },
    });
    expect(secondOutcome).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'TRIP_TERMINAL' },
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    expect(view.result.current.pendingClientIds.size).toBe(0);
  });

  it('blocks a stale send callback in the same tick that rejects the current subscription', async () => {
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    const staleSend = view.result.current.sendMessage;
    let outcome!: ChatSendOutcome;

    await act(async () => {
      realtimeListener?.({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'SUBSCRIPTION_LIMIT_REACHED',
        detail: 'Too many chat subscriptions.',
      });
      outcome = await staleSend('Must be synchronously blocked');
    });

    expect(outcome).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'SUBSCRIPTION_LIMIT_REACHED' },
    });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(view.result.current.pendingClientIds.size).toBe(0);
    expect(view.result.current.subscriptionStatus).toBe('rejected');
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
    jest.useFakeTimers();
    try {
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
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_ACK_TIMEOUT_MS * 4);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);

      await act(async () => view.result.current.retrySubscription());
      expect(view.result.current.subscriptionStatus).toBe('subscribing');
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);
      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'SUBSCRIPTION_LIMIT_REACHED',
        detail: 'Too many chat subscriptions.',
      });
      expect(view.result.current.subscriptionStatus).toBe('rejected');

      await emitRealtime({ type: 'chat.kicked', trip_id: TRIP_ID });
      expect(view.result.current.roomStatus).toBe('kicked');
      expect(view.result.current.messages).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers an open pre-ack subscription error and accepts a later valid ack', async () => {
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    jest.useFakeTimers();
    try {
      await enterFocus();
      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'FUTURE_SUBSCRIBE_REJECTION',
        detail: 'This subscription attempt was rejected.',
      });
      expect(view.result.current.subscriptionStatus).toBe('waiting');
      expect(view.result.current.isReadOnly).toBe(false);
      expect(view.result.current.roomError).toEqual({
        errorCode: 'FUTURE_SUBSCRIBE_REJECTION',
        detail: 'This subscription attempt was rejected.',
      });
      await act(async () => {
        jest.advanceTimersByTime(CHAT_SUBSCRIPTION_RETRY_DELAY_MS);
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2);

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
    } finally {
      jest.useRealTimers();
    }
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

  it('restarts subscription, catch-up, and AI typing after a retained-detail access error without reloading history', async () => {
    const anchor = message();
    const missed = message({
      id: '99999999-9999-4999-8999-999999999999',
      content: 'Recovered by catch-up',
      change_sequence: 2,
    });
    const transientState = retainedTripDetailFailure(
      'Temporary trip-detail failure.',
    );
    let tripState: ReturnType<typeof readyTripDetail> | typeof transientState =
      readyTripDetail();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockResolvedValueOnce({ results: [], has_more: false })
      .mockResolvedValueOnce({ results: [missed], has_more: false });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    const blur = await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));
    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'before-transient-error',
      requested_by_user_id: USER_ID,
    });
    expect(view.result.current.aiTypingState.active?.interactionId).toBe(
      'before-transient-error',
    );

    tripState = transientState;
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('error'));
    // The transcript is hidden while authority is unknown, but the reducer
    // history must survive and reappear without another first-page load.
    expect(view.result.current.messages).toEqual([]);
    expect(view.result.current.aiTypingState.active).toBeNull();
    expect(view.result.current.subscriptionStatus).toBe('inactive');
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.unsubscribe',
      ),
    ).toHaveLength(1);

    tripState = readyTripDetail();
    await view.rerender({});
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    expect(mockListChatHistory).toHaveBeenCalledTimes(1);
    expect(view.result.current.subscriptionStatus).toBe('subscribing');
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.result.current.messages.map((item) => item.id)).toEqual([
        anchor.id,
        missed.id,
      ]),
    );
    await emitRealtime({
      type: 'chat.ai_typing_started',
      trip_id: TRIP_ID,
      interaction_id: 'after-transient-error',
      requested_by_user_id: USER_ID,
    });
    expect(view.result.current.aiTypingState.active?.interactionId).toBe(
      'after-transient-error',
    );
    await act(async () => blur());
  });

  it('retains the pre-gap reconciliation floor through transient access suspension', async () => {
    const anchor = message();
    const highSequenceGapMessage = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'Partial gap row before access became uncertain',
      created_at: '2026-08-09T10:02:00.000Z',
      updated_at: '2026-08-09T10:02:00.000Z',
      change_sequence: 100,
    });
    const updatedAnchor = message({
      content: 'Lower-sequence update recovered after access returned',
      updated_at: '2026-08-09T10:00:30.000Z',
      change_sequence: 50,
    });
    const interruptedPage = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const transientState = retainedTripDetailFailure(
      'Temporary trip-detail failure during partial catch-up.',
    );
    let tripState: ReturnType<typeof readyTripDetail> | typeof transientState =
      readyTripDetail();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockResolvedValueOnce({
        results: [highSequenceGapMessage],
        has_more: true,
      })
      .mockReturnValueOnce(interruptedPage.promise)
      .mockResolvedValueOnce({ results: [], has_more: false });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [updatedAnchor],
      has_more: false,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === highSequenceGapMessage.id,
      ),
    ).toBe(true);

    tripState = transientState;
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('error'));
    tripState = readyTripDetail();
    await view.rerender({});
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenLastCalledWith(
        TRIP_ID,
        { since: highSequenceGapMessage.id, limit: 100 },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          changedSince: anchor.change_sequence,
          changedSinceId: anchor.id,
          limit: 100,
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        view.result.current.messages.find(
          (candidate) => candidate.id === anchor.id,
        )?.content,
      ).toBe(updatedAnchor.content),
    );

    await act(async () => {
      interruptedPage.resolve({ results: [], has_more: false });
      await interruptedPage.promise;
    });
  });

  it('atomically suspends in-flight chat work for a retained-detail refresh error', async () => {
    const reactionRow = message();
    const deleteRow = message({
      id: '77777777-7777-4777-8777-777777777777',
      content: 'Delete pending',
    });
    const hideRow = message({
      id: '88888888-8888-4888-8888-888888888888',
      content: 'Hide pending',
    });
    const transientState = retainedTripDetailFailure(
      'Trip authority is temporarily unknown.',
    );
    let tripState: ReturnType<typeof readyTripDetail> | typeof transientState =
      readyTripDetail();
    const pendingGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const pendingOlder = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const pendingSend = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    const pendingReaction = deferred<
      Awaited<ReturnType<typeof addChatReaction>>
    >();
    const pendingDelete = deferred<
      Awaited<ReturnType<typeof deleteChatMessage>>
    >();
    const pendingHide = deferred<Awaited<ReturnType<typeof hideChatMessages>>>();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory
      .mockResolvedValueOnce({
        results: [reactionRow, deleteRow, hideRow],
        next_cursor: 'older-page',
      })
      .mockReturnValueOnce(pendingOlder.promise);
    mockGapFillChatMessages.mockReturnValueOnce(pendingGap.promise);
    mockSendChatMessage
      .mockRejectedValueOnce(new Error('offline before suspension'))
      .mockReturnValueOnce(pendingSend.promise);
    mockAddChatReaction.mockReturnValueOnce(pendingReaction.promise);
    mockDeleteChatMessage.mockReturnValueOnce(pendingDelete.promise);
    mockHideChatMessages.mockReturnValueOnce(pendingHide.promise);

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(3));
    const priorFailure = await captureInAct(() =>
      view.result.current.sendMessage('Already failed before suspension'),
    );
    if (priorFailure.kind !== 'failed') {
      throw new Error('Expected a pre-existing retryable failed send.');
    }
    const priorFailedClientId = priorFailure.clientMessageId;
    expect(view.result.current.failedByClientId.get(priorFailedClientId)).toEqual(
      networkFailure,
    );
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(true));

    let sendOutcome!: Promise<ChatSendOutcome>;
    let reactionOutcome!: Promise<ChatMutationOutcome>;
    let deleteOutcome!: Promise<ChatMutationOutcome>;
    let hideOutcome!: Promise<ChatMutationOutcome>;
    await act(async () => {
      void view.result.current.loadOlder();
      sendOutcome = view.result.current.sendMessage('Retry me after recovery');
      reactionOutcome = view.result.current.toggleReaction(reactionRow.id, '👍');
      deleteOutcome = view.result.current.deleteMessage(
        deleteRow.id,
        'for_everyone',
      );
      hideOutcome = view.result.current.hideMessagesForMe([hideRow.id]);
      await Promise.resolve();
    });
    const clientMessageId = mockSendChatMessage.mock.calls[1]?.[1]
      .clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error('Expected an active send client id.');
    }
    expect(view.result.current.isLoadingOlder).toBe(true);
    expect(view.result.current.pendingReactionMessageIds.has(reactionRow.id)).toBe(
      true,
    );
    expect(view.result.current.pendingDeleteMessageIds.has(deleteRow.id)).toBe(
      true,
    );
    expect(view.result.current.isHidingMessages).toBe(true);

    tripState = transientState;
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('error'));
    await waitFor(() => expect(view.result.current.isLoadingOlder).toBe(false));
    expect(view.result.current.isGapFilling).toBe(false);
    expect(view.result.current.isUpdating).toBe(false);
    expect(view.result.current.pendingReactionMessageIds.size).toBe(0);
    expect(view.result.current.pendingDeleteMessageIds.size).toBe(0);
    expect(view.result.current.isHidingMessages).toBe(false);
    expect(view.result.current.failedClientIds.has(clientMessageId)).toBe(true);
    expect(view.result.current.failedByClientId.get(clientMessageId)).toMatchObject({
      errorCode: 'CHAT_ACCESS_UNCERTAIN',
    });
    expect(view.result.current.failedByClientId.get(priorFailedClientId)).toEqual(
      networkFailure,
    );
    expect(view.result.current.mutationError).toMatchObject({
      error: { errorCode: 'CHAT_MUTATION_INTERRUPTED' },
    });
    expect(view.result.current.messages).toEqual([]);
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.unsubscribe',
      ),
    ).toHaveLength(1);
    expect(
      [
        mockGapFillChatMessages.mock.calls[0]?.[2],
        mockListChatHistory.mock.calls[1]?.[2],
        mockSendChatMessage.mock.calls[1]?.[2],
        mockAddChatReaction.mock.calls[0]?.[3],
        mockDeleteChatMessage.mock.calls[0]?.[3],
        mockHideChatMessages.mock.calls[0]?.[2],
      ].every((signal) => signal?.aborted === true),
    ).toBe(true);

    const blockedSend = await captureInAct(() =>
      view.result.current.sendMessage('Must wait for access recovery'),
    );
    const blockedReaction = await captureInAct(() =>
      view.result.current.toggleReaction(reactionRow.id, '👍'),
    );
    expect(blockedSend).toMatchObject({ kind: 'blocked' });
    expect(blockedReaction).toMatchObject({ kind: 'rejected' });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(2);
    expect(mockAddChatReaction).toHaveBeenCalledTimes(1);

    await view.rerender({});
    expect(
      mockSendRealtime.mock.calls.filter(
        ([command]) => command.type === 'chat.unsubscribe',
      ),
    ).toHaveLength(1);

    await act(async () => {
      pendingGap.resolve({ results: [], has_more: false });
      pendingOlder.resolve({ results: [], next_cursor: 'older-page' });
      pendingSend.resolve({
        disposition: 'created',
        message: message({
          id: '99999999-9999-4999-8999-999999999999',
          content: 'Retry me after recovery',
          client_message_id: clientMessageId,
        }),
      });
      pendingReaction.resolve({
        reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
        change_sequence: 2,
        updated_at: '2026-08-09T10:01:00.000Z',
      });
      pendingDelete.resolve({
        mode: 'for_everyone',
        message: {
          ...deleteRow,
          content: '',
          change_sequence: 2,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: '2026-08-09T10:01:00.000Z',
          deleted_for_everyone_by_id: USER_ID,
          reactions: [],
          action_drafts: [],
        },
      });
      pendingHide.resolve({ hidden_message_ids: [hideRow.id] });
      await Promise.all([
        sendOutcome,
        reactionOutcome,
        deleteOutcome,
        hideOutcome,
      ]);
    });

    mockListChatHistory.mockResolvedValueOnce({
      results: [],
      next_cursor: null,
    });
    tripState = readyTripDetail();
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('granted'));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(5));
    expect(view.result.current.messages.map((item) => item.content)).toEqual(
      expect.arrayContaining([
        reactionRow.content,
        deleteRow.content,
        hideRow.content,
        'Already failed before suspension',
        'Retry me after recovery',
      ]),
    );
    expect(view.result.current.failedByClientId.get(priorFailedClientId)).toEqual(
      networkFailure,
    );
    expect(view.result.current.failedByClientId.get(clientMessageId)).toMatchObject({
      errorCode: 'CHAT_ACCESS_UNCERTAIN',
    });
    await act(async () => {
      await view.result.current.loadOlder();
    });
    expect(mockListChatHistory).toHaveBeenCalledTimes(3);
    expect(view.result.current.hasMoreOlder).toBe(false);
  });

  it('fences stale async completions after a retained-detail refresh error', async () => {
    const confirmed = message();
    const transientState = retainedTripDetailFailure(
      'Trip authority is temporarily unknown.',
    );
    let tripState: ReturnType<typeof readyTripDetail> | typeof transientState =
      readyTripDetail();
    const oldSend = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    const freshSend = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    const oldReaction = deferred<
      Awaited<ReturnType<typeof addChatReaction>>
    >();
    const freshReaction = deferred<
      Awaited<ReturnType<typeof addChatReaction>>
    >();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({
      results: [confirmed],
      next_cursor: null,
    });
    mockSendChatMessage
      .mockReturnValueOnce(oldSend.promise)
      .mockReturnValueOnce(freshSend.promise);
    mockAddChatReaction
      .mockReturnValueOnce(oldReaction.promise)
      .mockReturnValueOnce(freshReaction.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    let oldSendOutcome!: Promise<ChatSendOutcome>;
    let oldReactionOutcome!: Promise<ChatMutationOutcome>;
    await act(async () => {
      oldSendOutcome = view.result.current.sendMessage('Retry same CID');
      oldReactionOutcome = view.result.current.toggleReaction(confirmed.id, '👍');
      await Promise.resolve();
    });
    const clientMessageId = mockSendChatMessage.mock.calls[0]?.[1]
      .clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error('Expected an active send client id.');
    }

    tripState = transientState;
    await view.rerender({});
    await waitFor(() =>
      expect(view.result.current.failedByClientId.get(clientMessageId)).toMatchObject({
        errorCode: 'CHAT_ACCESS_UNCERTAIN',
      }),
    );
    tripState = readyTripDetail();
    await view.rerender({});
    await waitFor(() => expect(view.result.current.accessStatus).toBe('granted'));

    let freshSendOutcome!: Promise<ChatSendOutcome>;
    let freshReactionOutcome!: Promise<ChatMutationOutcome>;
    await act(async () => {
      freshSendOutcome = view.result.current.retryPending(clientMessageId);
      freshReactionOutcome = view.result.current.toggleReaction(confirmed.id, '👍');
      await Promise.resolve();
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(2);
    expect(mockSendChatMessage.mock.calls[1]?.[1].clientMessageId).toBe(
      clientMessageId,
    );
    expect(mockAddChatReaction).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldSend.resolve({
        disposition: 'created',
        message: message({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          content: 'Retry same CID',
          client_message_id: clientMessageId,
        }),
      });
      oldReaction.resolve({
        reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
        change_sequence: 2,
        updated_at: '2026-08-09T10:01:00.000Z',
      });
      await Promise.all([oldSendOutcome, oldReactionOutcome]);
    });

    const duplicateSend = await captureInAct(() =>
      view.result.current.retryPending(clientMessageId),
    );
    const duplicateReaction = await captureInAct(() =>
      view.result.current.toggleReaction(confirmed.id, '👍'),
    );
    expect(duplicateSend).toMatchObject({
      kind: 'failed',
      error: { errorCode: 'SEND_IN_PROGRESS' },
    });
    expect(duplicateReaction).toMatchObject({
      kind: 'rejected',
      error: { errorCode: 'REACTION_IN_PROGRESS' },
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(2);
    expect(mockAddChatReaction).toHaveBeenCalledTimes(2);

    await act(async () => {
      freshSend.resolve({
        disposition: 'replayed',
        message: message({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          content: 'Retry same CID',
          client_message_id: clientMessageId,
        }),
      });
      freshReaction.resolve({
        reactions: [{ emoji: '👍', count: 1, reacted_by_ids: [USER_ID] }],
        change_sequence: 2,
        updated_at: '2026-08-09T10:02:00.000Z',
      });
      await expect(freshSendOutcome).resolves.toMatchObject({
        kind: 'replayed',
        clientMessageId,
      });
      await expect(freshReactionOutcome).resolves.toEqual({ kind: 'applied' });
    });
    expect(view.result.current.failedClientIds.has(clientMessageId)).toBe(false);
    expect(view.result.current.pendingClientIds.has(clientMessageId)).toBe(false);
  });

  it.each(['TRIP_NOT_FOUND', 'FORBIDDEN'] as const)(
    'keeps exact trip-detail access loss %s authoritative and kicked',
    async (errorCode) => {
      const activeTripState = readyTripDetail();
      mockUseTripDetail.mockReturnValue({
        ...activeTripState,
        detail:
          errorCode === 'TRIP_NOT_FOUND' ? null : activeTripState.detail,
        status: errorCode === 'TRIP_NOT_FOUND' ? 'error' : 'ready',
        error: {
          kind: 'message',
          message: 'Access is gone.',
          status: errorCode === 'FORBIDDEN' ? 403 : 404,
          errorCode,
        },
      });

      const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
      await waitFor(() => expect(view.result.current.accessStatus).toBe('denied'));
      expect(view.result.current.roomStatus).toBe('kicked');
      expect(view.result.current.messages).toEqual([]);
      expect(mockListChatHistory).not.toHaveBeenCalled();
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.unsubscribe',
        ),
      ).toHaveLength(0);
    },
  );

  it.each(['TRIP_NOT_FOUND', 'FORBIDDEN'] as const)(
    'does not revive an exact %s kick after a stale ACTIVE trip snapshot',
    async (errorCode) => {
      const deniedTripState = {
        ...readyTripDetail(),
        detail: null,
        status: 'error' as const,
        error: {
          kind: 'message' as const,
          message: `Exact ${errorCode} detail.`,
          status: errorCode === 'FORBIDDEN' ? 403 : 404,
          errorCode,
        },
      };
      let tripState:
        | ReturnType<typeof readyTripDetail>
        | typeof deniedTripState = readyTripDetail();
      mockUseTripDetail.mockImplementation(() => tripState);

      const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
      await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
      const blur = await enterFocus();
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);

      tripState = deniedTripState;
      await view.rerender({});
      await waitFor(() => expect(view.result.current.roomStatus).toBe('kicked'));
      expect(view.result.current.roomError).toEqual({
        errorCode,
        detail: `Exact ${errorCode} detail.`,
      });
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.unsubscribe',
        ),
      ).toHaveLength(1);

      tripState = readyTripDetail();
      mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
      await view.rerender({});
      await act(async () => Promise.resolve());

      expect(view.result.current.roomStatus).toBe('kicked');
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(1);
      expect(mockListChatHistory).toHaveBeenCalledTimes(1);
      await act(async () => blur());
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.unsubscribe',
        ),
      ).toHaveLength(1);
    },
  );

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
      error_code: 'SUBSCRIPTION_LIMIT_REACHED',
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

  it('reconciles from the history snapshot when a high-sequence live row arrives before initial history', async () => {
    const history = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const anchor = message();
    const live = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'Live after the history snapshot',
      created_at: '2026-08-09T10:02:00.000Z',
      updated_at: '2026-08-09T10:02:00.000Z',
      change_sequence: 100,
    });
    const missed = message({
      id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc',
      content: 'Created between history and subscribe',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 75,
    });
    const updatedAnchor = message({
      content: 'Updated after the history snapshot',
      updated_at: '2026-08-09T10:00:30.000Z',
      change_sequence: 50,
    });
    mockListChatHistory.mockReturnValueOnce(history.promise);
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [missed, live],
      has_more: false,
    });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [updatedAnchor, missed, live],
      has_more: false,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await emitRealtime({
      type: 'chat.message',
      trip_id: TRIP_ID,
      message: live,
    });

    await act(async () => {
      history.resolve({ results: [anchor], next_cursor: null });
      await history.promise;
    });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { since: anchor.id, limit: 100 },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          changedSince: anchor.change_sequence,
          changedSinceId: anchor.id,
          limit: 100,
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        view.result.current.messages.find(
          (candidate) => candidate.id === anchor.id,
        )?.content,
      ).toBe(updatedAnchor.content),
    );
    expect(view.result.current.messages.map((candidate) => candidate.id)).toEqual([
      anchor.id,
      missed.id,
      live.id,
    ]);
  });

  it('retries a transient catch-up failure in place exactly when requested', async () => {
    const anchor = message();
    const missed = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'Recovered missed message',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
    });
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockRejectedValueOnce(new Error('temporary gap failure'))
      .mockResolvedValueOnce({ results: [missed], has_more: false });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(view.result.current.roomError).toEqual({
        errorCode: 'CHAT_SYNC_FAILED',
        detail: networkFailure.message,
      }),
    );
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1);
    expect(view.result.current.isGapFilling).toBe(false);

    await view.rerender({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1);

    await act(async () => view.result.current.retryCatchUp());
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.result.current.messages.map((item) => item.id)).toEqual([
        anchor.id,
        missed.id,
      ]),
    );
    expect(view.result.current.roomError).toBeNull();
    expect(
      view.result.current.messages.filter((item) => item.id === missed.id),
    ).toHaveLength(1);

    await act(async () => view.result.current.retryCatchUp());
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2);
  });

  it('retries from the original change cursor after a partial high-sequence gap page', async () => {
    const anchor = message();
    const highSequenceGapMessage = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'New message with a later shared sequence',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 100,
    });
    const updatedAnchor = message({
      content: 'Recovered lower-sequence update',
      updated_at: '2026-08-09T10:00:30.000Z',
      change_sequence: 50,
    });
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockResolvedValueOnce({
        results: [highSequenceGapMessage],
        has_more: true,
      })
      .mockRejectedValueOnce(new Error('second gap page failed'))
      .mockResolvedValueOnce({ results: [], has_more: false });
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [updatedAnchor],
      has_more: false,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(view.result.current.roomError?.errorCode).toBe('CHAT_SYNC_FAILED'),
    );
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2);
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === highSequenceGapMessage.id,
      ),
    ).toBe(true);

    await act(async () => view.result.current.retryCatchUp());

    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          changedSince: anchor.change_sequence,
          changedSinceId: anchor.id,
          limit: 100,
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        view.result.current.messages.find(
          (candidate) => candidate.id === anchor.id,
        )?.content,
      ).toBe(updatedAnchor.content),
    );
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(3);
  });

  it('keeps the last reconciled floor across disconnect and a higher-sequence HTTP send', async () => {
    const anchor = message();
    const sent = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'Sent while realtime was disconnected',
      client_message_id: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc',
      created_at: '2026-08-09T10:02:00.000Z',
      updated_at: '2026-08-09T10:02:00.000Z',
      change_sequence: 100,
    });
    const updatedAnchor = message({
      content: 'Recovered older unseen update',
      updated_at: '2026-08-09T10:00:30.000Z',
      change_sequence: 50,
    });
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockResolvedValueOnce({ results: [], has_more: false })
      .mockResolvedValueOnce({ results: [sent], has_more: false });
    mockSyncChangedChatMessages
      .mockResolvedValueOnce({ results: [], has_more: false })
      .mockResolvedValueOnce({
        results: [updatedAnchor, sent],
        has_more: false,
      });
    mockSendChatMessage.mockImplementationOnce(
      async (_tripId, input) => ({
        disposition: 'created',
        message: {
          ...sent,
          client_message_id: input.clientMessageId,
        },
      }),
    );

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(1));

    mockRealtimeSnapshot = { status: 'reconnecting', connectionEpoch: 1 };
    await view.rerender({});
    await captureInAct(() =>
      view.result.current.sendMessage('Sent while realtime was disconnected'),
    );
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === sent.id,
      ),
    ).toBe(true);

    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenLastCalledWith(
        TRIP_ID,
        {
          changedSince: anchor.change_sequence,
          changedSinceId: anchor.id,
          limit: 100,
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        view.result.current.messages.find(
          (candidate) => candidate.id === anchor.id,
        )?.content,
      ).toBe(updatedAnchor.content),
    );
  });

  it('resumes a capped gap reconcile from its last verified page', async () => {
    const anchor = message();
    const pageMessages = Array.from({ length: 51 }, (_, index) =>
      message({
        id: `00000000-0000-4000-8000-${(index + 1)
          .toString(16)
          .padStart(12, '0')}`,
        content: `Gap page ${index + 1}`,
        created_at: `2026-08-09T10:01:${String(index).padStart(2, '0')}.000Z`,
        updated_at: `2026-08-09T10:01:${String(index).padStart(2, '0')}.000Z`,
        change_sequence: index + 2,
      }),
    );
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    for (const candidate of pageMessages.slice(0, 50)) {
      mockGapFillChatMessages.mockResolvedValueOnce({
        results: [candidate],
        has_more: true,
      });
    }
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [pageMessages[50]!],
      has_more: false,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(view.result.current.roomError?.errorCode).toBe('GAP_FILL_INCOMPLETE'),
    );
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(50);

    await act(async () => view.result.current.retryCatchUp());

    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(51));
    expect(mockGapFillChatMessages.mock.calls[50]?.[1]).toMatchObject({
      since: pageMessages[49]!.id,
    });
    await waitFor(() => expect(view.result.current.roomError).toBeNull());
  });

  it('resumes a capped change reconcile from its last verified cursor', async () => {
    const anchor = message();
    const updates = Array.from({ length: 51 }, (_, index) =>
      message({
        content: `Update ${index + 1}`,
        updated_at: `2026-08-09T10:01:${String(index).padStart(2, '0')}.000Z`,
        change_sequence: index + 2,
      }),
    );
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages
      .mockResolvedValueOnce({ results: [], has_more: false })
      .mockResolvedValueOnce({ results: [], has_more: false });
    for (const candidate of updates.slice(0, 50)) {
      mockSyncChangedChatMessages.mockResolvedValueOnce({
        results: [candidate],
        has_more: true,
      });
    }
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [updates[50]!],
      has_more: false,
    });

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(view.result.current.roomError?.errorCode).toBe(
        'CHANGE_SYNC_INCOMPLETE',
      ),
    );
    expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(50);

    await act(async () => view.result.current.retryCatchUp());

    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(51),
    );
    expect(mockSyncChangedChatMessages.mock.calls[50]?.[1]).toMatchObject({
      changedSince: updates[49]!.change_sequence,
      changedSinceId: updates[49]!.id,
    });
    await waitFor(() => expect(view.result.current.roomError).toBeNull());
  });

  it('locks mutations authoritatively when catch-up reports a terminal trip', async () => {
    const anchor = message();
    const pendingGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    const pendingSend = deferred<{
      disposition: 'created';
      message: ChatMessage;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages.mockReturnValueOnce(pendingGap.promise);
    mockSendChatMessage.mockReturnValueOnce(pendingSend.promise);

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));

    let pendingSendOutcome!: Promise<ChatSendOutcome>;
    await act(async () => {
      pendingSendOutcome = view.result.current.sendMessage(
        'Must be cancelled by the terminal lock',
      );
      await Promise.resolve();
    });
    const pendingClientMessageId = mockSendChatMessage.mock.calls[0]?.[1]
      .clientMessageId;
    if (pendingClientMessageId === undefined) {
      throw new Error('Expected the pending send to own a client id.');
    }
    const pendingSendSignal = mockSendChatMessage.mock.calls[0]?.[2];
    expect(pendingSendSignal?.aborted).toBe(false);
    expect(
      view.result.current.pendingClientIds.has(pendingClientMessageId),
    ).toBe(true);

    mockNormalizeChatApiError.mockReturnValueOnce(terminalFailure);
    await act(async () => {
      pendingGap.reject(new Error('trip ended during catch-up'));
      await pendingGap.promise.catch(() => undefined);
    });
    await waitFor(() => expect(view.result.current.isReadOnly).toBe(true));
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: terminalFailure.message,
    });
    expect(pendingSendSignal?.aborted).toBe(true);
    expect(view.result.current.pendingClientIds.size).toBe(0);

    const blocked = await captureInAct(() =>
      view.result.current.sendMessage('Must not reach the API'),
    );
    expect(blocked).toMatchObject({
      kind: 'blocked',
      error: { errorCode: 'TRIP_TERMINAL' },
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSend.resolve({
        disposition: 'created',
        message: message({
          id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
          content: 'Must stay cancelled',
          client_message_id: pendingClientMessageId,
        }),
      });
    });
    await expect(pendingSendOutcome).resolves.toMatchObject({
      kind: 'failed',
      error: { errorCode: 'SEND_CANCELLED' },
    });
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      ),
    ).toBe(false);
  });

  it('does not spin when terminal authority is returned by read catch-up', async () => {
    const anchor = message();
    mockListChatHistory.mockResolvedValue({ results: [anchor], next_cursor: null });
    mockGapFillChatMessages
      .mockRejectedValueOnce(new Error('terminal read response one'))
      .mockRejectedValueOnce(new Error('terminal read response two'));
    mockNormalizeChatApiError.mockReturnValue(terminalFailure);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(view.result.current.readSyncError).toEqual({
        errorCode: 'CHAT_SYNC_FAILED',
        detail: terminalFailure.message,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1);
    expect(view.result.current.isReadOnly).toBe(true);

    await act(async () => view.result.current.retryCatchUp());
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2);
    expect(view.result.current.readSyncError?.errorCode).toBe('CHAT_SYNC_FAILED');
  });

  it('preserves a websocket terminal lock when a pending catch-up fails later', async () => {
    const anchor = message();
    const pendingGap = deferred<{
      results: readonly ChatMessage[];
      has_more: boolean;
    }>();
    mockListChatHistory.mockResolvedValue({
      results: [anchor],
      next_cursor: null,
    });
    mockGapFillChatMessages.mockReturnValueOnce(pendingGap.promise);

    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip ended while catch-up was pending.',
    });
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while catch-up was pending.',
    });

    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    await act(async () => {
      pendingGap.reject(new Error('late transient catch-up failure'));
      await pendingGap.promise.catch(() => undefined);
    });
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while catch-up was pending.',
    });

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'SERVER_ERROR',
      detail: 'A later nonterminal websocket error.',
    });
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while catch-up was pending.',
    });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2),
    );
    expect(view.result.current.readSyncError).toBeNull();
    expect(view.result.current.isReadOnly).toBe(true);
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
      ).toHaveLength(3),
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

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    try {
      await emitRealtime({
        type: 'chat.ai_typing_started',
        trip_id: TRIP_ID,
        interaction_id: 'terminal-websocket-typing',
        requested_by_user_id: USER_ID,
      });
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        'terminal-websocket-typing',
      );
      const typingTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        ([, delayMs]) => delayMs === 120_000,
      );
      expect(typingTimerIndex).toBeGreaterThanOrEqual(0);
      const typingTimerHandle = setTimeoutSpy.mock.results[typingTimerIndex]?.value;

      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'TRIP_TERMINAL',
        detail: 'This trip is complete.',
      });
      expect(view.result.current.isReadOnly).toBe(true);
      expect(view.result.current.messages).toHaveLength(1);
      expect(view.result.current.mutationError).toBeNull();
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        'terminal-websocket-typing',
      );
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(typingTimerHandle);

      await emitRealtime({
        type: 'chat.error',
        trip_id: TRIP_ID,
        error_code: 'TRIP_TERMINAL',
        detail: 'This repeated terminal event must stay idempotent.',
      });
      expect(view.result.current.mutationError).toBeNull();
      await emitRealtime({
        type: 'chat.ai_typing_stopped',
        trip_id: TRIP_ID,
        interaction_id: 'terminal-websocket-typing',
      });
      expect(view.result.current.aiTypingState.active).toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('preserves AI typing when trip detail becomes terminal', async () => {
    let tripState = readyTripDetail();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({
      results: [message()],
      next_cursor: null,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    try {
      await emitRealtime({
        type: 'chat.ai_typing_started',
        trip_id: TRIP_ID,
        interaction_id: 'terminal-trip-detail-typing',
        requested_by_user_id: USER_ID,
      });
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        'terminal-trip-detail-typing',
      );
      const typingTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        ([, delayMs]) => delayMs === 120_000,
      );
      expect(typingTimerIndex).toBeGreaterThanOrEqual(0);
      const typingTimerHandle = setTimeoutSpy.mock.results[typingTimerIndex]?.value;

      tripState = readyTripDetail(TRIP_ID, 'COMPLETED');
      await view.rerender({});
      expect(view.result.current.isReadOnly).toBe(true);
      expect(view.result.current.aiTypingState.active?.interactionId).toBe(
        'terminal-trip-detail-typing',
      );
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(typingTimerHandle);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('preserves a websocket terminal notice when pending initial history later succeeds', async () => {
    const initialPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: null;
    }>();
    mockListChatHistory.mockReturnValueOnce(initialPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });

    await act(async () => {
      initialPage.resolve({ results: [message()], next_cursor: null });
      await initialPage.promise;
    });
    await waitFor(() => expect(view.result.current.roomStatus).toBe('ready'));
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });
    expect(view.result.current.isReadOnly).toBe(true);
    expect(view.result.current.messages).toHaveLength(1);
  });

  it('waits for pending initial history before terminal read catch-up', async () => {
    const initialPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const anchor = message();
    mockUseTripDetail.mockReturnValue(readyTripDetail(TRIP_ID, 'COMPLETED'));
    mockListChatHistory.mockReturnValueOnce(initialPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));

    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockListChatHistory).toHaveBeenCalledTimes(1);
    expect(mockGapFillChatMessages).not.toHaveBeenCalled();

    await act(async () => {
      initialPage.resolve({ results: [anchor], next_cursor: 'older-page' });
      await initialPage.promise;
    });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { since: anchor.id, limit: 100 },
        expect.any(AbortSignal),
      ),
    );
    expect(mockListChatHistory).toHaveBeenCalledTimes(1);
    expect(view.result.current.hasMoreOlder).toBe(true);
    expect(view.result.current.isReadOnly).toBe(true);
  });

  it('recovers a committed ambiguous send on terminal transition without another POST', async () => {
    const anchor = message();
    let tripState = readyTripDetail();
    const pendingSend = deferred<{
      disposition: 'created';
      message: ChatMessage;
    }>();
    mockUseTripDetail.mockImplementation(() => tripState);
    mockListChatHistory.mockResolvedValue({ results: [anchor], next_cursor: null });
    mockSendChatMessage.mockReturnValueOnce(pendingSend.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));
    await waitFor(() => expect(view.result.current.isUpdating).toBe(false));

    let sendOutcome!: Promise<ChatSendOutcome>;
    await act(async () => {
      sendOutcome = view.result.current.sendMessage('Committed before terminal');
      await Promise.resolve();
    });
    const clientMessageId = mockSendChatMessage.mock.calls[0]?.[1]
      .clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error('Expected the pending send to own a client id.');
    }
    const committed = message({
      id: 'dededede-dede-4ede-8ede-dededededede',
      content: 'Committed before terminal',
      client_message_id: clientMessageId,
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
    });
    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [committed],
      has_more: false,
    });

    tripState = readyTripDetail(TRIP_ID, 'COMPLETED');
    await view.rerender({});
    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(
        view.result.current.messages.filter(
          (candidate) => candidate.client_message_id === clientMessageId,
        ),
      ).toEqual([committed]),
    );
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    expect(view.result.current.isReadOnly).toBe(true);

    await act(async () => {
      pendingSend.resolve({ disposition: 'created', message: committed });
      await pendingSend.promise;
    });
    await expect(sendOutcome).resolves.toMatchObject({
      kind: 'failed',
      error: { errorCode: 'SEND_CANCELLED' },
    });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('catches up terminal read updates after reconnect without a mutation POST', async () => {
    const anchor = message();
    const committed = message({
      id: 'efefefef-efef-4fef-8fef-efefefefefef',
      content: 'Recovered after terminal reconnect',
      client_message_id: '99999999-9999-4999-8999-999999999999',
      created_at: '2026-08-09T10:01:00.000Z',
      updated_at: '2026-08-09T10:01:00.000Z',
      change_sequence: 2,
    });
    mockUseTripDetail.mockReturnValue(readyTripDetail(TRIP_ID, 'COMPLETED'));
    mockListChatHistory.mockResolvedValue({ results: [anchor], next_cursor: null });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.isGapFilling).toBe(false));

    mockGapFillChatMessages.mockResolvedValueOnce({
      results: [committed],
      has_more: false,
    });
    mockRealtimeSnapshot = { status: 'reconnecting', connectionEpoch: 1 };
    await view.rerender({});
    mockRealtimeSnapshot = { status: 'connected', connectionEpoch: 2 };
    await view.rerender({});
    await waitFor(() =>
      expect(
        mockSendRealtime.mock.calls.filter(
          ([command]) => command.type === 'chat.subscribe',
        ),
      ).toHaveLength(2),
    );
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(mockGapFillChatMessages).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(view.result.current.messages).toEqual([anchor, committed]),
    );
    expect(view.result.current.isReadOnly).toBe(true);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it('exposes and retries terminal read synchronization failures', async () => {
    const anchor = message();
    mockUseTripDetail.mockReturnValue(readyTripDetail(TRIP_ID, 'COMPLETED'));
    mockListChatHistory.mockResolvedValue({ results: [anchor], next_cursor: null });
    mockGapFillChatMessages
      .mockRejectedValueOnce(new Error('terminal read sync failed'))
      .mockRejectedValueOnce(new Error('terminal resubscribe sync failed'))
      .mockResolvedValueOnce({ results: [], has_more: false });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.messages).toEqual([anchor]));
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });

    await waitFor(() =>
      expect(view.result.current.readSyncError).toEqual({
        errorCode: 'CHAT_SYNC_FAILED',
        detail: networkFailure.message,
      }),
    );
    expect(view.result.current.tripStatus).toBe('COMPLETED');
    expect(view.result.current.isReadOnly).toBe(true);

    await act(async () => view.result.current.retrySubscription());
    expect(view.result.current.readSyncError).toBeNull();
    expect(view.result.current.subscriptionStatus).toBe('subscribing');
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(view.result.current.readSyncError?.errorCode).toBe(
        'CHAT_SYNC_FAILED',
      ),
    );

    await act(async () => view.result.current.retryCatchUp());
    await waitFor(() => expect(mockGapFillChatMessages).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(view.result.current.readSyncError).toBeNull());
    expect(view.result.current.isReadOnly).toBe(true);
  });

  it('keeps terminal history pagination live after a pending first page resolves', async () => {
    const initialPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    const newest = message();
    const older = message({
      id: 'abababab-abab-4bab-8bab-abababababab',
      content: 'Older terminal history',
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    mockListChatHistory
      .mockReturnValueOnce(initialPage.promise)
      .mockReturnValueOnce(olderPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });
    await act(async () => {
      initialPage.resolve({ results: [newest], next_cursor: 'older-page' });
      await initialPage.promise;
    });
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    let firstOlderLoad!: Promise<void>;
    await act(async () => {
      firstOlderLoad = view.result.current.loadOlder();
      await Promise.resolve();
    });
    expect(view.result.current.isLoadingOlder).toBe(true);

    await act(async () => view.result.current.loadOlder());
    expect(mockListChatHistory).toHaveBeenCalledTimes(2);

    expect(mockListChatHistory).toHaveBeenLastCalledWith(
      TRIP_ID,
      { cursor: 'older-page', limit: 30 },
      expect.any(AbortSignal),
    );
    await act(async () => {
      olderPage.resolve({ results: [older], next_cursor: null });
      await firstOlderLoad;
    });
    expect(view.result.current.isLoadingOlder).toBe(false);
    expect(view.result.current.messages.map((candidate) => candidate.id)).toEqual([
      older.id,
      newest.id,
    ]);
    expect(view.result.current.hasMoreOlder).toBe(false);
    expect(view.result.current.isReadOnly).toBe(true);
  });

  it('preserves terminal authority when pending initial history rejects later', async () => {
    const initialPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: null;
    }>();
    mockListChatHistory.mockReturnValueOnce(initialPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(mockListChatHistory).toHaveBeenCalledTimes(1));

    await emitRealtime({
      type: 'chat.error',
      trip_id: TRIP_ID,
      error_code: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });
    mockNormalizeChatApiError.mockReturnValueOnce(networkFailure);
    await act(async () => {
      initialPage.reject(new Error('late initial history failure'));
      await initialPage.promise.catch(() => undefined);
    });

    expect(view.result.current.roomStatus).toBe('ready');
    expect(view.result.current.roomError).toEqual({
      errorCode: 'TRIP_TERMINAL',
      detail: 'This trip ended while history was loading.',
    });
    expect(view.result.current.initialLoadError).toEqual(networkFailure);
    expect(view.result.current.isReadOnly).toBe(true);
    const retryPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: null;
    }>();
    mockListChatHistory.mockReturnValueOnce(retryPage.promise);
    let retry!: Promise<void>;
    await act(async () => {
      retry = view.result.current.retryInitialLoad();
      await Promise.resolve();
    });
    expect(mockListChatHistory).toHaveBeenCalledTimes(2);
    expect(view.result.current.isLoadingInitial).toBe(true);
    expect(view.result.current.roomStatus).toBe('ready');
    expect(view.result.current.isReadOnly).toBe(true);

    await act(async () => view.result.current.retryInitialLoad());
    expect(mockListChatHistory).toHaveBeenCalledTimes(2);

    await act(async () => {
      retryPage.resolve({ results: [message()], next_cursor: null });
      await retry;
    });
    expect(view.result.current.isLoadingInitial).toBe(false);
    expect(view.result.current.initialLoadError).toBeNull();
    expect(view.result.current.isReadOnly).toBe(true);
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

  it('applies catch-up authority that arrives before a stale older page', async () => {
    const anchor = message({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: 'Newest loaded anchor',
    });
    const staleOlder = message({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      content: 'Stale older snapshot',
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const tombstone = message({
      ...staleOlder,
      content: '',
      updated_at: '2026-08-09T10:10:00.000Z',
      change_sequence: 10,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:10:00.000Z',
      deleted_for_everyone_by_id: USER_ID,
      delete_for_everyone_until: null,
      can_delete_for_everyone: false,
      reactions: [],
    });
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockReturnValueOnce(olderPage.promise);
    mockSyncChangedChatMessages.mockResolvedValueOnce({
      results: [tombstone],
      has_more: false,
    });
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    let olderLoad!: Promise<void>;
    await act(async () => {
      olderLoad = view.result.current.loadOlder();
      await Promise.resolve();
    });
    await enterFocus();
    await emitRealtime({ type: 'chat.subscribed', trip_id: TRIP_ID });
    await waitFor(() =>
      expect(mockSyncChangedChatMessages).toHaveBeenCalledTimes(1),
    );
    expect(
      view.result.current.messages.some(
        (candidate) => candidate.id === staleOlder.id,
      ),
    ).toBe(false);

    await act(async () => {
      olderPage.resolve({ results: [staleOlder], next_cursor: null });
      await olderLoad;
    });

    expect(
      view.result.current.messages.find(
        (candidate) => candidate.id === staleOlder.id,
      ),
    ).toEqual(tombstone);
  });

  it('applies an unknown live reaction when its stale older row materializes', async () => {
    const anchor = message({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: 'Newest loaded anchor',
    });
    const staleOlder = message({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      content: 'Older row',
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const latestReactions = [
      { emoji: '😂' as const, count: 1, reacted_by_ids: [USER_ID] },
    ];
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockReturnValueOnce(olderPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    let olderLoad!: Promise<void>;
    await act(async () => {
      olderLoad = view.result.current.loadOlder();
      await Promise.resolve();
    });
    await emitRealtime({
      type: 'chat.reaction_update',
      trip_id: TRIP_ID,
      message_id: staleOlder.id,
      reactions: latestReactions,
      change_sequence: 11,
      updated_at: '2026-08-09T10:11:00.000Z',
    });
    await act(async () => {
      olderPage.resolve({ results: [staleOlder], next_cursor: null });
      await olderLoad;
    });

    expect(
      view.result.current.messages.find(
        (candidate) => candidate.id === staleOlder.id,
      ),
    ).toMatchObject({
      reactions: latestReactions,
      change_sequence: 11,
      updated_at: '2026-08-09T10:11:00.000Z',
    });
  });

  it('applies an unknown live tombstone when its stale older row materializes', async () => {
    const anchor = message({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: 'Newest loaded anchor',
    });
    const staleOlder = message({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      content: 'Older row',
      created_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:00:00.000Z',
    });
    const tombstone = message({
      ...staleOlder,
      content: '',
      change_sequence: 12,
      updated_at: '2026-08-09T10:12:00.000Z',
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: '2026-08-09T10:12:00.000Z',
      deleted_for_everyone_by_id: USER_ID,
      delete_for_everyone_until: null,
      can_delete_for_everyone: false,
      reactions: [],
    });
    const olderPage = deferred<{
      results: readonly ChatMessage[];
      next_cursor: string | null;
    }>();
    mockListChatHistory
      .mockResolvedValueOnce({ results: [anchor], next_cursor: 'older-page' })
      .mockReturnValueOnce(olderPage.promise);
    const view = await renderHook(() => useTripChat({ tripId: TRIP_ID }));
    await waitFor(() => expect(view.result.current.hasMoreOlder).toBe(true));

    let olderLoad!: Promise<void>;
    await act(async () => {
      olderLoad = view.result.current.loadOlder();
      await Promise.resolve();
    });
    await emitRealtime({
      type: 'chat.message_deleted',
      trip_id: TRIP_ID,
      message: tombstone,
    });
    await act(async () => {
      olderPage.resolve({ results: [staleOlder], next_cursor: null });
      await olderLoad;
    });

    expect(
      view.result.current.messages.find(
        (candidate) => candidate.id === staleOlder.id,
      ),
    ).toEqual(tombstone);
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
