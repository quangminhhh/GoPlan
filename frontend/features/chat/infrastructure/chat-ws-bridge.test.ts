import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_WS_MESSAGE_TYPES } from "@/features/realtime/domain/types";

import type {
  WsConnectionStatus,
  WsMessage,
} from "@/features/realtime/domain/types";

const wsManagerMock = vi.hoisted(() => {
  let status: WsConnectionStatus = "connected";
  const messageListeners = new Map<string, Set<(data: WsMessage) => void>>();
  const statusListeners = new Set<(nextStatus: WsConnectionStatus) => void>();
  const send = vi.fn(() => true);

  return {
    wsManager: {
      getStatus: () => status,
      send,
      on: (type: string, callback: (data: WsMessage) => void) => {
        const listeners = messageListeners.get(type) ?? new Set();
        listeners.add(callback);
        messageListeners.set(type, listeners);
        return () => {
          listeners.delete(callback);
        };
      },
      onStatusChange: (callback: (nextStatus: WsConnectionStatus) => void) => {
        statusListeners.add(callback);
        return () => {
          statusListeners.delete(callback);
        };
      },
    },
    reset: () => {
      status = "connected";
      send.mockClear();
      messageListeners.clear();
      statusListeners.clear();
    },
    emit: (type: string, data: WsMessage) => {
      for (const listener of messageListeners.get(type) ?? []) listener(data);
    },
    setStatus: (nextStatus: WsConnectionStatus) => {
      status = nextStatus;
      for (const listener of statusListeners) listener(nextStatus);
    },
    send,
  };
});

vi.mock("@/features/realtime/infrastructure/ws-manager", () => ({
  wsManager: wsManagerMock.wsManager,
}));

import {
  __resetChatBridgeForTests,
  joinChatRoom,
} from "@/features/chat/infrastructure/chat-ws-bridge";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const AI_TRIP_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_AI_TRIP_ID = "33333333-3333-4333-8333-333333333333";

function validWireMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    trip_id: TRIP_ID,
    sender: {
      id: "user-1",
      display_name: "User",
      identify_tag: null,
      avatar_url: null,
    },
    sender_kind: "USER",
    ai_status: null,
    content: "hello",
    client_message_id: null,
    created_at: "2026-08-10T12:00:00Z",
    updated_at: "2026-08-10T12:00:00Z",
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

