import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/features/chat/domain/types";

const chatApiMock = vi.hoisted(() => ({
  bffListChatHistory: vi.fn(),
  bffGapFillChatMessages: vi.fn(),
  bffSyncChangedChatMessages: vi.fn(),
  bffSendChatMessage: vi.fn(),
  bffAddReaction: vi.fn(),
  bffRemoveReaction: vi.fn(),
  bffDeleteChatMessage: vi.fn(),
  bffHideChatMessagesForMe: vi.fn(),
}));

const wsBridgeMock = vi.hoisted(() => {
  const handle = { leave: vi.fn() };
  const listenersRef: { current: Parameters<typeof handle.leave> | null } = {
    current: null,
  };
  return {
    handle,
    listenersRef,
    joinChatRoom: vi.fn(
      (
        _tripId: string,
        listeners: {
          onMessage?: (e: unknown) => void;
          onSubscribeAttempt?: () => void;
          onKicked?: (e: unknown) => void;
          onError?: (e: unknown) => void;
          onSubscribed?: (e: unknown) => void;
          onUnsubscribed?: (e: unknown) => void;
          onMessageDeleted?: (e: unknown) => void;
          onReactionUpdate?: (e: unknown) => void;
          onAITypingStarted?: (e: unknown) => void;
          onAITypingStopped?: (e: unknown) => void;
        },
      ) => {
        listenersRef.current = listeners as never;
        listeners.onSubscribeAttempt?.();
        return handle;
      },
    ),
  };
});

vi.mock("@/features/chat/infrastructure/chat-api", () => chatApiMock);
vi.mock("@/features/chat/infrastructure/chat-ws-bridge", () => ({
  joinChatRoom: wsBridgeMock.joinChatRoom,
}));

import { useTripChat } from "@/features/chat/application/use-trip-chat";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_TRIP_ID = "22222222-2222-4222-8222-222222222222";
const ME = {
  id: "user-self",
  display_name: "Me",
  identify_tag: null,
  avatar_url: null,
};

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m-1",
    trip_id: TRIP_ID,
    sender: {
      id: "user-other",
      display_name: "Other",
      identify_tag: null,
      avatar_url: null,
    },
    sender_kind: "USER",
    ai_status: null,
    content: "hello",
    client_message_id: null,
    created_at: "2026-05-08T10:00:00Z",
    updated_at: "2026-05-08T10:00:00Z",
    change_sequence: 1,
    is_deleted_for_everyone: false,
    deleted_for_everyone_at: null,
    deleted_for_everyone_by_id: null,
    delete_for_everyone_until: "2026-05-08T10:05:00Z",
    can_delete_for_everyone: true,
    reactions: [],
    action_drafts: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestChatListeners = {
  onMessage?: (event: unknown) => void;
  onSubscribeAttempt?: () => void;
  onMessageDeleted?: (event: unknown) => void;
  onKicked?: (event: unknown) => void;
  onError?: (event: unknown) => void;
  onSubscribed?: (event: unknown) => void;
  onUnsubscribed?: (event: unknown) => void;
  onReactionUpdate?: (event: unknown) => void;
  onAITypingStarted?: (event: unknown) => void;
  onAITypingStopped?: (event: unknown) => void;
};

