import {
  CHAT_WS_MESSAGE_TYPES,
  type WsConnectionStatus,
  type WsMessage,
} from "@/features/realtime/domain/types";
import { wsManager } from "@/features/realtime/infrastructure/ws-manager";
import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";
import { parseChatWsEvent } from "@/features/chat/infrastructure/chat-ws-parser";

import type {
  WsChatAITypingStarted,
  WsChatAITypingStopped,
  WsChatError,
  WsChatKicked,
  WsChatMessageDeleted,
  WsChatMessagePush,
  WsChatReactionUpdate,
  WsChatSubscribed,
  WsChatUnsubscribed,
} from "@/features/chat/domain/types";

type ChatRoomListeners = {
  onMessage?: (event: WsChatMessagePush) => void;
  /** Fired synchronously after a subscribe command is accepted by the socket. */
  onSubscribeAttempt?: () => void;
  onMessageDeleted?: (event: WsChatMessageDeleted) => void;
  onKicked?: (event: WsChatKicked) => void;
  onError?: (event: WsChatError) => void;
  onSubscribed?: (event: WsChatSubscribed) => void;
  onUnsubscribed?: (event: WsChatUnsubscribed) => void;
  onReactionUpdate?: (event: WsChatReactionUpdate) => void;
  onAITypingStarted?: (event: WsChatAITypingStarted) => void;
  onAITypingStopped?: (event: WsChatAITypingStopped) => void;
};

type ChatRoomHandle = {
  /** Idempotent. If current, stops listening and sends `chat.unsubscribe` if connected. */
  leave: () => void;
};

type RoomState = {
  listeners: ChatRoomListeners;
  owner: symbol;
  /** True after we've sent `chat.subscribe` for the current socket session. */
  sentSubscribe: boolean;
};

/**
 * Module-level registry of active chat rooms. Survives socket reconnects so the
 * bridge can re-emit `chat.subscribe` for every active room when the socket
 * comes back up.
 */
const rooms = new Map<string, RoomState>();

let lifecycleInstalled = false;
let lastStatus: WsConnectionStatus = "disconnected";

function sendSubscribe(tripId: string, room: RoomState): boolean {
  const sent = wsManager.send({
    type: CHAT_WS_MESSAGE_TYPES.SUBSCRIBE,
    trip_id: tripId,
  });
  if (sent) room.listeners.onSubscribeAttempt?.();
  return sent;
}

function ensureLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  wsManager.on(CHAT_WS_MESSAGE_TYPES.MESSAGE, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.MESSAGE, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.MESSAGE) return;
    rooms.get(event.trip_id)?.listeners.onMessage?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED) return;
    rooms.get(event.trip_id)?.listeners.onMessageDeleted?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.KICKED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.KICKED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.KICKED) return;
    const room = rooms.get(event.trip_id);
    if (!room) return;
    rooms.delete(event.trip_id);
    room.listeners.onKicked?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.ERROR, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.ERROR, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.ERROR) return;
    rooms.get(event.trip_id)?.listeners.onError?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.SUBSCRIBED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.SUBSCRIBED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.SUBSCRIBED) return;
    rooms.get(event.trip_id)?.listeners.onSubscribed?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED) return;
    rooms.get(event.trip_id)?.listeners.onUnsubscribed?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE) return;
    rooms.get(event.trip_id)?.listeners.onReactionUpdate?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED) return;
    rooms.get(event.trip_id)?.listeners.onAITypingStarted?.(event);
  });

  wsManager.on(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED, (data: WsMessage) => {
    const event = parseChatWsEvent(CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED, data);
    if (event?.type !== CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED) return;
    rooms.get(event.trip_id)?.listeners.onAITypingStopped?.(event);
  });

  wsManager.onStatusChange((status) => {
    if (status === "connected" && lastStatus !== "connected") {
      // Resubscribe every active room on reconnect.
      for (const [tripId, room] of rooms) {
        room.sentSubscribe = sendSubscribe(tripId, room);
      }
    }
    if (status !== "connected") {
      // Sockets dropped — server forgets group membership.
      for (const room of rooms.values()) {
        room.sentSubscribe = false;
      }
    }
    lastStatus = status;
  });

  // Initialize lastStatus to current value so a manager already in "connected"
  // doesn't trigger the resubscribe-on-transition branch above.
  lastStatus = wsManager.getStatus();
}

/**
 * Subscribe the current WebSocket session to the chat room of `tripId`.
 *
 * Safe to call multiple times for the same `tripId`; subsequent calls replace
 * the listener set. Older handles become stale, and the latest handle's
 * `leave()` is the only correct way to undo the subscription.
 *
 * If the socket is not currently OPEN, the subscribe message is queued by way
 * of the active-rooms registry — the bridge will emit `chat.subscribe` as soon
 * as the next "connected" transition fires.
 */
export function joinChatRoom(
  tripId: string,
  listeners: ChatRoomListeners,
): ChatRoomHandle {
  const canonicalTripId = canonicalizeChatTripId(tripId);
  if (canonicalTripId === null) {
    return { leave: () => {} };
  }
  ensureLifecycle();
  const owner = Symbol(canonicalTripId);
  const existing = rooms.get(canonicalTripId);
  if (existing) {
    existing.listeners = listeners;
    existing.owner = owner;
    if (!existing.sentSubscribe && wsManager.getStatus() === "connected") {
      existing.sentSubscribe = sendSubscribe(canonicalTripId, existing);
    }
  } else {
    const room: RoomState = { listeners, owner, sentSubscribe: false };
    rooms.set(canonicalTripId, room);
    room.sentSubscribe =
      wsManager.getStatus() === "connected" && sendSubscribe(canonicalTripId, room);
  }

  let left = false;
  return {
    leave: () => {
      if (left) return;
      left = true;
      const room = rooms.get(canonicalTripId);
      if (!room) return;
      if (room.owner !== owner) return;
      rooms.delete(canonicalTripId);
      if (wsManager.getStatus() === "connected" && room.sentSubscribe) {
        wsManager.send({
          type: CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBE,
          trip_id: canonicalTripId,
        });
      }
    },
  };
}

/** Test-only: clear bridge state between cases. */
export function __resetChatBridgeForTests(): void {
  rooms.clear();
  lifecycleInstalled = false;
  lastStatus = "disconnected";
}