describe("chat-ws-bridge", () => {
  beforeEach(() => {
    wsManagerMock.reset();
    __resetChatBridgeForTests();
  });

  it("removes kicked rooms so reconnect does not resubscribe them", () => {
    const onKicked = vi.fn();

    joinChatRoom(TRIP_ID, { onKicked });

    expect(wsManagerMock.send).toHaveBeenCalledWith({
      type: CHAT_WS_MESSAGE_TYPES.SUBSCRIBE,
      trip_id: TRIP_ID,
    });
    wsManagerMock.send.mockClear();

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.KICKED, {
      type: CHAT_WS_MESSAGE_TYPES.KICKED,
      trip_id: TRIP_ID,
    });

    expect(onKicked).toHaveBeenCalledTimes(1);

    wsManagerMock.setStatus("disconnected");
    wsManagerMock.setStatus("connected");

    expect(wsManagerMock.send).not.toHaveBeenCalled();
  });

  it("routes message_deleted events to the subscribed room", () => {
    const onMessageDeleted = vi.fn();

    joinChatRoom(TRIP_ID, { onMessageDeleted });

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, {
      type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
      trip_id: TRIP_ID,
      message: validWireMessage({
        content: "",
        change_sequence: 2,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: "2026-08-10T12:01:00Z",
      }),
    });

    expect(onMessageDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
        trip_id: TRIP_ID,
      }),
    );
  });

  it("keeps the latest same-trip subscription active when an older handle leaves", () => {
    const onFirstMessage = vi.fn();
    const onSecondMessage = vi.fn();

    const firstHandle = joinChatRoom(TRIP_ID, {
      onMessage: onFirstMessage,
    });
    const secondHandle = joinChatRoom(TRIP_ID, {
      onMessage: onSecondMessage,
    });
    wsManagerMock.send.mockClear();

    firstHandle.leave();

    expect(wsManagerMock.send).not.toHaveBeenCalled();

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE, {
      type: CHAT_WS_MESSAGE_TYPES.MESSAGE,
      trip_id: TRIP_ID,
      message: validWireMessage(),
    });

    expect(onFirstMessage).not.toHaveBeenCalled();
    expect(onSecondMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CHAT_WS_MESSAGE_TYPES.MESSAGE,
        trip_id: TRIP_ID,
      }),
    );

    wsManagerMock.send.mockClear();

    secondHandle.leave();

    expect(wsManagerMock.send).toHaveBeenCalledWith({
      type: CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBE,
      trip_id: TRIP_ID,
    });
  });

  it("announces each accepted subscribe attempt before ACK processing", () => {
    const onSubscribeAttempt = vi.fn();
    joinChatRoom(TRIP_ID, { onSubscribeAttempt });

    expect(onSubscribeAttempt).toHaveBeenCalledTimes(1);

    wsManagerMock.setStatus("disconnected");
    wsManagerMock.setStatus("connected");

    expect(onSubscribeAttempt).toHaveBeenCalledTimes(2);
  });

  it("routes ai_typing_started to the correct room listener", () => {
    const onAITypingStarted = vi.fn();
    joinChatRoom(AI_TRIP_ID, { onAITypingStarted });

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED, {
      type: "chat.ai_typing_started",
      trip_id: AI_TRIP_ID,
      interaction_id: "int-1",
      requested_by_user_id: "user-1",
    });

    expect(onAITypingStarted).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat.ai_typing_started", trip_id: AI_TRIP_ID }),
    );
  });

  it("routes ai_typing_stopped to the correct room listener", () => {
    const onAITypingStopped = vi.fn();
    joinChatRoom(SECOND_AI_TRIP_ID, { onAITypingStopped });

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED, {
      type: "chat.ai_typing_stopped",
      trip_id: SECOND_AI_TRIP_ID,
      interaction_id: "int-2",
    });

    expect(onAITypingStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.ai_typing_stopped",
        trip_id: SECOND_AI_TRIP_ID,
      }),
    );
  });

  it("canonicalizes uppercase lifecycle identities and event routing", () => {
    const onMessageDeleted = vi.fn();
    const handle = joinChatRoom(TRIP_ID.toUpperCase(), { onMessageDeleted });

    expect(wsManagerMock.send).toHaveBeenCalledWith({
      type: CHAT_WS_MESSAGE_TYPES.SUBSCRIBE,
      trip_id: TRIP_ID,
    });

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, {
      type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
      trip_id: TRIP_ID.toUpperCase(),
      message: validWireMessage({
        content: "",
        change_sequence: 2,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: "2026-08-10T12:01:00Z",
      }),
    });
    expect(onMessageDeleted).toHaveBeenCalledTimes(1);

    handle.leave();
    expect(wsManagerMock.send).toHaveBeenLastCalledWith({
      type: CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBE,
      trip_id: TRIP_ID,
    });
  });

  it("does not install lifecycle handlers or send commands for malformed trip IDs", () => {
    const handle = joinChatRoom("not-a-uuid", { onMessage: vi.fn() });

    expect(wsManagerMock.send).not.toHaveBeenCalled();
    handle.leave();
    wsManagerMock.setStatus("disconnected");
    wsManagerMock.setStatus("connected");
    expect(wsManagerMock.send).not.toHaveBeenCalled();
  });

  it("ignores non-string trip IDs from untrusted realtime payloads", () => {
    const onMessageDeleted = vi.fn();
    joinChatRoom(TRIP_ID, { onMessageDeleted });

    expect(() => {
      wsManagerMock.emit(
        CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
        {
          type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
          trip_id: { malicious: true },
          message: null,
        } as never,
      );
    }).not.toThrow();
    expect(onMessageDeleted).not.toHaveBeenCalled();
  });

  it("rejects malformed nested payloads for every chat websocket variant", () => {
    const listeners = {
      onMessage: vi.fn(),
      onMessageDeleted: vi.fn(),
      onKicked: vi.fn(),
      onError: vi.fn(),
      onSubscribed: vi.fn(),
      onUnsubscribed: vi.fn(),
      onReactionUpdate: vi.fn(),
      onAITypingStarted: vi.fn(),
      onAITypingStopped: vi.fn(),
    };
    joinChatRoom(TRIP_ID, listeners);

    expect(() => {
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE, {
        type: CHAT_WS_MESSAGE_TYPES.MESSAGE,
        trip_id: TRIP_ID,
        message: null,
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, {
        type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
        trip_id: TRIP_ID,
        message: validWireMessage(),
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE, {
        type: CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE,
        trip_id: TRIP_ID,
        message_id: "msg-1",
        reactions: undefined,
        change_sequence: 2,
        updated_at: "2026-08-10T12:01:00Z",
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.ERROR, {
        type: CHAT_WS_MESSAGE_TYPES.ERROR,
        trip_id: TRIP_ID,
        error_code: 42,
        detail: "bad",
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.SUBSCRIBED, {
        type: "wrong.subscribed",
        trip_id: TRIP_ID,
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED, {
        type: null,
        trip_id: TRIP_ID,
      } as never);
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED, {
        type: CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED,
        trip_id: TRIP_ID,
        interaction_id: null,
        requested_by_user_id: null,
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED, {
        type: CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED,
        trip_id: TRIP_ID,
        interaction_id: {},
      });
      wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.KICKED, {
        type: "wrong.kicked",
        trip_id: TRIP_ID,
      });
    }).not.toThrow();

    for (const listener of Object.values(listeners)) {
      expect(listener).not.toHaveBeenCalled();
    }
  });

  it("rejects cross-room nested message identities", () => {
    const onMessage = vi.fn();
    const onMessageDeleted = vi.fn();
    joinChatRoom(TRIP_ID, { onMessage, onMessageDeleted });

    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE, {
      type: CHAT_WS_MESSAGE_TYPES.MESSAGE,
      trip_id: TRIP_ID,
      message: validWireMessage({ trip_id: SECOND_AI_TRIP_ID }),
    });
    wsManagerMock.emit(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, {
      type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
      trip_id: TRIP_ID,
      message: validWireMessage({
        trip_id: SECOND_AI_TRIP_ID,
        content: "",
        change_sequence: 2,
        is_deleted_for_everyone: true,
        deleted_for_everyone_at: "2026-08-10T12:01:00Z",
      }),
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageDeleted).not.toHaveBeenCalled();
  });
});