describe("useTripChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatApiMock.bffListChatHistory.mockReset();
    chatApiMock.bffGapFillChatMessages.mockReset();
    chatApiMock.bffSyncChangedChatMessages.mockReset();
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSendChatMessage.mockReset();
    chatApiMock.bffAddReaction.mockReset();
    chatApiMock.bffRemoveReaction.mockReset();
    chatApiMock.bffDeleteChatMessage.mockReset();
    chatApiMock.bffHideChatMessagesForMe.mockReset();
    wsBridgeMock.listenersRef.current = null;
  });

  it("loads initial history and exposes ascending messages", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      // backend returns descending; the hook sorts ascending for the UI
      results: [
        makeMessage({ id: "m-2", created_at: "2026-05-08T10:01:00Z" }),
        makeMessage({ id: "m-1", created_at: "2026-05-08T10:00:00Z" }),
      ],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    expect(result.current.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(result.current.hasMoreOlder).toBe(false);
  });

  it("canonicalizes uppercase trip UUIDs across history and websocket lifecycle", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID.toUpperCase(), ME));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(chatApiMock.bffListChatHistory).toHaveBeenCalledWith(TRIP_ID, {
      limit: 30,
    });
    expect(wsBridgeMock.joinChatRoom).toHaveBeenCalledWith(
      TRIP_ID,
      expect.any(Object),
    );
  });

  it("fails closed for malformed trip IDs without HTTP or websocket work", async () => {
    const { result } = renderHook(() => useTripChat("not-a-uuid", ME));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorCode).toBe("INVALID_TRIP_ID");
    expect(chatApiMock.bffListChatHistory).not.toHaveBeenCalled();
    expect(wsBridgeMock.joinChatRoom).not.toHaveBeenCalled();
  });

  it("drops deferred older-history results after switching resources", async () => {
    let resolveOldTripPage:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockImplementation((tripId, options) => {
      if (tripId === TRIP_ID && options.cursor) {
        return new Promise((resolve) => {
          resolveOldTripPage = resolve;
        });
      }
      if (tripId === SECOND_TRIP_ID) {
        return Promise.resolve({
          results: [
            makeMessage({ id: "trip-b-message", trip_id: SECOND_TRIP_ID }),
          ],
          next_cursor: null,
        });
      }
      return Promise.resolve({
        results: [makeMessage({ id: "trip-a-message" })],
        next_cursor: "trip-a-older",
      });
    });

    const { result, rerender } = renderHook(
      ({ tripId }) => useTripChat(tripId, ME),
      { initialProps: { tripId: TRIP_ID } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let olderPromise: Promise<void> | null = null;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(resolveOldTripPage).not.toBeNull());

    rerender({ tripId: SECOND_TRIP_ID });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "trip-b-message",
      ]),
    );
    await act(async () => {
      resolveOldTripPage?.({
        results: [makeMessage({ id: "late-trip-a-older" })],
        next_cursor: null,
      });
      await olderPromise;
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "trip-b-message",
    ]);
  });

  it("drops deferred mutation results after switching resources", async () => {
    chatApiMock.bffListChatHistory.mockImplementation((tripId) =>
      Promise.resolve({
        results:
          tripId === SECOND_TRIP_ID
            ? [makeMessage({ id: "trip-b-only", trip_id: SECOND_TRIP_ID })]
            : [],
        next_cursor: null,
      }),
    );
    let resolveOldTripSend:
      | ((value: { message: ChatMessage; status: 200 | 201 }) => void)
      | null = null;
    chatApiMock.bffSendChatMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveOldTripSend = resolve;
      }),
    );

    const { result, rerender } = renderHook(
      ({ tripId }) => useTripChat(tripId, ME),
      { initialProps: { tripId: TRIP_ID } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let sendPromise: Promise<unknown> | null = null;
    act(() => {
      sendPromise = result.current.sendMessage("from trip A");
    });
    await waitFor(() => expect(chatApiMock.bffSendChatMessage).toHaveBeenCalled());

    rerender({ tripId: SECOND_TRIP_ID });
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "trip-b-only",
      ]),
    );
    await act(async () => {
      resolveOldTripSend?.({
        message: makeMessage({ id: "late-trip-a-send" }),
        status: 201,
      });
      await sendPromise;
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "trip-b-only",
    ]);
    expect(result.current.pendingClientIds.size).toBe(0);
  });

  it("keeps websocket messages that arrive before initial history resolves", async () => {
    let resolveHistory:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(wsBridgeMock.listenersRef.current).not.toBeNull();
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (e: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "ws-first",
          content: "arrived over ws",
          created_at: "2026-05-08T10:02:00Z",
        }),
      });
    });

    act(() => {
      resolveHistory?.({
        results: [
          makeMessage({
            id: "history-old",
            content: "history",
            created_at: "2026-05-08T10:00:00Z",
          }),
        ],
        next_cursor: null,
      });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "history-old",
      "ws-first",
    ]);
  });

  it("materializes an unknown tombstone over its stale initial-history base", async () => {
    const history = deferred<{
      results: ChatMessage[];
      next_cursor: string | null;
    }>();
    chatApiMock.bffListChatHistory.mockReturnValue(history.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(wsBridgeMock.listenersRef.current).not.toBeNull());

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "initial-tombstone",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
    });
    history.resolve({
      results: [
        makeMessage({
          id: "initial-tombstone",
          content: "stale initial content",
          change_sequence: 1,
        }),
      ],
      next_cursor: null,
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: "initial-tombstone",
      content: "",
      change_sequence: 5,
      is_deleted_for_everyone: true,
    });
  });

  it("does not let initial history overwrite a newer websocket version", async () => {
    let resolveHistory:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(wsBridgeMock.listenersRef.current).not.toBeNull());

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (event: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "same-message",
          content: "new websocket content",
          change_sequence: 3,
        }),
      });
      resolveHistory?.({
        results: [
          makeMessage({
            id: "same-message",
            content: "stale history content",
            change_sequence: 1,
          }),
        ],
        next_cursor: null,
      });
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.messages[0]).toMatchObject({
      id: "same-message",
      content: "new websocket content",
      change_sequence: 3,
    });
  });

  it("does not let older-history pagination overwrite a newer loaded version", async () => {
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "overlap",
            content: "new loaded version",
            change_sequence: 5,
          }),
        ],
        next_cursor: "older-page",
      })
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "overlap",
            content: "stale older page version",
            change_sequence: 2,
          }),
          makeMessage({
            id: "actually-older",
            created_at: "2026-05-08T09:00:00Z",
            change_sequence: 1,
          }),
        ],
        next_cursor: null,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.loadOlder());

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "actually-older",
      "overlap",
    ]);
    expect(result.current.messages[1]).toMatchObject({
      content: "new loaded version",
      change_sequence: 5,
    });
  });

  it("materializes one newer tombstone over its stale deferred history base", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "loaded-window",
          change_sequence: 10,
          created_at: "2026-05-08T10:10:00Z",
        }),
      ],
      next_cursor: "older-page",
    });
    let resolveOlder:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let olderPromise: Promise<void> | null = null;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (event: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "unknown-deleted",
          content: "",
          change_sequence: 5,
          created_at: "2026-05-08T09:00:00Z",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });
    await act(async () => {
      resolveOlder?.({
        results: [
          makeMessage({
            id: "unknown-deleted",
            content: "stale secret",
            change_sequence: 1,
            created_at: "2026-05-08T09:00:00Z",
          }),
        ],
        next_cursor: null,
      });
      await olderPromise;
    });

    const tombstones = result.current.messages.filter(
      (message) => message.id === "unknown-deleted",
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      content: "",
      change_sequence: 5,
      is_deleted_for_everyone: true,
      deleted_for_everyone_at: "2026-05-08T10:05:00Z",
    });
  });

  it("compacts unknown floors when the history request that observed them fails", async () => {
    const older = deferred<{
      results: ChatMessage[];
      next_cursor: string | null;
    }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "failed-floor-window", change_sequence: 10 })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "failed-floor-message",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
    });
    older.reject(new Error("older page unavailable"));
    await act(async () => olderPromise);
    expect(result.current.isLoadingOlder).toBe(false);

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "failed-floor-message",
          content: "authoritative after failed request",
          change_sequence: 1,
        }),
      });
    });

    expect(
      result.current.messages.find(
        (message) => message.id === "failed-floor-message",
      )?.content,
    ).toBe("authoritative after failed request");
  });

  it("lets a future authoritative history request supersede an unknown tombstone", async () => {
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "equal-floor-window", change_sequence: 10 })],
        next_cursor: "older-page",
      })
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "equal-sequence-deleted",
            content: "must stay hidden",
            change_sequence: 5,
            created_at: "2026-05-08T09:00:00Z",
          }),
        ],
        next_cursor: null,
      });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (event: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "equal-sequence-deleted",
          content: "",
          change_sequence: 5,
          created_at: "2026-05-08T09:00:00Z",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });
    await act(async () => result.current.loadOlder());

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "equal-sequence-deleted",
      "equal-floor-window",
    ]);
  });

  it("does not retain unknown floors while older history is idle", async () => {
    const unknownIds = Array.from({ length: 25 }, (_, index) => `idle-floor-${index}`);
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "idle-floor-window", change_sequence: 10 })],
        next_cursor: "older-page",
      })
      .mockResolvedValueOnce({
        results: [makeMessage({ id: unknownIds.at(-1), change_sequence: 1 })],
        next_cursor: null,
      });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      for (const id of unknownIds) {
        listeners.onMessageDeleted?.({
          type: "chat.message_deleted",
          trip_id: TRIP_ID,
          message: makeMessage({
            id,
            content: "",
            change_sequence: 5,
            is_deleted_for_everyone: true,
            deleted_for_everyone_at: "2026-05-08T10:05:00Z",
          }),
        });
      }
      for (const id of unknownIds.slice(0, -1)) {
        listeners.onMessage?.({
          type: "chat.message",
          trip_id: TRIP_ID,
          message: makeMessage({ id, change_sequence: 1 }),
        });
      }
    });

    expect(
      unknownIds.slice(0, -1).every((id) =>
        result.current.messages.some((message) => message.id === id),
      ),
    ).toBe(true);
    await act(async () => result.current.loadOlder());
    expect(
      result.current.messages.some((message) => message.id === unknownIds.at(-1)),
    ).toBe(true);
  });

  it("discards lower-sequence full websocket updates", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "ws-versioned", change_sequence: 1 })],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (event: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "ws-versioned",
          content: "sequence three",
          change_sequence: 3,
        }),
      });
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "ws-versioned",
          content: "sequence two arrived late",
          change_sequence: 2,
        }),
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "sequence three",
      change_sequence: 3,
    });
  });

  it("does not let a rejected lower-sequence UPSERT poison a later reaction", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "upsert-poison", change_sequence: 10 })],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "upsert-poison",
          content: "",
          change_sequence: 9,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:09:00Z",
        }),
      });
    });
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "upsert-poison",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 11,
        updated_at: "2026-05-08T10:11:00Z",
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      change_sequence: 11,
      is_deleted_for_everyone: false,
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
    });
  });

  it("does not let a rejected lower-sequence PATCH poison a later full row", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "patch-poison", change_sequence: 10 })],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "patch-poison",
          content: "",
          change_sequence: 9,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:09:00Z",
        }),
      });
    });
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "patch-poison",
          content: "authoritative sequence eleven",
          change_sequence: 11,
        }),
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "authoritative sequence eleven",
      change_sequence: 11,
      is_deleted_for_everyone: false,
    });
  });

  it("does not let a rejected lower-sequence confirmation poison later updates", async () => {
    const confirmation = deferred<{ message: ChatMessage; status: 200 | 201 }>();
    let capturedClientId: string | null = null;
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "confirmation-poison", change_sequence: 10 })],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage.mockImplementation((_tripId, input) => {
      capturedClientId = input.client_message_id;
      return confirmation.promise;
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let sendPromise!: Promise<string>;
    act(() => {
      sendPromise = result.current.sendMessage("late confirmation");
    });
    await waitFor(() => expect(capturedClientId).not.toBeNull());
    confirmation.resolve({
      message: makeMessage({
        id: "confirmation-poison",
        content: "",
        client_message_id: capturedClientId,
        change_sequence: 9,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: "2026-05-08T10:09:00Z",
      }),
      status: 201,
    });
    await act(async () => sendPromise);
    expect(result.current.pendingClientIds.size).toBe(0);

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "confirmation-poison",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 11,
        updated_at: "2026-05-08T10:11:00Z",
      });
    });
    expect(result.current.messages[0]).toMatchObject({
      change_sequence: 11,
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "confirmation-poison",
          content: "authoritative sequence twelve",
          change_sequence: 12,
        }),
      });
    });
    expect(result.current.messages[0]).toMatchObject({
      content: "authoritative sequence twelve",
      change_sequence: 12,
      is_deleted_for_everyone: false,
    });
  });

  it("keeps an equal-sequence tombstone authoritative and irreversible", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "equal-tombstone", change_sequence: 10 })],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "equal-tombstone",
          content: "",
          change_sequence: 10,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:10:00Z",
        }),
      });
    });
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "equal-tombstone",
          content: "must not resurrect",
          change_sequence: 11,
        }),
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "",
      change_sequence: 10,
      is_deleted_for_everyone: true,
    });
  });

  it("replaces action drafts from websocket message updates", async () => {
    const readyDraft = {
      id: "draft-1",
      action_type: "expense.create",
      status: "READY" as const,
      required_confirmation: "CAPTAIN" as const,
      can_confirm: true,
      can_cancel: true,
      can_edit: false,
      display: {
        kicker: "Expense",
        title: "Dinner",
        icon: "expense" as const,
        tone: "create" as const,
      },
      summary: "Dinner",
      preview: { title: "Dinner" },
      missing_fields: [],
      result: {},
      error_code: "",
      error_detail: "",
      expires_at: "2026-06-01T00:00:00Z",
      created_at: "2026-05-13T00:00:00Z",
      updated_at: "2026-05-13T00:00:00Z",
    };
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "ai-message",
          sender_kind: "AI",
          ai_status: "SUCCESS",
          action_drafts: [readyDraft],
        }),
      ],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (e: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "ai-message",
          sender_kind: "AI",
          ai_status: "SUCCESS",
          action_drafts: [
            {
              ...readyDraft,
              status: "CONFIRMED" as const,
              can_confirm: false,
              can_cancel: false,
              can_edit: false,
            },
          ],
        }),
      });
    });

    expect(result.current.messages[0].action_drafts[0]).toMatchObject({
      id: "draft-1",
      status: "CONFIRMED",
    });
  });

  it("gap-fills after subscribe ack to close the initial history race", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "history-latest",
          created_at: "2026-05-08T10:00:00Z",
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "missed-between-history-and-subscribe",
          content: "missed window",
          created_at: "2026-05-08T10:01:00Z",
        }),
      ],
      has_more: false,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { since: "history-latest", limit: 100 },
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        "history-latest",
        "missed-between-history-and-subscribe",
      ]);
    });
  });

  it("recovers from the exact history snapshot when live data arrives before ACK", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "snapshot-floor",
          content: "snapshot",
          change_sequence: 1,
          created_at: "2026-05-08T10:00:00Z",
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({
      results: [
        makeMessage({
          id: "missed-before-group",
          content: "must be recovered",
          change_sequence: 5,
          created_at: "2026-05-08T10:01:00Z",
        }),
      ],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (event: unknown) => void;
        onSubscribed: (event: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "live-before-ack",
          content: "newer live event",
          change_sequence: 10,
          created_at: "2026-05-08T10:02:00Z",
        }),
      });
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          since: "snapshot-floor",
          limit: 100,
        },
        expect.any(AbortSignal),
      );
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        { changed_since: 1, changed_since_id: "snapshot-floor", limit: 100 },
        expect.any(AbortSignal),
      );
    });
    expect(result.current.messages.map((message) => message.id)).toContain(
      "missed-before-group",
    );
  });

  it("retries the exact gap request once and converges after a transient failure", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "gap-retry-floor", change_sequence: 1 })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages
      .mockRejectedValueOnce(new Error("temporary gap failure"))
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "gap-retry-recovered",
            change_sequence: 2,
            created_at: "2026-05-08T10:01:00Z",
          }),
        ],
        has_more: false,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() =>
      expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(2),
    );
    expect(chatApiMock.bffGapFillChatMessages).toHaveBeenNthCalledWith(
      2,
      TRIP_ID,
      { since: "gap-retry-floor", limit: 100 },
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.id)).toContain(
        "gap-retry-recovered",
      ),
    );
  });

  it("surfaces a recoverable gap error after the bounded retry is exhausted", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "gap-error-floor", change_sequence: 1 })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockRejectedValue(
      new Error("persistent gap failure"),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => expect(result.current.errorCode).toBe("GAP_FILL_FAILED"));
    expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(2);
  });

  it("retries the exact change-sync request once and converges", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({ id: "change-retry", content: "before", change_sequence: 4 }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages
      .mockRejectedValueOnce(new Error("temporary change failure"))
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "change-retry",
            content: "after retry",
            change_sequence: 5,
          }),
        ],
        has_more: false,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() =>
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledTimes(2),
    );
    expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenNthCalledWith(
      2,
      TRIP_ID,
      { changed_since: 4, changed_since_id: "change-retry", limit: 100 },
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(result.current.messages[0].content).toBe("after retry"),
    );
  });

  it("syncs existing message mutations after subscribe using the pre-gap-fill sequence", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "existing",
          content: "before reaction",
          created_at: "2026-05-08T10:00:00Z",
          updated_at: "2026-05-08T10:00:00Z",
          change_sequence: 10,
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "new-message",
          content: "new while offline",
          created_at: "2026-05-08T10:03:00Z",
          updated_at: "2026-05-08T10:03:00Z",
          change_sequence: 12,
        }),
      ],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "existing",
          content: "before reaction",
          created_at: "2026-05-08T10:00:00Z",
          updated_at: "2026-05-08T10:02:00Z",
          change_sequence: 11,
          reactions: [{ emoji: "👍", count: 1, reacted_by_ids: ["user-other"] }],
        }),
      ],
      has_more: false,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledWith(
        TRIP_ID,
        {
          changed_since: 10,
          changed_since_id: "existing",
          limit: 100,
        },
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        "existing",
        "new-message",
      ]);
      expect(result.current.messages[0].reactions).toEqual([
        { emoji: "👍", count: 1, reacted_by_ids: ["user-other"] },
      ]);
    });
  });

  it("does not let a delayed change-sync page overwrite a newer live update", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "change-race",
          content: "initial",
          change_sequence: 5,
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    let resolveChangeSync:
      | ((value: { results: ChatMessage[]; has_more: boolean }) => void)
      | null = null;
    chatApiMock.bffSyncChangedChatMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveChangeSync = resolve;
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() =>
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalled(),
    );

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (event: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "change-race",
          content: "new live version",
          change_sequence: 7,
        }),
      });
    });

    await act(async () => {
      resolveChangeSync?.({
        results: [
          makeMessage({
            id: "change-race",
            content: "delayed sequence six",
            change_sequence: 6,
          }),
        ],
        has_more: false,
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "new live version",
      change_sequence: 7,
    });
  });

  it("does not add unloaded history messages from change sync mutation pages", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "loaded-latest",
          content: "loaded window",
          created_at: "2026-05-08T10:00:00Z",
          updated_at: "2026-05-08T10:00:00Z",
          change_sequence: 10,
        }),
      ],
      next_cursor: "older-cursor",
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValueOnce({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "unloaded-old-message",
          content: "",
          created_at: "2026-05-08T09:00:00Z",
          updated_at: "2026-05-08T10:02:00Z",
          change_sequence: 11,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:02:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      ],
      has_more: false,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalled();
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["loaded-latest"]);
    expect(result.current.hasMoreOlder).toBe(true);
  });

  it("continues changed sync by sequence and id even when wall-clock timestamps regress", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "existing",
          created_at: "2026-05-08T10:00:00Z",
          updated_at: "2026-05-08T12:00:00Z",
          change_sequence: 10,
        }),
        makeMessage({
          id: "same-time-b",
          created_at: "2026-05-08T09:58:00Z",
          updated_at: "2026-05-08T12:30:00Z",
          change_sequence: 8,
        }),
        makeMessage({
          id: "same-time-a",
          created_at: "2026-05-08T09:57:00Z",
          updated_at: "2026-05-08T12:30:00Z",
          change_sequence: 8,
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValueOnce({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "same-time-a",
            created_at: "2026-05-08T09:57:00Z",
            updated_at: "2026-05-08T08:02:00Z",
            change_sequence: 11,
            reactions: [{ emoji: "👍", count: 1, reacted_by_ids: ["user-other"] }],
          }),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "same-time-b",
            created_at: "2026-05-08T09:58:00Z",
            updated_at: "2026-05-08T07:02:00Z",
            change_sequence: 11,
            reactions: [{ emoji: "😂", count: 1, reacted_by_ids: ["user-other"] }],
          }),
        ],
        has_more: false,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenNthCalledWith(
        2,
        TRIP_ID,
        {
          changed_since: 11,
          changed_since_id: "same-time-a",
          limit: 100,
        },
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        "same-time-a",
        "same-time-b",
        "existing",
      ]);
      expect(result.current.messages[0].reactions[0].emoji).toBe("👍");
      expect(result.current.messages[1].reactions[0].emoji).toBe("😂");
    });
  });

  it("loads latest history on subscribe ack when there is no gap-fill anchor yet", async () => {
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [],
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "first-after-subscribe",
            content: "first missed message",
            created_at: "2026-05-08T10:03:00Z",
            change_sequence: 7,
          }),
        ],
        next_cursor: null,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        "first-after-subscribe",
      ]);
    });
    expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledWith(
      TRIP_ID,
      { changed_since: 7, changed_since_id: "first-after-subscribe", limit: 100 },
      expect.any(AbortSignal),
    );
  });

  it("surfaces an error when reconnect gap-fill reaches its safety cap", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({
          id: "history-latest",
          created_at: "2026-05-08T10:00:00Z",
        }),
      ],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockImplementation(async () => {
      const callNumber = chatApiMock.bffGapFillChatMessages.mock.calls.length;
      return {
        results: [
          makeMessage({
            id: `gap-${callNumber}`,
            created_at: `2026-05-08T10:${String(callNumber + 1).padStart(2, "0")}:00Z`,
          }),
        ],
        has_more: true,
      };
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (e: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    await waitFor(() => {
      expect(result.current.errorCode).toBe("GAP_FILL_INCOMPLETE");
    });
    expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(50);
  });

  it("drains the newest reconnect recovery after an older catch-up finishes", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "reconnect-floor", change_sequence: 1 })],
      next_cursor: null,
    });
    let resolveFirstGap:
      | ((value: { results: ChatMessage[]; has_more: boolean }) => void)
      | null = null;
    chatApiMock.bffGapFillChatMessages
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstGap = resolve;
        }),
      )
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "newest-reconnect-data",
            change_sequence: 3,
            created_at: "2026-05-08T10:03:00Z",
          }),
        ],
        has_more: false,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribeAttempt?: () => void;
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(1));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribeAttempt?: () => void;
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribeAttempt?.();
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await act(async () => {
      resolveFirstGap?.({
        results: [
          makeMessage({
            id: "stale-first-recovery",
            change_sequence: 2,
            created_at: "2026-05-08T10:02:00Z",
          }),
        ],
        has_more: false,
      });
    });

    await waitFor(() => expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.id)).toContain(
        "newest-reconnect-data",
      ),
    );
    expect(result.current.messages.map((message) => message.id)).not.toContain(
      "stale-first-recovery",
    );
  });

  it("does not label generic HTTP 400 history errors as invalid message content", async () => {
    chatApiMock.bffListChatHistory.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: { detail: "Bad query." },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.errorCode).toBe("BAD_REQUEST");
  });

  it("does not infer lost trip access from a bodyless HTTP 404", async () => {
    chatApiMock.bffListChatHistory.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404, data: null },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.status).not.toBe("kicked");
    expect(result.current.errorCode).toBe("INIT_FAILED");
  });

  it("does not terminal-lock chat from an unknown HTTP 409", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: {} },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.sendMessage("unknown conflict");
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.sendLockReason).toBeNull();
    expect(result.current.errorCode).toBe("SEND_FAILED");
    expect(result.current.failedClientIds.size).toBe(1);
  });

  it("optimistically renders sent message, then confirms with server message", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage.mockImplementation(
      async (_tripId, input) => ({
        message: makeMessage({
          id: "server-id",
          sender: { ...ME },
          content: input.content,
          client_message_id: input.client_message_id,
          created_at: "2026-05-08T10:05:00Z",
        }),
        status: 201 as const,
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    let outcome: string = "";
    await act(async () => {
      outcome = await result.current.sendMessage("hi there");
    });

    expect(outcome).toBe("ok");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe("server-id");
    expect(result.current.pendingClientIds.size).toBe(0);
  });

  it("dedupes when WS push and POST result share the same client_message_id", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });

    let capturedClientId: string | null = null;
    chatApiMock.bffSendChatMessage.mockImplementation(async (_t, input) => {
      capturedClientId = input.client_message_id;
      return {
        message: makeMessage({
          id: "server-id",
          sender: { ...ME },
          content: input.content,
          client_message_id: input.client_message_id,
          created_at: "2026-05-08T10:05:00Z",
        }),
        status: 201 as const,
      };
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // Kick off send but immediately deliver the WS push first.
    let sendPromise: Promise<unknown> | null = null;
    act(() => {
      sendPromise = result.current.sendMessage("yo");
    });

    // Wait until POST has been called so we know the clientMessageId
    await waitFor(() => {
      expect(capturedClientId).not.toBeNull();
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (e: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "server-id",
          sender: { ...ME },
          content: "yo",
          client_message_id: capturedClientId,
          created_at: "2026-05-08T10:05:00Z",
        }),
      });
    });

    await act(async () => {
      await sendPromise;
    });

    // Exactly one bubble for that message — no duplicate.
    const matching = result.current.messages.filter((m) => m.id === "server-id");
    expect(matching).toHaveLength(1);
    expect(result.current.pendingClientIds.size).toBe(0);
  });

  it.each([
    ["timeout", { isAxiosError: true, response: undefined }],
    [
      "throttle",
      {
        isAxiosError: true,
        response: { status: 429, data: { error_code: "THROTTLED" } },
      },
    ],
  ])(
    "treats a websocket confirmation as authoritative before a late HTTP %s",
    async (_label, lateError) => {
      chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
      let capturedClientId: string | null = null;
      let rejectSend: ((reason?: unknown) => void) | null = null;
      chatApiMock.bffSendChatMessage.mockImplementation((_tripId, input) => {
        capturedClientId = input.client_message_id;
        return new Promise((_resolve, reject) => {
          rejectSend = reject;
        });
      });

      const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      let sendPromise: Promise<unknown> | null = null;
      act(() => {
        sendPromise = result.current.sendMessage("confirmed over websocket");
      });
      await waitFor(() => expect(capturedClientId).not.toBeNull());

      act(() => {
        const listeners = wsBridgeMock.listenersRef.current as unknown as {
          onMessage: (event: unknown) => void;
        };
        listeners.onMessage({
          type: "chat.message",
          trip_id: TRIP_ID,
          message: makeMessage({
            id: "ws-authoritative-send",
            sender: { ...ME },
            content: "confirmed over websocket",
            client_message_id: capturedClientId,
            change_sequence: 2,
          }),
        });
      });

      let outcome: unknown;
      await act(async () => {
        rejectSend?.(lateError);
        outcome = await sendPromise;
      });

      expect(outcome).toBe("ok");
      expect(result.current.messages.map((message) => message.id)).toEqual([
        "ws-authoritative-send",
      ]);
      expect(result.current.pendingClientIds.size).toBe(0);
      expect(result.current.failedClientIds.size).toBe(0);
      expect(result.current.errorCode).toBeNull();
    },
  );

  it.each(["THROTTLED", "AI_BUSY", "INVALID_AI_PROMPT"])(
    "preserves a failed retry bubble when retry is blocked by %s",
    async (errorCode) => {
      chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
      chatApiMock.bffSendChatMessage
        .mockRejectedValueOnce(new Error("initial transient failure"))
        .mockRejectedValueOnce({
          isAxiosError: true,
          response: { status: 429, data: { error_code: errorCode } },
        });

      const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        await result.current.sendMessage("keep this retry text");
      });
      const clientMessageId = result.current.messages[0].client_message_id;
      expect(clientMessageId).not.toBeNull();

      await act(async () => {
        await result.current.retryPending(clientMessageId!);
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe("keep this retry text");
      expect(result.current.pendingClientIds.has(clientMessageId!)).toBe(true);
      expect(result.current.failedClientIds.has(clientMessageId!)).toBe(true);
      expect(result.current.errorCode).toBe(errorCode);
    },
  );

  it("transitions to kicked state on kicked push", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "sensitive-transcript" })],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onKicked: (e: unknown) => void;
      };
      listeners.onKicked({ type: "chat.kicked", trip_id: TRIP_ID });
    });

    expect(result.current.status).toBe("kicked");
    expect(result.current.messages).toEqual([]);
    expect(result.current.pendingClientIds.size).toBe(0);
  });

  it("does not let deferred initial history reopen a kicked room", async () => {
    let resolveHistory:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(wsBridgeMock.listenersRef.current).not.toBeNull());

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onKicked: (event: unknown) => void;
      };
      listeners.onKicked({ type: "chat.kicked", trip_id: TRIP_ID });
      resolveHistory?.({
        results: [makeMessage({ id: "late-initial-sensitive" })],
        next_cursor: null,
      });
    });

    await waitFor(() => expect(result.current.status).toBe("kicked"));
    expect(result.current.messages).toEqual([]);
  });

  it("does not let deferred older history or catch-up mutate a kicked room", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValueOnce({
      results: [makeMessage({ id: "kicked-floor", change_sequence: 1 })],
      next_cursor: "older-cursor",
    });
    let resolveOlder:
      | ((value: { results: ChatMessage[]; next_cursor: string | null }) => void)
      | null = null;
    chatApiMock.bffListChatHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
    );
    let resolveGap:
      | ((value: { results: ChatMessage[]; has_more: boolean }) => void)
      | null = null;
    chatApiMock.bffGapFillChatMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGap = resolve;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderPromise: Promise<void> | null = null;
    act(() => {
      olderPromise = result.current.loadOlder();
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onSubscribed: (event: unknown) => void;
      };
      listeners.onSubscribed({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => {
      expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2);
      expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(1);
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onKicked: (event: unknown) => void;
      };
      listeners.onKicked({ type: "chat.kicked", trip_id: TRIP_ID });
    });
    await act(async () => {
      resolveOlder?.({
        results: [makeMessage({ id: "late-older-sensitive" })],
        next_cursor: null,
      });
      resolveGap?.({
        results: [makeMessage({ id: "late-gap-sensitive", change_sequence: 2 })],
        has_more: false,
      });
      await olderPromise;
    });

    expect(result.current.status).toBe("kicked");
    expect(result.current.messages).toEqual([]);
  });

  it("treats room access errors as kicked after missed membership changes", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onError: (e: unknown) => void;
      };
      listeners.onError({
        type: "chat.error",
        trip_id: TRIP_ID,
        error_code: "TRIP_NOT_FOUND",
        detail: "Trip not found.",
      });
    });

    expect(result.current.status).toBe("kicked");
  });

  it("moves to kicked when send discovers lost trip access", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 404,
        data: { detail: "Trip not found.", error_code: "TRIP_NOT_FOUND" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    let outcome: string = "";
    await act(async () => {
      outcome = await result.current.sendMessage("still here?");
    });

    expect(outcome).toBe("failed");
    expect(result.current.status).toBe("kicked");
  });

  it("locks sending and removes the optimistic message when backend marks the trip terminal", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { detail: "Trip is read-only.", error_code: "TRIP_TERMINAL" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    let outcome: string = "";
    await act(async () => {
      outcome = await result.current.sendMessage("too late");
    });

    expect(outcome).toBe("failed");
    expect(result.current.sendLockReason).toBe("terminal");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.failedClientIds.size).toBe(0);
  });

  it("locks chat mutations when a reaction discovers the trip is terminal", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "terminal-reaction" })],
      next_cursor: null,
    });
    chatApiMock.bffAddReaction.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { detail: "Trip is read-only.", error_code: "TRIP_TERMINAL" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.toggleReaction("terminal-reaction", "👍");
    });

    expect(result.current.sendLockReason).toBe("terminal");
    expect(result.current.errorCode).toBe("TRIP_TERMINAL");
  });

  it("locks chat mutations when delete discovers the trip is terminal", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "terminal-delete" })],
      next_cursor: null,
    });
    chatApiMock.bffDeleteChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { detail: "Trip is read-only.", error_code: "TRIP_TERMINAL" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.deleteMessage("terminal-delete", "for_me");
    });

    expect(result.current.sendLockReason).toBe("terminal");
    expect(result.current.errorCode).toBe("TRIP_TERMINAL");
  });

  it("locks chat mutations when bulk hide discovers the trip is terminal", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "terminal-hide" })],
      next_cursor: null,
    });
    chatApiMock.bffHideChatMessagesForMe.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { detail: "Trip is read-only.", error_code: "TRIP_TERMINAL" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.hideMessagesForMe(["terminal-hide"]);
    });

    expect(result.current.sendLockReason).toBe("terminal");
    expect(result.current.errorCode).toBe("TRIP_TERMINAL");
  });

  it("marks failed sends so the UI can offer retry", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });

    chatApiMock.bffSendChatMessage.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    let outcome: string = "";
    await act(async () => {
      outcome = await result.current.sendMessage("oops");
    });

    expect(outcome).toBe("failed");
    expect(result.current.failedClientIds.size).toBe(1);
  });

  it("hides a single message for the current user without deleting it globally", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "hide-me" })],
      next_cursor: null,
    });
    chatApiMock.bffDeleteChatMessage.mockResolvedValueOnce({
      mode: "for_me",
      hidden_message_ids: ["hide-me"],
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.deleteMessage("hide-me", "for_me");
    });

    expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalledWith(
      TRIP_ID,
      "hide-me",
      "for_me",
    );
    expect(result.current.messages).toHaveLength(0);
  });

  it("applies message_deleted websocket tombstones", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "delete-everyone", content: "secret" })],
      next_cursor: null,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (e: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "delete-everyone",
          content: "",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:01:00Z",
          deleted_for_everyone_by_id: ME.id,
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });

    expect(result.current.messages[0].is_deleted_for_everyone).toBe(true);
    expect(result.current.messages[0].content).toBe("");
  });

  it("keeps tombstones irreversible against newer full and reaction events", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [
        makeMessage({ id: "irreversible", content: "secret", change_sequence: 1 }),
      ],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (event: unknown) => void;
        onMessage: (event: unknown) => void;
        onReactionUpdate: (event: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "irreversible",
          content: "",
          change_sequence: 5,
          updated_at: "2026-05-08T10:05:00Z",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
          deleted_for_everyone_by_id: ME.id,
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "irreversible",
          content: "must not resurrect",
          change_sequence: 6,
        }),
      });
      listeners.onReactionUpdate({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "irreversible",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 7,
        updated_at: "2026-05-08T10:07:00Z",
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      content: "",
      change_sequence: 5,
      is_deleted_for_everyone: true,
      reactions: [],
    });
  });

  it("accepts a websocket tombstone as authoritative before delete HTTP times out", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "delete-ws-first", change_sequence: 1 })],
      next_cursor: null,
    });
    let rejectDelete: ((reason?: unknown) => void) | null = null;
    chatApiMock.bffDeleteChatMessage.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDelete = reject;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let deletePromise: Promise<void> | null = null;
    act(() => {
      deletePromise = result.current.deleteMessage("delete-ws-first", "for_everyone");
    });
    await waitFor(() => expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalled());
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (event: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "delete-ws-first",
          content: "",
          change_sequence: 2,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:02:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });
    await act(async () => {
      rejectDelete?.(new Error("late timeout"));
      await deletePromise;
    });

    expect(result.current.messages[0].is_deleted_for_everyone).toBe(true);
    expect(result.current.errorCode).toBeNull();
  });

  it("still reports delete failure when the live push is not a tombstone", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "delete-unrelated", change_sequence: 1 })],
      next_cursor: null,
    });
    let rejectDelete: ((reason?: unknown) => void) | null = null;
    chatApiMock.bffDeleteChatMessage.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDelete = reject;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let deletePromise: Promise<void> | null = null;
    act(() => {
      deletePromise = result.current.deleteMessage("delete-unrelated", "for_everyone");
    });
    await waitFor(() => expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalled());
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessage: (event: unknown) => void;
      };
      listeners.onMessage({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "delete-unrelated",
          content: "unrelated edit",
          change_sequence: 2,
        }),
      });
    });
    await act(async () => {
      rejectDelete?.(new Error("late timeout"));
      await deletePromise;
    });

    expect(result.current.errorCode).toBe("DELETE_FAILED");
    expect(result.current.messages[0].is_deleted_for_everyone).toBe(false);
  });

  it("does not add unloaded history messages from message_deleted websocket tombstones", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "loaded-message", content: "visible" })],
      next_cursor: "older-cursor",
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (e: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "unloaded-old-message",
          content: "",
          created_at: "2026-05-08T09:00:00Z",
          updated_at: "2026-05-08T10:02:00Z",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:02:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });

    expect(result.current.messages.map((m) => m.id)).toEqual(["loaded-message"]);
    expect(result.current.hasMoreOlder).toBe(true);
  });

  it("does not resurrect a locally hidden message when a global delete event arrives later", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "hidden-before-global-delete" })],
      next_cursor: null,
    });
    chatApiMock.bffHideChatMessagesForMe.mockResolvedValueOnce({
      hidden_message_ids: ["hidden-before-global-delete"],
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.hideMessagesForMe(["hidden-before-global-delete"]);
    });

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (e: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "hidden-before-global-delete",
          content: "",
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:02:00Z",
          deleted_for_everyone_by_id: ME.id,
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("surfaces reaction mutation errors instead of swallowing them", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "react-fails" })],
      next_cursor: null,
    });
    chatApiMock.bffAddReaction.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { detail: "Message is deleted.", error_code: "MESSAGE_DELETED" },
      },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.toggleReaction("react-fails", "👍");
    });

    expect(result.current.errorCode).toBe("MESSAGE_DELETED");
  });

  it("discards inverted lower-sequence realtime reaction updates", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "reaction-order", change_sequence: 1 })],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onReactionUpdate: (event: unknown) => void;
      };
      listeners.onReactionUpdate({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "reaction-order",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 3,
        updated_at: "2026-05-08T09:00:00Z",
      });
      listeners.onReactionUpdate({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "reaction-order",
        reactions: [{ emoji: "😂", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 2,
        updated_at: "2026-05-08T12:00:00Z",
      });
    });

    expect(result.current.messages[0]).toMatchObject({
      change_sequence: 3,
      updated_at: "2026-05-08T09:00:00Z",
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
    });
  });

  it("accepts the intended websocket reaction outcome before HTTP times out", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "reaction-ws-first", change_sequence: 1 })],
      next_cursor: null,
    });
    let rejectReaction: ((reason?: unknown) => void) | null = null;
    chatApiMock.bffAddReaction.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectReaction = reject;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let reactionPromise: Promise<void> | null = null;
    act(() => {
      reactionPromise = result.current.toggleReaction("reaction-ws-first", "👍");
    });
    await waitFor(() => expect(chatApiMock.bffAddReaction).toHaveBeenCalled());
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onReactionUpdate: (event: unknown) => void;
      };
      listeners.onReactionUpdate({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "reaction-ws-first",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 2,
        updated_at: "2026-05-08T10:02:00Z",
      });
    });
    await act(async () => {
      rejectReaction?.(new Error("late timeout"));
      await reactionPromise;
    });

    expect(result.current.messages[0].reactions).toEqual([
      { emoji: "👍", count: 1, reacted_by_ids: [ME.id] },
    ]);
    expect(result.current.errorCode).toBeNull();
  });

  it("still reports reaction failure when the live push proves another outcome", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "reaction-unrelated", change_sequence: 1 })],
      next_cursor: null,
    });
    let rejectReaction: ((reason?: unknown) => void) | null = null;
    chatApiMock.bffAddReaction.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectReaction = reject;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let reactionPromise: Promise<void> | null = null;
    act(() => {
      reactionPromise = result.current.toggleReaction("reaction-unrelated", "👍");
    });
    await waitFor(() => expect(chatApiMock.bffAddReaction).toHaveBeenCalled());
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onReactionUpdate: (event: unknown) => void;
      };
      listeners.onReactionUpdate({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "reaction-unrelated",
        reactions: [{ emoji: "😂", count: 1, reacted_by_ids: ["other-user"] }],
        change_sequence: 2,
        updated_at: "2026-05-08T10:02:00Z",
      });
    });
    await act(async () => {
      rejectReaction?.(new Error("late timeout"));
      await reactionPromise;
    });

    expect(result.current.errorCode).toBe("REACTION_FAILED");
  });

  it("does not let a delayed reaction HTTP result mutate a newer tombstone", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "reaction-delete-race", change_sequence: 1 })],
      next_cursor: null,
    });
    let resolveReaction:
      | ((value: {
          reactions: { emoji: string; count: number; reacted_by_ids: string[] }[];
          change_sequence: number;
          updated_at: string;
        }) => void)
      | null = null;
    chatApiMock.bffAddReaction.mockReturnValue(
      new Promise((resolve) => {
        resolveReaction = resolve;
      }),
    );
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let reactionPromise: Promise<void> | null = null;
    act(() => {
      reactionPromise = result.current.toggleReaction("reaction-delete-race", "👍");
    });
    await waitFor(() => expect(chatApiMock.bffAddReaction).toHaveBeenCalled());

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onMessageDeleted: (event: unknown) => void;
      };
      listeners.onMessageDeleted({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "reaction-delete-race",
          content: "",
          change_sequence: 3,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:03:00Z",
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
        }),
      });
    });

    await act(async () => {
      resolveReaction?.({
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 2,
        updated_at: "2026-05-08T10:02:00Z",
      });
      await reactionPromise;
    });

    expect(result.current.messages[0]).toMatchObject({
      change_sequence: 3,
      is_deleted_for_everyone: true,
      reactions: [],
    });
  });

  it("clears operation errors after a successful reaction update", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "react-recovers" })],
      next_cursor: null,
    });
    chatApiMock.bffAddReaction
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: { detail: "Message is deleted.", error_code: "MESSAGE_DELETED" },
        },
      })
      .mockResolvedValueOnce({
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 2,
        updated_at: "2026-05-08T10:01:00Z",
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      await result.current.toggleReaction("react-recovers", "👍");
    });
    expect(result.current.errorCode).toBe("MESSAGE_DELETED");

    await act(async () => {
      await result.current.toggleReaction("react-recovers", "👍");
    });

    expect(result.current.errorCode).toBeNull();
  });

  it("drops optimistic AI prompt when backend returns AI_BUSY", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { error_code: "AI_BUSY" } },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.sendMessage("@GoPlanAI hello");
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.errorCode).toBe("AI_BUSY");
  });

  it("drops optimistic AI prompt when backend throttles GoPlanAI prompts", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 429, data: { error_code: "THROTTLED" } },
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendMessage("@GoPlanAI hello");
    });

    expect(outcome).toBe("blocked");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.errorCode).toBe("THROTTLED");
  });

  it("tracks AI typing state from realtime events and only clears the active interaction", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));

    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onAITypingStarted: (e: unknown) => void;
        onAITypingStopped: (e: unknown) => void;
      };
      listeners.onAITypingStarted({
        type: "chat.ai_typing_started",
        trip_id: TRIP_ID,
        interaction_id: "interaction-1",
        requested_by_user_id: ME.id,
      });
    });

    expect(result.current.isAITyping).toBe(true);

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onAITypingStopped: (e: unknown) => void;
      };
      listeners.onAITypingStopped({
        type: "chat.ai_typing_stopped",
        trip_id: TRIP_ID,
        interaction_id: "other-interaction",
      });
    });

    expect(result.current.isAITyping).toBe(true);

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as {
        onAITypingStopped: (e: unknown) => void;
      };
      listeners.onAITypingStopped({
        type: "chat.ai_typing_stopped",
        trip_id: TRIP_ID,
        interaction_id: "interaction-1",
      });
    });

    expect(result.current.isAITyping).toBe(false);
  });

  it.each(["SUCCESS", "ERROR"] as const)(
    "clears AI typing when an AI %s message arrives without the stopped event",
    async (aiStatus) => {
      chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });

      const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
      await waitFor(() => expect(result.current.status).toBe("ready"));

      act(() => {
        const listeners = wsBridgeMock.listenersRef.current as unknown as {
          onAITypingStarted: (e: unknown) => void;
          onMessage: (e: unknown) => void;
        };
        listeners.onAITypingStarted({
          type: "chat.ai_typing_started",
          trip_id: TRIP_ID,
          interaction_id: "interaction-final",
          requested_by_user_id: ME.id,
        });
        listeners.onMessage({
          type: "chat.message",
          trip_id: TRIP_ID,
          message: makeMessage({
            id: `ai-${aiStatus.toLowerCase()}`,
            sender: {
              id: null,
              display_name: "GoPlanAI",
              identify_tag: null,
              avatar_url: null,
            },
            sender_kind: "AI",
            ai_status: aiStatus,
            content: aiStatus === "SUCCESS" ? "AI answer" : "GoPlanAI can't respond right now. Please try again later.",
          }),
        });
      });

      expect(result.current.isAITyping).toBe(false);
      expect(result.current.messages[0].sender_kind).toBe("AI");
    },
  );

  it("ignores duplicate reaction clicks while a reaction mutation is in flight", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "react-once" })],
      next_cursor: null,
    });

    let resolveReaction:
      | ((value: {
          reactions: { emoji: string; count: number; reacted_by_ids: string[] }[];
          change_sequence: number;
          updated_at: string;
        }) => void)
      | null = null;
    chatApiMock.bffAddReaction.mockReturnValue(
      new Promise((resolve) => {
        resolveReaction = resolve;
      }),
    );

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    await act(async () => {
      const first = result.current.toggleReaction("react-once", "👍");
      const second = result.current.toggleReaction("react-once", "👍");
      resolveReaction?.({
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 2,
        updated_at: "2026-05-08T10:01:00Z",
      });
      await Promise.all([first, second]);
    });

    expect(chatApiMock.bffAddReaction).toHaveBeenCalledTimes(1);
  });

  it("materializes a delayed history base with the highest unknown reaction snapshot", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "loaded-window", change_sequence: 10 })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "delayed-reaction-base",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 5,
        updated_at: "2026-05-08T10:05:00Z",
      });
    });

    await act(async () => {
      older.resolve({
        results: [
          makeMessage({
            id: "delayed-reaction-base",
            content: "older base",
            change_sequence: 1,
            created_at: "2026-05-08T09:00:00Z",
          }),
        ],
        next_cursor: null,
      });
      await olderPromise;
    });

    expect(
      result.current.messages.find((message) => message.id === "delayed-reaction-base"),
    ).toMatchObject({
      content: "older base",
      change_sequence: 5,
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
    });
  });

  it("lets an unknown reaction be replaced by a newer tombstone before history settles", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "reaction-tombstone-window" })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "reaction-then-tombstone",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 5,
        updated_at: "2026-05-08T10:05:00Z",
      });
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "reaction-then-tombstone",
          content: "",
          change_sequence: 6,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:06:00Z",
        }),
      });
    });

    await act(async () => {
      older.resolve({
        results: [makeMessage({ id: "reaction-then-tombstone", change_sequence: 1 })],
        next_cursor: null,
      });
      await olderPromise;
    });

    const tombstones = result.current.messages.filter(
      (message) => message.id === "reaction-then-tombstone",
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      content: "",
      change_sequence: 6,
      is_deleted_for_everyone: true,
      reactions: [],
    });
  });

  it("keeps an unknown tombstone against higher, equal and lower late reactions", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "tombstone-reaction-window" })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "tombstone-then-reaction",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
      for (const changeSequence of [6, 5, 4]) {
        listeners.onReactionUpdate?.({
          type: "chat.reaction_update",
          trip_id: TRIP_ID,
          message_id: "tombstone-then-reaction",
          reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
          change_sequence: changeSequence,
          updated_at: "2026-05-08T10:05:00Z",
        });
      }
    });

    await act(async () => {
      older.resolve({
        results: [makeMessage({ id: "tombstone-then-reaction", change_sequence: 1 })],
        next_cursor: null,
      });
      await olderPromise;
    });

    const tombstones = result.current.messages.filter(
      (message) => message.id === "tombstone-then-reaction",
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      content: "",
      change_sequence: 5,
      is_deleted_for_everyone: true,
      reactions: [],
    });
  });

  it.each([5, 6])(
    "lets an authoritative sequence %s full row supersede an unknown reaction snapshot at sequence 5",
    async (fullSequence) => {
      chatApiMock.bffListChatHistory
        .mockResolvedValueOnce({
          results: [makeMessage({ id: `authoritative-${fullSequence}-window` })],
          next_cursor: "older-page",
        })
        .mockResolvedValueOnce({
          results: [
            makeMessage({
              id: `authoritative-${fullSequence}`,
              change_sequence: fullSequence,
              reactions: [{ emoji: "❤️", count: 1, reacted_by_ids: ["other"] }],
            }),
          ],
          next_cursor: null,
        });

      const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => {
        const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
        listeners.onReactionUpdate?.({
          type: "chat.reaction_update",
          trip_id: TRIP_ID,
          message_id: `authoritative-${fullSequence}`,
          reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
          change_sequence: 5,
          updated_at: "2026-05-08T10:05:00Z",
        });
      });
      await act(async () => result.current.loadOlder());

      expect(
        result.current.messages.find(
          (message) => message.id === `authoritative-${fullSequence}`,
        )?.reactions,
      ).toEqual([{ emoji: "❤️", count: 1, reacted_by_ids: ["other"] }]);
    },
  );

  it("compacts a known-only patch after its pre-push history request settles without the ID", async () => {
    const firstOlder = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "compact-window" })],
        next_cursor: "older-1",
      })
      .mockReturnValueOnce(firstOlder.promise)
      .mockResolvedValueOnce({
        results: [
          makeMessage({
            id: "compacted-target",
            change_sequence: 1,
            reactions: [],
          }),
        ],
        next_cursor: null,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "compacted-target",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 5,
        updated_at: "2026-05-08T10:05:00Z",
      });
    });
    await act(async () => {
      firstOlder.resolve({
        results: [makeMessage({ id: "different-older-row" })],
        next_cursor: "older-2",
      });
      await firstPromise;
    });
    await act(async () => result.current.loadOlder());

    expect(
      result.current.messages.find((message) => message.id === "compacted-target"),
    ).toMatchObject({ change_sequence: 1, reactions: [] });
  });

  it("compacts an unknown tombstone after its pre-push history request settles", async () => {
    const firstOlder = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "tombstone-compact-window" })],
        next_cursor: "older-1",
      })
      .mockReturnValueOnce(firstOlder.promise)
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "compacted-tombstone-target", change_sequence: 1 })],
        next_cursor: null,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "compacted-tombstone-target",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
    });

    await act(async () => {
      firstOlder.resolve({
        results: [makeMessage({ id: "different-tombstone-page-row" })],
        next_cursor: "older-2",
      });
      await firstPromise;
    });
    await act(async () => result.current.loadOlder());

    expect(
      result.current.messages.find(
        (message) => message.id === "compacted-tombstone-target",
      ),
    ).toMatchObject({ change_sequence: 1, is_deleted_for_everyone: false });
  });

  it("compacts an unknown tombstone when its active history request exhausts without the ID", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "tombstone-exhaustion-window" })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "tombstone-exhausted-target",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
    });
    older.resolve({ results: [], next_cursor: null });
    await act(async () => olderPromise);
    expect(result.current.hasMoreOlder).toBe(false);

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "tombstone-exhausted-target",
          content: "authoritative after exhaustion",
          change_sequence: 1,
        }),
      });
    });

    expect(
      result.current.messages.find(
        (message) => message.id === "tombstone-exhausted-target",
      ),
    ).toMatchObject({
      content: "authoritative after exhaustion",
      change_sequence: 1,
      is_deleted_for_everyone: false,
    });
  });

  it("retains every unknown row from one changed-sync batch during active history", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "batch-floor-anchor", change_sequence: 1 })],
        next_cursor: "older-page",
      })
      .mockReturnValueOnce(older.promise);
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValueOnce({
      results: [
        makeMessage({
          id: "batch-tombstone",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
        makeMessage({
          id: "batch-full-row",
          content: "authoritative changed-sync content",
          change_sequence: 6,
        }),
      ],
      has_more: false,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onSubscribeAttempt?.();
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() =>
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledTimes(1),
    );

    older.resolve({
      results: [
        makeMessage({
          id: "batch-tombstone",
          content: "stale deleted content",
          change_sequence: 1,
        }),
        makeMessage({
          id: "batch-full-row",
          content: "stale full-row content",
          change_sequence: 1,
        }),
      ],
      next_cursor: null,
    });
    await act(async () => olderPromise);

    expect(
      result.current.messages.find(
        (message) => message.id === "batch-tombstone",
      ),
    ).toMatchObject({
      content: "",
      change_sequence: 5,
      is_deleted_for_everyone: true,
    });
    expect(
      result.current.messages.find((message) => message.id === "batch-full-row"),
    ).toMatchObject({
      content: "authoritative changed-sync content",
      change_sequence: 6,
      is_deleted_for_everyone: false,
    });
  });

  it.each([
    ["tombstone then higher full row", true],
    ["full row then lower tombstone", false],
  ] as const)(
    "preserves irreversible unknown-floor ordering for %s",
    async (_label, tombstoneFirst) => {
      const older = deferred<{
        results: ChatMessage[];
        next_cursor: string | null;
      }>();
      const targetId = tombstoneFirst
        ? "same-floor-tombstone-first"
        : "same-floor-full-first";
      const tombstone = makeMessage({
        id: targetId,
        content: "",
        change_sequence: 5,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: "2026-05-08T10:05:00Z",
      });
      const fullRow = makeMessage({
        id: targetId,
        content: "authoritative full sequence six",
        change_sequence: 6,
      });
      chatApiMock.bffListChatHistory
        .mockResolvedValueOnce({
          results: [makeMessage({ id: `${targetId}-anchor` })],
          next_cursor: "older-page",
        })
        .mockReturnValueOnce(older.promise);
      chatApiMock.bffGapFillChatMessages.mockResolvedValue({
        results: [],
        has_more: false,
      });
      chatApiMock.bffSyncChangedChatMessages.mockResolvedValueOnce({
        results: tombstoneFirst
          ? [tombstone, fullRow]
          : [fullRow, tombstone],
        has_more: false,
      });
      const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
      await waitFor(() => expect(result.current.status).toBe("ready"));

      let olderPromise!: Promise<void>;
      act(() => {
        olderPromise = result.current.loadOlder();
      });
      await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
      act(() => {
        const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
        listeners.onSubscribeAttempt?.();
        listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
      });
      await waitFor(() =>
        expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledTimes(1),
      );

      older.resolve({
        results: [
          makeMessage({
            id: targetId,
            content: "stale history base",
            change_sequence: 1,
          }),
        ],
        next_cursor: null,
      });
      await act(async () => olderPromise);

      const materialized = result.current.messages.filter(
        (message) => message.id === targetId,
      );
      expect(materialized).toHaveLength(1);
      expect(materialized[0]).toMatchObject(
        tombstoneFirst
          ? {
              content: "",
              change_sequence: 5,
              is_deleted_for_everyone: true,
            }
          : {
              content: "authoritative full sequence six",
              change_sequence: 6,
              is_deleted_for_everyone: false,
            },
      );
    },
  );

  it("compacts an unknown changed-sync row before a later authoritative history page", async () => {
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "changed-floor", change_sequence: 1 })],
        next_cursor: "older-page",
      })
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "changed-only-target", change_sequence: 1 })],
        next_cursor: null,
      });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({
      results: [],
      has_more: false,
    });
    chatApiMock.bffSyncChangedChatMessages.mockResolvedValueOnce({
      results: [makeMessage({ id: "changed-only-target", change_sequence: 5 })],
      has_more: false,
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() =>
      expect(chatApiMock.bffSyncChangedChatMessages).toHaveBeenCalledTimes(1),
    );
    expect(
      result.current.messages.some((message) => message.id === "changed-only-target"),
    ).toBe(false);

    await act(async () => result.current.loadOlder());

    expect(
      result.current.messages.find((message) => message.id === "changed-only-target"),
    ).toMatchObject({ change_sequence: 1 });
  });

  it("does not retain unknown patches after authoritative history exhaustion", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onReactionUpdate?.({
        type: "chat.reaction_update",
        trip_id: TRIP_ID,
        message_id: "post-exhaustion",
        reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
        change_sequence: 5,
        updated_at: "2026-05-08T10:05:00Z",
      });
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({ id: "post-exhaustion", change_sequence: 1 }),
      });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "post-exhaustion",
    ]);
  });

  it("does not retain unknown tombstones after authoritative history exhaustion", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [],
      next_cursor: null,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onMessageDeleted?.({
        type: "chat.message_deleted",
        trip_id: TRIP_ID,
        message: makeMessage({
          id: "post-exhaustion-tombstone",
          content: "",
          change_sequence: 5,
          is_deleted_for_everyone: true,
          deleted_for_everyone_at: "2026-05-08T10:05:00Z",
        }),
      });
      listeners.onMessage?.({
        type: "chat.message",
        trip_id: TRIP_ID,
        message: makeMessage({ id: "post-exhaustion-tombstone", change_sequence: 1 }),
      });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "post-exhaustion-tombstone",
    ]);
  });

  it("preserves history but rejects mutations synchronously after a pre-ACK subscription error", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "subscription-history" })],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage.mockResolvedValue({
      message: makeMessage({ id: "should-not-send" }),
      status: 201,
    });
    chatApiMock.bffAddReaction.mockResolvedValue({
      reactions: [],
      change_sequence: 2,
      updated_at: "2026-05-08T10:01:00Z",
    });
    chatApiMock.bffDeleteChatMessage.mockResolvedValue({
      mode: "for_me",
      hidden_message_ids: ["subscription-history"],
    });
    chatApiMock.bffHideChatMessagesForMe.mockResolvedValue({
      hidden_message_ids: ["subscription-history"],
    });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onError?.({
        type: "chat.error",
        trip_id: TRIP_ID,
        error_code: "SUBSCRIPTION_LIMIT_REACHED",
        detail: "Too many rooms.",
      });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "subscription-history",
    ]);
    expect(result.current.sendLockReason).toBe("subscription");
    await act(async () => {
      await Promise.all([
        result.current.sendMessage("blocked"),
        result.current.toggleReaction("subscription-history", "👍"),
        result.current.deleteMessage("subscription-history", "for_me"),
        result.current.hideMessagesForMe(["subscription-history"]),
      ]);
    });
    expect(chatApiMock.bffSendChatMessage).not.toHaveBeenCalled();
    expect(chatApiMock.bffAddReaction).not.toHaveBeenCalled();
    expect(chatApiMock.bffDeleteChatMessage).not.toHaveBeenCalled();
    expect(chatApiMock.bffHideChatMessagesForMe).not.toHaveBeenCalled();
  });

  it("keeps a rejected subscription read-only until a later attempt is ACKed", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "subscription-recovery" })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({ results: [], has_more: false });
    chatApiMock.bffSendChatMessage.mockResolvedValue({
      message: makeMessage({ id: "subscription-send" }),
      status: 201,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;

    act(() => {
      listeners.onError?.({
        type: "chat.error",
        trip_id: TRIP_ID,
        error_code: "SUBSCRIPTION_LIMIT_REACHED",
        detail: "Too many rooms.",
      });
      listeners.onSubscribeAttempt?.();
    });
    await act(async () => {
      await result.current.sendMessage("still blocked before ACK");
    });
    expect(chatApiMock.bffSendChatMessage).not.toHaveBeenCalled();

    act(() => {
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => expect(result.current.sendLockReason).toBeNull());
    await act(async () => {
      await result.current.sendMessage("allowed after ACK");
    });
    expect(chatApiMock.bffSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a post-ACK websocket error as a warning without locking mutations", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "post-ack-warning" })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({ results: [], has_more: false });
    chatApiMock.bffSendChatMessage.mockResolvedValue({
      message: makeMessage({ id: "post-ack-send" }),
      status: 201,
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
    act(() => {
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
      listeners.onError?.({
        type: "chat.error",
        trip_id: TRIP_ID,
        error_code: "SERVER_ERROR",
        detail: "Transient warning.",
      });
    });

    expect(result.current.errorCode).toBe("SERVER_ERROR");
    expect(result.current.sendLockReason).toBeNull();
    await act(async () => {
      await result.current.sendMessage("still writable");
    });
    expect(chatApiMock.bffSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("marks an unexpected current unsubscribe read-only until reconnect ACK", async () => {
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "unexpected-unsubscribe" })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockResolvedValue({ results: [], has_more: false });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
    act(() => {
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
      listeners.onUnsubscribed?.({ type: "chat.unsubscribed", trip_id: TRIP_ID });
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "unexpected-unsubscribe",
    ]);
    expect(result.current.sendLockReason).toBe("subscription");
    expect(result.current.errorCode).toBe("CHAT_UNSUBSCRIBED");
  });

  it("aborts stale recovery and starts the new epoch before the old request settles", async () => {
    const oldRecovery = deferred<{ results: ChatMessage[]; has_more: boolean }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "recovery-anchor", change_sequence: 1 })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages
      .mockReturnValueOnce(oldRecovery.promise)
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "new-recovery-row", change_sequence: 2 })],
        has_more: false,
      });

    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
    act(() => {
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(1));
    const oldSignal = chatApiMock.bffGapFillChatMessages.mock.calls[0]?.[2] as
      | AbortSignal
      | undefined;

    act(() => {
      listeners.onSubscribeAttempt?.();
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(result.current.messages.some((message) => message.id === "new-recovery-row")).toBe(
        true,
      ),
    );

    await act(async () => {
      oldRecovery.resolve({
        results: [makeMessage({ id: "late-old-recovery", change_sequence: 2 })],
        has_more: false,
      });
      await oldRecovery.promise;
    });
    expect(
      result.current.messages.some((message) => message.id === "late-old-recovery"),
    ).toBe(false);
  });

  it("retires recovery and leaves the bridge immediately on an exact access kick", async () => {
    const recovery = deferred<{ results: ChatMessage[]; has_more: boolean }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "kick-recovery-anchor" })],
      next_cursor: null,
    });
    chatApiMock.bffGapFillChatMessages.mockReturnValueOnce(recovery.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
    act(() => {
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });
    await waitFor(() => expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(1));
    const signal = chatApiMock.bffGapFillChatMessages.mock.calls[0]?.[2] as
      | AbortSignal
      | undefined;

    act(() => {
      listeners.onError?.({
        type: "chat.error",
        trip_id: TRIP_ID,
        error_code: "TRIP_NOT_FOUND",
        detail: "Access removed.",
      });
      listeners.onSubscribeAttempt?.();
      listeners.onSubscribed?.({ type: "chat.subscribed", trip_id: TRIP_ID });
    });

    expect(result.current.status).toBe("kicked");
    expect(signal?.aborted).toBe(true);
    expect(wsBridgeMock.handle.leave).toHaveBeenCalledTimes(1);
    expect(chatApiMock.bffGapFillChatMessages).toHaveBeenCalledTimes(1);
    recovery.resolve({ results: [], has_more: false });
    await recovery.promise;
  });

  it("deduplicates same-tick loadOlder callbacks synchronously", async () => {
    const older = deferred<{ results: ChatMessage[]; next_cursor: string | null }>();
    chatApiMock.bffListChatHistory
      .mockResolvedValueOnce({
        results: [makeMessage({ id: "load-single-flight" })],
        next_cursor: "older",
      })
      .mockReturnValue(older.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadOlder();
      second = result.current.loadOlder();
    });
    expect(chatApiMock.bffListChatHistory).toHaveBeenCalledTimes(2);
    older.resolve({ results: [], next_cursor: null });
    await act(async () => Promise.all([first, second]));
  });

  it("deduplicates same-tick initial sends synchronously", async () => {
    const send = deferred<{ message: ChatMessage; status: 200 | 201 }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    chatApiMock.bffSendChatMessage.mockReturnValue(send.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.sendMessage("first");
      second = result.current.sendMessage("second");
    });
    expect(chatApiMock.bffSendChatMessage).toHaveBeenCalledTimes(1);
    send.resolve({ message: makeMessage({ id: "sent-once" }), status: 201 });
    await act(async () => Promise.all([first, second]));
  });

  it("deduplicates same-CID retry callbacks synchronously", async () => {
    const retry = deferred<{ message: ChatMessage; status: 200 | 201 }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({ results: [], next_cursor: null });
    chatApiMock.bffSendChatMessage
      .mockRejectedValueOnce(new Error("first failure"))
      .mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.sendMessage("retry me");
    });
    const clientMessageId = [...result.current.failedClientIds][0];
    expect(clientMessageId).toBeDefined();

    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.retryPending(clientMessageId);
      second = result.current.retryPending(clientMessageId);
    });
    expect(chatApiMock.bffSendChatMessage).toHaveBeenCalledTimes(2);
    retry.resolve({
      message: makeMessage({ id: "retry-once", client_message_id: clientMessageId }),
      status: 201,
    });
    await act(async () => Promise.all([first, second]));
  });

  it("deduplicates same-message delete callbacks synchronously", async () => {
    const deletion = deferred<{
      mode: "for_me";
      hidden_message_ids: string[];
    }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "delete-single-flight" })],
      next_cursor: null,
    });
    chatApiMock.bffDeleteChatMessage.mockReturnValue(deletion.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.deleteMessage("delete-single-flight", "for_me");
      second = result.current.deleteMessage("delete-single-flight", "for_me");
    });
    expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalledTimes(1);
    deletion.resolve({
      mode: "for_me",
      hidden_message_ids: ["delete-single-flight"],
    });
    await act(async () => Promise.all([first, second]));
  });

  it("deduplicates same-tick bulk hide callbacks synchronously", async () => {
    const hide = deferred<{ hidden_message_ids: string[] }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "hide-single-flight" })],
      next_cursor: null,
    });
    chatApiMock.bffHideChatMessagesForMe.mockReturnValue(hide.promise);
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.hideMessagesForMe(["hide-single-flight"]);
      second = result.current.hideMessagesForMe(["hide-single-flight"]);
    });
    expect(chatApiMock.bffHideChatMessagesForMe).toHaveBeenCalledTimes(1);
    hide.resolve({ hidden_message_ids: ["hide-single-flight"] });
    await act(async () => Promise.all([first, second]));
  });

  it("terminal lock clears pending, failed, typing and synchronously blocks every mutation", async () => {
    const lateSend = deferred<{ message: ChatMessage; status: 200 | 201 }>();
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: [makeMessage({ id: "terminal-lock-target" })],
      next_cursor: null,
    });
    chatApiMock.bffSendChatMessage
      .mockRejectedValueOnce(new Error("create failed bubble"))
      .mockReturnValueOnce(lateSend.promise);
    chatApiMock.bffAddReaction.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error_code: "TRIP_TERMINAL", detail: "Trip closed." },
      },
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("failed bubble");
    });
    const failedClientId = [...result.current.failedClientIds][0];
    let lateSendPromise!: Promise<string>;
    act(() => {
      lateSendPromise = result.current.sendMessage("pending bubble");
      const listeners = wsBridgeMock.listenersRef.current as unknown as TestChatListeners;
      listeners.onAITypingStarted?.({
        type: "chat.ai_typing_started",
        trip_id: TRIP_ID,
        interaction_id: "terminal-typing",
        requested_by_user_id: ME.id,
      });
    });
    await waitFor(() => expect(result.current.isSending).toBe(true));
    await act(async () => {
      await result.current.toggleReaction("terminal-lock-target", "👍");
    });

    expect(result.current.sendLockReason).toBe("terminal");
    expect(result.current.pendingClientIds.size).toBe(0);
    expect(result.current.failedClientIds.size).toBe(0);
    expect(result.current.isSending).toBe(false);
    expect(result.current.isAITyping).toBe(false);
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "terminal-lock-target",
    ]);

    const counts = {
      send: chatApiMock.bffSendChatMessage.mock.calls.length,
      reaction: chatApiMock.bffAddReaction.mock.calls.length,
      deletion: chatApiMock.bffDeleteChatMessage.mock.calls.length,
      hide: chatApiMock.bffHideChatMessagesForMe.mock.calls.length,
    };
    await act(async () => {
      await Promise.all([
        result.current.sendMessage("blocked after terminal"),
        result.current.retryPending(failedClientId),
        result.current.toggleReaction("terminal-lock-target", "👍"),
        result.current.deleteMessage("terminal-lock-target", "for_me"),
        result.current.hideMessagesForMe(["terminal-lock-target"]),
      ]);
    });
    expect(chatApiMock.bffSendChatMessage).toHaveBeenCalledTimes(counts.send);
    expect(chatApiMock.bffAddReaction).toHaveBeenCalledTimes(counts.reaction);
    expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalledTimes(counts.deletion);
    expect(chatApiMock.bffHideChatMessagesForMe).toHaveBeenCalledTimes(counts.hide);

    lateSend.resolve({
      message: makeMessage({ id: "late-terminal-send" }),
      status: 201,
    });
    await act(async () => lateSendPromise);
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "terminal-lock-target",
    ]);
  });

  it("ignores late mutation results after another request terminal-locks chat", async () => {
    const reaction = deferred<{
      reactions: ChatMessage["reactions"];
      change_sequence: number;
      updated_at: string;
    }>();
    const deletion = deferred<{
      mode: "for_me";
      hidden_message_ids: string[];
    }>();
    const hide = deferred<{ hidden_message_ids: string[] }>();
    const messageIds = ["late-reaction", "late-delete", "late-hide"];
    chatApiMock.bffListChatHistory.mockResolvedValue({
      results: messageIds.map((id) => makeMessage({ id })),
      next_cursor: null,
    });
    chatApiMock.bffAddReaction.mockReturnValue(reaction.promise);
    chatApiMock.bffDeleteChatMessage.mockReturnValue(deletion.promise);
    chatApiMock.bffHideChatMessagesForMe.mockReturnValue(hide.promise);
    chatApiMock.bffSendChatMessage.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error_code: "TRIP_TERMINAL", detail: "Trip closed." },
      },
    });
    const { result } = renderHook(() => useTripChat(TRIP_ID, ME));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let reactionPromise!: Promise<void>;
    let deletionPromise!: Promise<void>;
    let hidePromise!: Promise<void>;
    act(() => {
      reactionPromise = result.current.toggleReaction("late-reaction", "👍");
      deletionPromise = result.current.deleteMessage("late-delete", "for_me");
      hidePromise = result.current.hideMessagesForMe(["late-hide"]);
    });
    await waitFor(() => {
      expect(chatApiMock.bffAddReaction).toHaveBeenCalledTimes(1);
      expect(chatApiMock.bffDeleteChatMessage).toHaveBeenCalledTimes(1);
      expect(chatApiMock.bffHideChatMessagesForMe).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      expect(await result.current.sendMessage("discover terminal")).toBe("failed");
    });
    expect(result.current.sendLockReason).toBe("terminal");

    reaction.resolve({
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: [ME.id] }],
      change_sequence: 10,
      updated_at: "2026-05-08T10:10:00Z",
    });
    deletion.resolve({ mode: "for_me", hidden_message_ids: ["late-delete"] });
    hide.resolve({ hidden_message_ids: ["late-hide"] });
    await act(async () => {
      await Promise.all([reactionPromise, deletionPromise, hidePromise]);
    });

    expect(result.current.errorCode).toBe("TRIP_TERMINAL");
    expect(
      result.current.messages.map((message) => message.id).sort(),
    ).toEqual([...messageIds].sort());
    expect(
      result.current.messages.find((message) => message.id === "late-reaction")
        ?.reactions,
    ).toEqual([]);
  });
});
