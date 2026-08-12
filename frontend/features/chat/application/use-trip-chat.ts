"use client";

import axios from "axios";
import { useCallback, useEffect, useReducer, useRef } from "react";

import type { AxiosError } from "axios";

import {
  bffAddReaction,
  bffDeleteChatMessage,
  bffGapFillChatMessages,
  bffHideChatMessagesForMe,
  bffListChatHistory,
  bffRemoveReaction,
  bffSendChatMessage,
  bffSyncChangedChatMessages,
} from "@/features/chat/infrastructure/chat-api";
import { joinChatRoom } from "@/features/chat/infrastructure/chat-ws-bridge";
import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";

import type {
  ChatMessage,
  DeleteChatMessageMode,
  ReactionSummary,
  WsChatAITypingStarted,
  WsChatAITypingStopped,
  WsChatError,
  WsChatMessageDeleted,
  WsChatMessagePush,
  WsChatReactionUpdate,
} from "@/features/chat/domain/types";

const HISTORY_PAGE_SIZE = 30;
const GAP_FILL_PAGE_SIZE = 100;
const GAP_FILL_MAX_PAGES = 50; // hard upper bound to avoid infinite loops
const RECOVERY_REQUEST_MAX_ATTEMPTS = 2;
const RECOVERY_RETRY_DELAY_MS = 50;
const ROOM_ACCESS_LOST_ERROR_CODES = new Set(["TRIP_NOT_FOUND", "FORBIDDEN"]);

export type ChatRoomStatus = "loading" | "ready" | "error" | "kicked";
type SendLockReason = "subscription" | "terminal";

type SendOutcome = "ok" | "duplicate" | "failed" | "blocked";
type ChangedSyncCursor = { changeSequence: number; id: string };
type UnknownReactionSnapshot = {
  reactions: ReactionSummary[];
  changeSequence: number;
  updatedAt: string;
};
type MessageSequenceFloor = {
  changeSequence: number;
  tombstoned: boolean;
  /** History request already in flight when this known-only update arrived. */
  observedHistoryRequestGeneration?: number;
  reactionSnapshot?: UnknownReactionSnapshot;
  /** Full changed-sync row, held until history proves the message is in view. */
  fullSnapshot?: ChatMessage;
};
type RecoveryFloor = {
  gapSinceId: string | null;
  changedCursor: ChangedSyncCursor | null;
};
type SubscriptionAttempt = {
  resourceGeneration: number;
  generation: number;
  tripId: string;
  floor: RecoveryFloor | undefined;
  acked: boolean;
};
type RecoveryRequest = {
  resourceGeneration: number;
  subscriptionGeneration: number;
  tripId: string;
  floor: RecoveryFloor;
};
type ActiveRecovery = {
  request: RecoveryRequest;
  controller: AbortController;
};
type ActiveSend = {
  resourceGeneration: number;
  clientMessageId: string;
};

export type UseTripChatResult = {
  status: ChatRoomStatus;
  errorCode: string | null;
  /** Messages in ascending order by (created_at, id). Includes optimistic. */
  messages: ChatMessage[];
  /** Set of client_message_ids that haven't been confirmed by server yet. */
  pendingClientIds: Set<string>;
  /** Set of client_message_ids whose POST resolved with an error. */
  failedClientIds: Set<string>;
  sendLockReason: SendLockReason | null;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  isSending: boolean;
  isAITyping: boolean;
  loadOlder: () => Promise<void>;
  sendMessage: (content: string) => Promise<SendOutcome>;
  retryPending: (clientMessageId: string) => Promise<SendOutcome>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  deleteMessage: (messageId: string, mode: DeleteChatMessageMode) => Promise<void>;
  hideMessagesForMe: (messageIds: string[]) => Promise<void>;
};

type ChatState = {
  status: ChatRoomStatus;
  errorCode: string | null;
  /** id → message, source of truth for confirmed (server-acknowledged) messages. */
  confirmed: Map<string, ChatMessage>;
  /** Highest known sequence/tombstone state, including unloaded known-only patches. */
  messageFloors: Map<string, MessageSequenceFloor>;
  /** client_message_id → optimistic ChatMessage, replaced once confirmed. */
  pending: Map<string, ChatMessage>;
  /** Server ids hidden in this session through "remove for me". */
  hidden: Set<string>;
  failed: Set<string>;
  sendLockReason: SendLockReason | null;
  hasMoreOlder: boolean;
  nextOlderCursor: string | null;
  isLoadingOlder: boolean;
  historyRequestGeneration: number;
  activeHistoryRequestGeneration: number | null;
  isSending: boolean;
  activeAIInteractionId: string | null;
  aiTypingRequestedByUserId: string | null;
};

type ChatAction =
  | { type: "INIT_START" }
  | {
      type: "INIT_SUCCESS";
      messages: ChatMessage[];
      nextCursor: string | null;
    }
  | { type: "INIT_ERROR"; errorCode: string }
  | { type: "LOAD_OLDER_START" }
  | {
      type: "LOAD_OLDER_SUCCESS";
      messages: ChatMessage[];
      nextCursor: string | null;
    }
  | { type: "LOAD_OLDER_ERROR" }
  | { type: "UPSERT_CONFIRMED"; messages: ChatMessage[] }
  | { type: "PATCH_CONFIRMED"; messages: ChatMessage[] }
  | { type: "ADD_PENDING"; message: ChatMessage }
  | { type: "CONFIRM_PENDING"; clientMessageId: string; message: ChatMessage }
  | { type: "FAIL_PENDING"; clientMessageId: string }
  | { type: "CLEAR_FAILED"; clientMessageId: string }
  | { type: "LOCK_SEND_TERMINAL" }
  | { type: "LOCK_SUBSCRIPTION"; errorCode: string }
  | { type: "SUBSCRIPTION_READY" }
  | { type: "SEND_START" }
  | { type: "SEND_END" }
  | { type: "KICKED" }
  | { type: "WS_ERROR"; errorCode: string }
  | { type: "CLEAR_ROOM_ERROR" }
  | {
      type: "UPDATE_REACTIONS";
      messageId: string;
      reactions: ReactionSummary[];
      changeSequence: number;
      updatedAt: string;
    }
  | { type: "HIDE_MESSAGES"; messageIds: string[] }
  | { type: "AI_TYPING_STARTED"; interactionId: string; requestedByUserId: string | null }
  | { type: "AI_TYPING_STOPPED"; interactionId: string }
  | { type: "DROP_PENDING"; clientMessageId: string };

function initialState(): ChatState {
  return {
    status: "loading",
    errorCode: null,
    confirmed: new Map(),
    messageFloors: new Map(),
    pending: new Map(),
    hidden: new Set(),
    failed: new Set(),
    sendLockReason: null,
    hasMoreOlder: false,
    nextOlderCursor: null,
    isLoadingOlder: false,
    historyRequestGeneration: 0,
    activeHistoryRequestGeneration: null,
    isSending: false,
    activeAIInteractionId: null,
    aiTypingRequestedByUserId: null,
  };
}

function isSafeChangeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canApplyConfirmedMessage(
  existing: ChatMessage | undefined,
  incoming: ChatMessage,
  floor: MessageSequenceFloor | undefined,
): boolean {
  if (!isSafeChangeSequence(incoming.change_sequence)) return false;
  if (floor !== undefined) {
    if (incoming.change_sequence < floor.changeSequence) return false;
    if (floor.tombstoned && !incoming.is_deleted_for_everyone) return false;
  }
  if (existing === undefined) return true;
  if (incoming.change_sequence < existing.change_sequence) return false;
  // A global-delete tombstone is irreversible. A later stale/full payload must
  // never resurrect its content, actions, or reactions.
  if (existing.is_deleted_for_everyone && !incoming.is_deleted_for_everyone) {
    return false;
  }
  return true;
}

function advanceMessageFloor(
  floors: Map<string, MessageSequenceFloor>,
  message: ChatMessage,
  observedHistoryRequestGeneration?: number,
  fullSnapshot?: ChatMessage,
): boolean {
  if (!isSafeChangeSequence(message.change_sequence)) return false;
  const existing = floors.get(message.id);
  if (existing?.tombstoned && !message.is_deleted_for_everyone) return false;
  if (existing === undefined || message.change_sequence > existing.changeSequence) {
    floors.set(message.id, {
      changeSequence: message.change_sequence,
      tombstoned: Boolean(existing?.tombstoned || message.is_deleted_for_everyone),
      ...(observedHistoryRequestGeneration !== undefined
        ? { observedHistoryRequestGeneration }
        : {}),
      ...(fullSnapshot !== undefined ? { fullSnapshot } : {}),
    });
    return true;
  }
  if (
    message.change_sequence === existing.changeSequence &&
    message.is_deleted_for_everyone &&
    !existing.tombstoned
  ) {
    floors.set(message.id, {
      changeSequence: existing.changeSequence,
      tombstoned: true,
      ...(observedHistoryRequestGeneration !== undefined
        ? { observedHistoryRequestGeneration }
        : existing.observedHistoryRequestGeneration !== undefined
          ? {
              observedHistoryRequestGeneration:
                existing.observedHistoryRequestGeneration,
            }
          : {}),
      ...(fullSnapshot !== undefined ? { fullSnapshot } : {}),
    });
    return true;
  }
  return false;
}

function withoutReactionSnapshot(
  floor: MessageSequenceFloor | undefined,
): MessageSequenceFloor | undefined {
  if (floor === undefined || floor.reactionSnapshot === undefined) return floor;
  if (!floor.tombstoned) return undefined;
  return {
    changeSequence: floor.changeSequence,
    tombstoned: true,
    ...(floor.observedHistoryRequestGeneration !== undefined
      ? {
          observedHistoryRequestGeneration:
            floor.observedHistoryRequestGeneration,
        }
      : {}),
    ...(floor.fullSnapshot !== undefined
      ? { fullSnapshot: floor.fullSnapshot }
      : {}),
  };
}

function withReactionSnapshot(
  message: ChatMessage,
  snapshot: UnknownReactionSnapshot,
): ChatMessage {
  return {
    ...message,
    reactions: snapshot.reactions,
    change_sequence: snapshot.changeSequence,
    updated_at: snapshot.updatedAt,
  };
}

function compactKnownOnlyFloors(
  messageFloors: Map<string, MessageSequenceFloor>,
  settledHistoryRequestGeneration: number | null,
): void {
  if (settledHistoryRequestGeneration === null) return;
  for (const [messageId, floor] of messageFloors) {
    const observedGeneration = floor.observedHistoryRequestGeneration;
    if (
      observedGeneration !== undefined &&
      observedGeneration <= settledHistoryRequestGeneration
    ) {
      messageFloors.delete(messageId);
    }
  }
}

function applyHistoryMessages(
  state: ChatState,
  messages: ChatMessage[],
): {
  confirmed: Map<string, ChatMessage>;
  messageFloors: Map<string, MessageSequenceFloor>;
} {
  const confirmed = new Map(state.confirmed);
  const messageFloors = new Map(state.messageFloors);
  const activeRequestGeneration = state.activeHistoryRequestGeneration;

  for (const message of messages) {
    if (state.hidden.has(message.id)) continue;
    const floor = messageFloors.get(message.id);
    const snapshot = floor?.reactionSnapshot;
    const arrivedDuringThisRequest =
      activeRequestGeneration !== null &&
      floor?.observedHistoryRequestGeneration === activeRequestGeneration;
    const candidate =
      floor?.fullSnapshot !== undefined &&
      message.change_sequence <= floor.fullSnapshot.change_sequence
        ? floor.fullSnapshot
        : arrivedDuringThisRequest &&
            snapshot !== undefined &&
            message.change_sequence < snapshot.changeSequence
          ? withReactionSnapshot(message, snapshot)
          : message;
    const blockingFloor =
      floor?.tombstoned ||
      floor?.fullSnapshot !== undefined ||
      arrivedDuringThisRequest
        ? withoutReactionSnapshot(floor)
        : undefined;

    if (
      canApplyConfirmedMessage(
        confirmed.get(candidate.id),
        candidate,
        blockingFloor,
      )
    ) {
      confirmed.set(candidate.id, candidate);
      messageFloors.delete(candidate.id);
    }
  }

  // Once the pre-patch history request settles, any known-only update that it
  // did not materialize has served its purpose. Future pages start after the
  // update and are authoritative, so retaining the floor would only leak state.
  compactKnownOnlyFloors(messageFloors, activeRequestGeneration);

  return { confirmed, messageFloors };
}

function applyRealtimeFullMessage(
  existing: ChatMessage | undefined,
  incoming: ChatMessage,
  floor: MessageSequenceFloor | undefined,
): ChatMessage | null {
  const snapshot = floor?.reactionSnapshot;
  const candidate =
    floor?.fullSnapshot !== undefined &&
    incoming.change_sequence <= floor.fullSnapshot.change_sequence
      ? floor.fullSnapshot
      : snapshot !== undefined &&
          !floor?.tombstoned &&
          incoming.change_sequence < snapshot.changeSequence
        ? withReactionSnapshot(incoming, snapshot)
        : incoming;
  return canApplyConfirmedMessage(existing, candidate, withoutReactionSnapshot(floor))
    ? candidate
    : null;
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (state.status === "kicked" && action.type !== "INIT_START" && action.type !== "KICKED") {
    return state;
  }
  switch (action.type) {
    case "INIT_START":
      return {
        ...initialState(),
        historyRequestGeneration: state.historyRequestGeneration + 1,
        activeHistoryRequestGeneration: state.historyRequestGeneration + 1,
      };

    case "INIT_SUCCESS": {
      const { confirmed, messageFloors } = applyHistoryMessages(
        state,
        action.messages,
      );
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      for (const m of action.messages) {
        if (state.hidden.has(m.id)) continue;
        if (m.client_message_id) {
          pending.delete(m.client_message_id);
          failed.delete(m.client_message_id);
        }
      }
      return {
        ...state,
        status: "ready",
        errorCode: null,
        confirmed,
        messageFloors,
        pending,
        failed,
        nextOlderCursor: action.nextCursor,
        hasMoreOlder: action.nextCursor !== null,
        activeHistoryRequestGeneration: null,
      };
    }

    case "INIT_ERROR": {
      const messageFloors = new Map(state.messageFloors);
      compactKnownOnlyFloors(
        messageFloors,
        state.activeHistoryRequestGeneration,
      );
      return {
        ...state,
        status: "error",
        errorCode: action.errorCode,
        messageFloors,
        activeHistoryRequestGeneration: null,
      };
    }

    case "LOAD_OLDER_START":
      return {
        ...state,
        isLoadingOlder: true,
        historyRequestGeneration: state.historyRequestGeneration + 1,
        activeHistoryRequestGeneration: state.historyRequestGeneration + 1,
      };

    case "LOAD_OLDER_SUCCESS": {
      const { confirmed, messageFloors } = applyHistoryMessages(
        state,
        action.messages,
      );
      return {
        ...state,
        confirmed,
        messageFloors,
        nextOlderCursor: action.nextCursor,
        hasMoreOlder: action.nextCursor !== null,
        isLoadingOlder: false,
        activeHistoryRequestGeneration: null,
      };
    }

    case "LOAD_OLDER_ERROR": {
      const messageFloors = new Map(state.messageFloors);
      compactKnownOnlyFloors(
        messageFloors,
        state.activeHistoryRequestGeneration,
      );
      return {
        ...state,
        messageFloors,
        isLoadingOlder: false,
        activeHistoryRequestGeneration: null,
      };
    }

    case "UPSERT_CONFIRMED": {
      const confirmed = new Map(state.confirmed);
      const messageFloors = new Map(state.messageFloors);
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      let changed = false;
      let didReceiveAICompletion = false;
      for (const m of action.messages) {
        if (state.hidden.has(m.id)) continue;
        const candidate = applyRealtimeFullMessage(
          confirmed.get(m.id),
          m,
          messageFloors.get(m.id),
        );
        if (candidate === null) continue;
        confirmed.set(candidate.id, candidate);
        messageFloors.delete(m.id);
        changed = true;
        didReceiveAICompletion ||= isAICompletionMessage(candidate);
        if (candidate.client_message_id) {
          pending.delete(candidate.client_message_id);
          failed.delete(candidate.client_message_id);
        }
      }
      if (!changed) return state;
      return {
        ...state,
        confirmed,
        messageFloors,
        pending,
        failed,
        errorCode: null,
        ...(didReceiveAICompletion ? clearedAIInteractionState() : {}),
      };
    }

    case "PATCH_CONFIRMED": {
      const confirmed = new Map(state.confirmed);
      const messageFloors = new Map(state.messageFloors);
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      let changed = false;
      let didReceiveAICompletion = false;
      for (const m of action.messages) {
        if (state.hidden.has(m.id)) continue;
        if (!confirmed.has(m.id)) {
          const activeHistoryRequestGeneration =
            state.activeHistoryRequestGeneration;
          if (activeHistoryRequestGeneration !== null) {
            const didAdvance = advanceMessageFloor(
              messageFloors,
              m,
              activeHistoryRequestGeneration,
              m,
            );
            changed = didAdvance || changed;
          }
          continue;
        }
        if (
          !canApplyConfirmedMessage(
            confirmed.get(m.id),
            m,
            state.messageFloors.get(m.id),
          )
        ) {
          continue;
        }
        confirmed.set(m.id, m);
        messageFloors.delete(m.id);
        changed = true;
        didReceiveAICompletion ||= isAICompletionMessage(m);
        if (m.client_message_id) {
          pending.delete(m.client_message_id);
          failed.delete(m.client_message_id);
        }
      }
      if (!changed) return state;
      return {
        ...state,
        confirmed,
        messageFloors,
        pending,
        failed,
        errorCode: null,
        ...(didReceiveAICompletion ? clearedAIInteractionState() : {}),
      };
    }

    case "ADD_PENDING": {
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      const cid = action.message.client_message_id;
      if (cid) {
        pending.set(cid, action.message);
        failed.delete(cid);
      }
      return { ...state, pending, failed };
    }

    case "CONFIRM_PENDING": {
      const confirmed = new Map(state.confirmed);
      const messageFloors = new Map(state.messageFloors);
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      if (
        canApplyConfirmedMessage(
          confirmed.get(action.message.id),
          action.message,
          messageFloors.get(action.message.id),
        )
      ) {
        confirmed.set(action.message.id, action.message);
        messageFloors.delete(action.message.id);
      }
      pending.delete(action.clientMessageId);
      failed.delete(action.clientMessageId);
      return { ...state, confirmed, messageFloors, pending, failed };
    }

    case "FAIL_PENDING": {
      const failed = new Set(state.failed);
      failed.add(action.clientMessageId);
      return { ...state, failed };
    }

    case "CLEAR_FAILED": {
      const failed = new Set(state.failed);
      failed.delete(action.clientMessageId);
      return { ...state, failed };
    }

    case "LOCK_SEND_TERMINAL": {
      return {
        ...state,
        pending: new Map(),
        failed: new Set(),
        sendLockReason: "terminal",
        errorCode: "TRIP_TERMINAL",
        isSending: false,
        ...clearedAIInteractionState(),
      };
    }

    case "LOCK_SUBSCRIPTION":
      if (state.sendLockReason === "terminal") return state;
      return {
        ...state,
        sendLockReason: "subscription",
        errorCode: action.errorCode,
      };

    case "SUBSCRIPTION_READY":
      if (state.sendLockReason === "terminal") return state;
      return {
        ...state,
        sendLockReason: null,
        errorCode: null,
      };

    case "SEND_START":
      return { ...state, isSending: true };

    case "SEND_END":
      return { ...state, isSending: false };

    case "KICKED":
      return { ...initialState(), status: "kicked" };

    case "WS_ERROR":
      // Surface the latest error code without tearing the room down — the WS
      // layer keeps the socket; the room may be transiently unreachable.
      return { ...state, errorCode: action.errorCode };

    case "CLEAR_ROOM_ERROR":
      return { ...state, errorCode: null };

    case "UPDATE_REACTIONS": {
      const existing = state.confirmed.get(action.messageId);
      const existingFloor = state.messageFloors.get(action.messageId);
      if (
        !isSafeChangeSequence(action.changeSequence) ||
        (existingFloor !== undefined &&
          (existingFloor.tombstoned ||
            action.changeSequence < existingFloor.changeSequence)) ||
        existing?.is_deleted_for_everyone ||
        (existing !== undefined &&
          action.changeSequence < existing.change_sequence)
      ) {
        return state;
      }
      const messageFloors = new Map(state.messageFloors);
      if (!existing) {
        const activeHistoryRequestGeneration =
          state.activeHistoryRequestGeneration;
        if (activeHistoryRequestGeneration === null) return state;
        const previousSnapshot = existingFloor?.reactionSnapshot;
        if (
          existingFloor !== undefined &&
          (existingFloor.tombstoned ||
            action.changeSequence < existingFloor.changeSequence ||
            (action.changeSequence === existingFloor.changeSequence &&
              previousSnapshot === undefined))
        ) {
          return state;
        }
        messageFloors.set(action.messageId, {
          changeSequence: action.changeSequence,
          tombstoned: false,
          observedHistoryRequestGeneration: activeHistoryRequestGeneration,
          reactionSnapshot: {
            reactions: action.reactions,
            changeSequence: action.changeSequence,
            updatedAt: action.updatedAt,
          },
        });
        return { ...state, messageFloors };
      }
      messageFloors.delete(action.messageId);
      const confirmed = new Map(state.confirmed);
      confirmed.set(action.messageId, {
        ...existing,
        reactions: action.reactions,
        change_sequence: action.changeSequence,
        updated_at: action.updatedAt,
      });
      return { ...state, confirmed, messageFloors, errorCode: null };
    }

    case "HIDE_MESSAGES": {
      const confirmed = new Map(state.confirmed);
      const messageFloors = new Map(state.messageFloors);
      const pending = new Map(state.pending);
      const hidden = new Set(state.hidden);
      for (const messageId of action.messageIds) {
        hidden.add(messageId);
        confirmed.delete(messageId);
        messageFloors.delete(messageId);
        pending.delete(messageId);
      }
      return {
        ...state,
        confirmed,
        messageFloors,
        pending,
        hidden,
        errorCode: null,
      };
    }

    case "AI_TYPING_STARTED":
      return {
        ...state,
        activeAIInteractionId: action.interactionId,
        aiTypingRequestedByUserId: action.requestedByUserId,
      };

    case "AI_TYPING_STOPPED":
      if (state.activeAIInteractionId !== action.interactionId) return state;
      return { ...state, activeAIInteractionId: null, aiTypingRequestedByUserId: null };

    case "DROP_PENDING": {
      const pending = new Map(state.pending);
      const failed = new Set(state.failed);
      pending.delete(action.clientMessageId);
      failed.delete(action.clientMessageId);
      return { ...state, pending, failed };
    }

    default:
      return state;
  }
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isAICompletionMessage(message: ChatMessage): boolean {
  return (
    message.sender_kind === "AI" &&
    (message.ai_status === "SUCCESS" || message.ai_status === "ERROR")
  );
}

function clearedAIInteractionState() {
  return {
    activeAIInteractionId: null,
    aiTypingRequestedByUserId: null,
  };
}

function selectVisibleMessages(state: ChatState): ChatMessage[] {
  const all: ChatMessage[] = [];
  for (const m of state.confirmed.values()) {
    if (!state.hidden.has(m.id)) all.push(m);
  }
  for (const m of state.pending.values()) {
    if (state.hidden.has(m.id)) continue;
    // Hide pending whose confirmed twin has already arrived.
    const cid = m.client_message_id;
    if (cid) {
      let confirmedTwinExists = false;
      for (const c of state.confirmed.values()) {
        if (c.client_message_id === cid) {
          confirmedTwinExists = true;
          break;
        }
      }
      if (confirmedTwinExists) continue;
    }
    all.push(m);
  }
  all.sort(compareMessages);
  return all;
}

function makeOptimisticId(clientMessageId: string): string {
  return `optimistic:${clientMessageId}`;
}

function resourceMutationKey(resourceGeneration: number, messageId: string): string {
  return `${resourceGeneration}:${messageId}`;
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (RFC4122-ish) — only used in environments without WebCrypto.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function extractErrorCode(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = (error as AxiosError).response?.data;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof (data as { error_code?: unknown }).error_code === "string"
    ) {
      return (data as { error_code: string }).error_code;
    }
    const status = error.response?.status;
    if (status === 429) return "THROTTLED";
    if (status === 400) return "BAD_REQUEST";
  }
  return fallback;
}

function isRoomAccessLostError(errorCode: string): boolean {
  return ROOM_ACCESS_LOST_ERROR_CODES.has(errorCode);
}

function dispatchRecoverableOrAccessLostError(
  dispatch: React.Dispatch<ChatAction>,
  errorCode: string,
  markKicked: () => void,
  markTerminal: () => void,
): void {
  if (errorCode === "TRIP_TERMINAL") {
    markTerminal();
    return;
  }
  if (isRoomAccessLostError(errorCode)) {
    markKicked();
    return;
  }
  dispatch({ type: "WS_ERROR", errorCode });
}

function reactionProofMatchesIntent(
  proof: WsChatReactionUpdate,
  currentUserId: string,
  requestedEmoji: string,
  wasRemoving: boolean,
): boolean {
  const currentReaction = proof.reactions.find((reaction) =>
    reaction.reacted_by_ids.includes(currentUserId),
  );
  return wasRemoving
    ? currentReaction === undefined
    : currentReaction?.emoji === requestedEmoji;
}

export function useTripChat(
  rawTripId: string,
  currentUser: { id: string; display_name: string; identify_tag: string | null; avatar_url: string | null },
): UseTripChatResult {
  const tripId = canonicalizeChatTripId(rawTripId);
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);

  // Refs that need to survive rerenders without re-binding effects.
  const stateRef = useRef(state);
  stateRef.current = state;
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;
  const activeResourceTripIdRef = useRef<string | null>(null);
  const resourceGenerationRef = useRef(0);
  const accessRevokedRef = useRef(false);
  const subscriptionGenerationRef = useRef(0);
  const subscriptionAttemptRef = useRef<SubscriptionAttempt | null>(null);
  const pendingRecoveryRef = useRef<RecoveryRequest | null>(null);
  const activeRecoveryRef = useRef<ActiveRecovery | null>(null);
  const recoveryTriggerRef = useRef<() => void>(() => {});
  const activeRoomLeaveRef = useRef<(() => void) | null>(null);
  const loadOlderInFlightRef = useRef<number | null>(null);
  const activeSendRef = useRef<ActiveSend | null>(null);
  const hideInFlightRef = useRef<number | null>(null);
  const mutationLockReasonRef = useRef<SendLockReason | null>(null);
  const reactionInFlightRef = useRef<Set<string>>(new Set());
  const deleteInFlightRef = useRef<Set<string>>(new Set());
  const inFlightSendClientIdsRef = useRef<Set<string>>(new Set());
  const confirmedDuringSendRef = useRef<Map<string, number>>(new Map());
  const liveReactionProofRef = useRef<Map<string, WsChatReactionUpdate>>(new Map());
  const liveDeleteProofRef = useRef<Map<string, ChatMessage>>(new Map());

  const retireActiveRecovery = useCallback(() => {
    const active = activeRecoveryRef.current;
    if (active === null) return;
    activeRecoveryRef.current = null;
    active.controller.abort();
  }, []);

  const isActiveResource = useCallback(
    (expectedTripId: string, expectedGeneration: number): boolean =>
      !accessRevokedRef.current &&
      tripIdRef.current === expectedTripId &&
      activeResourceTripIdRef.current === expectedTripId &&
      resourceGenerationRef.current === expectedGeneration,
    [],
  );

  const markKicked = useCallback(() => {
    accessRevokedRef.current = true;
    mutationLockReasonRef.current = null;
    subscriptionGenerationRef.current += 1;
    subscriptionAttemptRef.current = null;
    pendingRecoveryRef.current = null;
    retireActiveRecovery();
    activeRoomLeaveRef.current?.();
    loadOlderInFlightRef.current = null;
    activeSendRef.current = null;
    hideInFlightRef.current = null;
    reactionInFlightRef.current.clear();
    deleteInFlightRef.current.clear();
    inFlightSendClientIdsRef.current.clear();
    confirmedDuringSendRef.current.clear();
    liveReactionProofRef.current.clear();
    liveDeleteProofRef.current.clear();
    dispatch({ type: "KICKED" });
  }, [retireActiveRecovery]);

  const markTerminal = useCallback(() => {
    mutationLockReasonRef.current = "terminal";
    activeSendRef.current = null;
    hideInFlightRef.current = null;
    reactionInFlightRef.current.clear();
    deleteInFlightRef.current.clear();
    inFlightSendClientIdsRef.current.clear();
    confirmedDuringSendRef.current.clear();
    liveReactionProofRef.current.clear();
    liveDeleteProofRef.current.clear();
    dispatch({ type: "LOCK_SEND_TERMINAL" });
  }, []);

  const markSubscriptionRejected = useCallback((errorCode: string) => {
    if (mutationLockReasonRef.current === "terminal") return;
    mutationLockReasonRef.current = "subscription";
    dispatch({ type: "LOCK_SUBSCRIPTION", errorCode });
  }, []);

  const markSubscriptionReady = useCallback(() => {
    if (mutationLockReasonRef.current === "terminal") return;
    mutationLockReasonRef.current = null;
    dispatch({ type: "SUBSCRIPTION_READY" });
  }, []);

  const queueAckedAttempt = useCallback((attempt: SubscriptionAttempt) => {
    if (!attempt.acked || attempt.floor === undefined) return;
    if (
      attempt.resourceGeneration !== resourceGenerationRef.current ||
      attempt.generation !== subscriptionGenerationRef.current ||
      attempt.tripId !== tripIdRef.current ||
      accessRevokedRef.current
    ) {
      return;
    }
    pendingRecoveryRef.current = {
      resourceGeneration: attempt.resourceGeneration,
      subscriptionGeneration: attempt.generation,
      tripId: attempt.tripId,
      floor: attempt.floor,
    };
    recoveryTriggerRef.current();
  }, []);

  const triggerPostSubscribeGapFill = useCallback(() => {
    const request = pendingRecoveryRef.current;
    if (request === null || activeRecoveryRef.current !== null) return;
    if (stateRef.current.status !== "ready") return;
    if (
      !isActiveResource(request.tripId, request.resourceGeneration) ||
      request.subscriptionGeneration !== subscriptionGenerationRef.current
    ) {
      pendingRecoveryRef.current = null;
      return;
    }

    pendingRecoveryRef.current = null;
    const active: ActiveRecovery = {
      request,
      controller: new AbortController(),
    };
    activeRecoveryRef.current = active;
    const shouldApply = () =>
      !active.controller.signal.aborted &&
      isActiveResource(request.tripId, request.resourceGeneration) &&
      request.subscriptionGeneration === subscriptionGenerationRef.current;
    void runPostSubscribeCatchUp(
      request.tripId,
      dispatch,
      request.floor,
      shouldApply,
      markKicked,
      active.controller.signal,
    ).finally(() => {
      if (activeRecoveryRef.current === active) {
        activeRecoveryRef.current = null;
      }
      recoveryTriggerRef.current();
    });
  }, [isActiveResource, markKicked]);
  recoveryTriggerRef.current = triggerPostSubscribeGapFill;

  // -------- Initial load --------
  useEffect(() => {
    let cancelled = false;
    const resourceGeneration = resourceGenerationRef.current + 1;
    resourceGenerationRef.current = resourceGeneration;
    activeResourceTripIdRef.current = tripId;
    accessRevokedRef.current = false;
    const freshState = initialState();
    stateRef.current = freshState;
    subscriptionGenerationRef.current = 0;
    subscriptionAttemptRef.current = null;
    pendingRecoveryRef.current = null;
    retireActiveRecovery();
    mutationLockReasonRef.current = null;
    loadOlderInFlightRef.current = null;
    activeSendRef.current = null;
    hideInFlightRef.current = null;
    reactionInFlightRef.current.clear();
    deleteInFlightRef.current.clear();
    inFlightSendClientIdsRef.current.clear();
    confirmedDuringSendRef.current.clear();
    liveReactionProofRef.current.clear();
    liveDeleteProofRef.current.clear();
    dispatch({ type: "INIT_START" });

    const deactivateResource = () => {
      cancelled = true;
      if (resourceGenerationRef.current !== resourceGeneration) return;
      activeResourceTripIdRef.current = null;
      accessRevokedRef.current = true;
      subscriptionGenerationRef.current += 1;
      subscriptionAttemptRef.current = null;
      pendingRecoveryRef.current = null;
      retireActiveRecovery();
      mutationLockReasonRef.current = null;
      loadOlderInFlightRef.current = null;
      activeSendRef.current = null;
      hideInFlightRef.current = null;
      reactionInFlightRef.current.clear();
      deleteInFlightRef.current.clear();
      inFlightSendClientIdsRef.current.clear();
      confirmedDuringSendRef.current.clear();
      liveReactionProofRef.current.clear();
      liveDeleteProofRef.current.clear();
    };

    if (tripId === null) {
      dispatch({ type: "INIT_ERROR", errorCode: "INVALID_TRIP_ID" });
      return deactivateResource;
    }

    bffListChatHistory(tripId, { limit: HISTORY_PAGE_SIZE })
      .then((res) => {
        if (cancelled || !isActiveResource(tripId, resourceGeneration)) return;
        const attempt = subscriptionAttemptRef.current;
        if (
          attempt !== null &&
          attempt.resourceGeneration === resourceGeneration &&
          attempt.floor === undefined
        ) {
          const completedAttempt = {
            ...attempt,
            floor: recoveryFloorFromMessages(res.results),
          };
          subscriptionAttemptRef.current = completedAttempt;
          queueAckedAttempt(completedAttempt);
        }
        // Backend returns descending; reducer just stores by id. UI sorts asc.
        dispatch({
          type: "INIT_SUCCESS",
          messages: res.results,
          nextCursor: res.next_cursor,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || !isActiveResource(tripId, resourceGeneration)) return;
        dispatch({
          type: "INIT_ERROR",
          errorCode: extractErrorCode(error, "INIT_FAILED"),
        });
      });

    return deactivateResource;
  }, [isActiveResource, queueAckedAttempt, retireActiveRecovery, tripId]);

  useEffect(() => {
    triggerPostSubscribeGapFill();
  }, [state.status, triggerPostSubscribeGapFill]);

  // -------- WebSocket room subscription --------
  useEffect(() => {
    if (tripId === null) return;
    const resourceGeneration = resourceGenerationRef.current;
    const handle = joinChatRoom(tripId, {
      onSubscribeAttempt: () => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        pendingRecoveryRef.current = null;
        retireActiveRecovery();
        const generation = subscriptionGenerationRef.current + 1;
        subscriptionGenerationRef.current = generation;
        subscriptionAttemptRef.current = {
          resourceGeneration,
          generation,
          tripId,
          floor:
            stateRef.current.status === "ready"
              ? recoveryFloorFromState(stateRef.current)
              : undefined,
          acked: false,
        };
      },
      onMessage: (event: WsChatMessagePush) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        const clientMessageId = event.message.client_message_id;
        if (
          clientMessageId &&
          inFlightSendClientIdsRef.current.has(clientMessageId) &&
          canApplyConfirmedMessage(
            stateRef.current.confirmed.get(event.message.id),
            event.message,
            stateRef.current.messageFloors.get(event.message.id),
          )
        ) {
          const previousSequence = confirmedDuringSendRef.current.get(clientMessageId);
          if (
            previousSequence === undefined ||
            event.message.change_sequence > previousSequence
          ) {
            confirmedDuringSendRef.current.set(
              clientMessageId,
              event.message.change_sequence,
            );
          }
        }
        dispatch({ type: "UPSERT_CONFIRMED", messages: [event.message] });
      },
      onMessageDeleted: (event: WsChatMessageDeleted) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        const operationKey = resourceMutationKey(
          resourceGeneration,
          event.message.id,
        );
        if (
          deleteInFlightRef.current.has(operationKey) &&
          canApplyConfirmedMessage(
            stateRef.current.confirmed.get(event.message.id),
            event.message,
            stateRef.current.messageFloors.get(event.message.id),
          )
        ) {
          liveDeleteProofRef.current.set(operationKey, event.message);
        }
        dispatch({ type: "PATCH_CONFIRMED", messages: [event.message] });
      },
      onKicked: () => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        markKicked();
      },
      onSubscribed: () => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        const attempt = subscriptionAttemptRef.current;
        if (
          attempt === null ||
          attempt.resourceGeneration !== resourceGeneration ||
          attempt.generation !== subscriptionGenerationRef.current
        ) {
          return;
        }
        const ackedAttempt = { ...attempt, acked: true };
        subscriptionAttemptRef.current = ackedAttempt;
        markSubscriptionReady();
        queueAckedAttempt(ackedAttempt);
      },
      onUnsubscribed: () => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        pendingRecoveryRef.current = null;
        retireActiveRecovery();
        const attempt = subscriptionAttemptRef.current;
        if (attempt !== null) {
          subscriptionAttemptRef.current = { ...attempt, acked: false };
        }
        markSubscriptionRejected("CHAT_UNSUBSCRIBED");
      },
      onError: (event: WsChatError) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        if (event.error_code === "TRIP_TERMINAL") {
          markTerminal();
          return;
        }
        if (isRoomAccessLostError(event.error_code)) {
          markKicked();
          return;
        }
        const attempt = subscriptionAttemptRef.current;
        if (attempt?.acked !== true) {
          markSubscriptionRejected(event.error_code);
          return;
        }
        dispatchRecoverableOrAccessLostError(
          dispatch,
          event.error_code,
          markKicked,
          markTerminal,
        );
      },
      onReactionUpdate: (event: WsChatReactionUpdate) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        const operationKey = resourceMutationKey(
          resourceGeneration,
          event.message_id,
        );
        const currentMessage = stateRef.current.confirmed.get(event.message_id);
        const currentFloor = stateRef.current.messageFloors.get(event.message_id);
        if (
          reactionInFlightRef.current.has(operationKey) &&
          currentMessage !== undefined &&
          !currentMessage.is_deleted_for_everyone &&
          !currentFloor?.tombstoned &&
          event.change_sequence >= currentMessage.change_sequence &&
          (currentFloor === undefined ||
            event.change_sequence >= currentFloor.changeSequence)
        ) {
          const previousProof = liveReactionProofRef.current.get(operationKey);
          if (
            previousProof === undefined ||
            event.change_sequence > previousProof.change_sequence
          ) {
            liveReactionProofRef.current.set(operationKey, event);
          }
        }
        dispatch({
          type: "UPDATE_REACTIONS",
          messageId: event.message_id,
          reactions: event.reactions,
          changeSequence: event.change_sequence,
          updatedAt: event.updated_at,
        });
      },
      onAITypingStarted: (event: WsChatAITypingStarted) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        dispatch({
          type: "AI_TYPING_STARTED",
          interactionId: event.interaction_id,
          requestedByUserId: event.requested_by_user_id,
        });
      },
      onAITypingStopped: (event: WsChatAITypingStopped) => {
        if (!isActiveResource(tripId, resourceGeneration)) return;
        dispatch({
          type: "AI_TYPING_STOPPED",
          interactionId: event.interaction_id,
        });
      },
    });
    activeRoomLeaveRef.current = handle.leave;

    return () => {
      if (activeRoomLeaveRef.current === handle.leave) {
        activeRoomLeaveRef.current = null;
      }
      handle.leave();
    };
  }, [
    isActiveResource,
    markKicked,
    markSubscriptionReady,
    markSubscriptionRejected,
    markTerminal,
    queueAckedAttempt,
    retireActiveRecovery,
    tripId,
  ]);

  // -------- Public actions --------
  const loadOlder = useCallback(async () => {
    if (tripId === null) return;
    const resourceGeneration = resourceGenerationRef.current;
    if (
      !isActiveResource(tripId, resourceGeneration) ||
      stateRef.current.status !== "ready"
    ) {
      return;
    }
    if (loadOlderInFlightRef.current === resourceGeneration) return;
    const current = stateRef.current;
    if (
      !current.hasMoreOlder ||
      current.isLoadingOlder ||
      !current.nextOlderCursor
    ) {
      return;
    }
    loadOlderInFlightRef.current = resourceGeneration;
    dispatch({ type: "LOAD_OLDER_START" });
    try {
      const res = await bffListChatHistory(tripId, {
        cursor: current.nextOlderCursor,
        limit: HISTORY_PAGE_SIZE,
      });
      if (!isActiveResource(tripId, resourceGeneration)) return;
      dispatch({
        type: "LOAD_OLDER_SUCCESS",
        messages: res.results,
        nextCursor: res.next_cursor,
      });
    } catch (error) {
      if (!isActiveResource(tripId, resourceGeneration)) return;
      const errorCode = extractErrorCode(error, "LOAD_OLDER_FAILED");
      if (isRoomAccessLostError(errorCode)) {
        markKicked();
      } else {
        dispatch({ type: "LOAD_OLDER_ERROR" });
      }
    } finally {
      if (loadOlderInFlightRef.current === resourceGeneration) {
        loadOlderInFlightRef.current = null;
      }
    }
  }, [isActiveResource, markKicked, tripId]);

  const performSend = useCallback(
    async (
      content: string,
      clientMessageId: string,
      isRetry: boolean,
    ): Promise<SendOutcome> => {
      if (tripId === null) return "failed";
      const resourceGeneration = resourceGenerationRef.current;
      if (
        !isActiveResource(tripId, resourceGeneration) ||
        stateRef.current.status !== "ready" ||
        mutationLockReasonRef.current !== null
      ) {
        return "blocked";
      }
      if (activeSendRef.current !== null) return "blocked";

      const activeSend: ActiveSend = { resourceGeneration, clientMessageId };
      activeSendRef.current = activeSend;

      inFlightSendClientIdsRef.current.add(clientMessageId);
      confirmedDuringSendRef.current.delete(clientMessageId);

      if (!isRetry) {
        const now = new Date().toISOString();
        const optimistic: ChatMessage = {
          id: makeOptimisticId(clientMessageId),
          trip_id: tripId,
          sender: {
            id: currentUser.id,
            display_name: currentUser.display_name,
            identify_tag: currentUser.identify_tag,
            avatar_url: currentUser.avatar_url,
          },
          sender_kind: "USER",
          ai_status: null,
          content,
          client_message_id: clientMessageId,
          created_at: now,
          updated_at: now,
          change_sequence: 0,
          is_deleted_for_everyone: false,
          deleted_for_everyone_at: null,
          deleted_for_everyone_by_id: null,
          delete_for_everyone_until: null,
          can_delete_for_everyone: false,
          reactions: [],
          action_drafts: [],
        };
        dispatch({ type: "ADD_PENDING", message: optimistic });
      } else {
        dispatch({ type: "CLEAR_FAILED", clientMessageId });
      }

      dispatch({ type: "SEND_START" });
      try {
        const result = await bffSendChatMessage(tripId, {
          content,
          client_message_id: clientMessageId,
        });
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return "failed";
        }
        dispatch({
          type: "CONFIRM_PENDING",
          clientMessageId,
          message: result.message,
        });
        return result.status === 200 ? "duplicate" : "ok";
      } catch (error) {
        if (!isActiveResource(tripId, resourceGeneration)) return "failed";
        if (mutationLockReasonRef.current === "terminal") return "failed";
        if (confirmedDuringSendRef.current.has(clientMessageId)) {
          dispatch({ type: "CLEAR_FAILED", clientMessageId });
          return "ok";
        }
        const errorCode = extractErrorCode(error, "SEND_FAILED");
        if (errorCode === "TRIP_TERMINAL") {
          markTerminal();
          return "failed";
        }
        if (
          errorCode === "AI_BUSY" ||
          errorCode === "INVALID_AI_PROMPT" ||
          errorCode === "THROTTLED"
        ) {
          dispatch({
            type: isRetry ? "FAIL_PENDING" : "DROP_PENDING",
            clientMessageId,
          });
          dispatch({ type: "WS_ERROR", errorCode });
          return isRetry ? "failed" : "blocked";
        }
        dispatch({ type: "FAIL_PENDING", clientMessageId });
        // Surface a coarse error code on the room, or close it if access is gone.
        dispatchRecoverableOrAccessLostError(
          dispatch,
          errorCode,
          markKicked,
          markTerminal,
        );
        return "failed";
      } finally {
        if (activeSendRef.current === activeSend) {
          activeSendRef.current = null;
        }
        inFlightSendClientIdsRef.current.delete(clientMessageId);
        confirmedDuringSendRef.current.delete(clientMessageId);
        if (
          isActiveResource(tripId, resourceGeneration) &&
          mutationLockReasonRef.current !== "terminal"
        ) {
          dispatch({ type: "SEND_END" });
        }
      }
    },
    [
      tripId,
      currentUser.id,
      currentUser.display_name,
      currentUser.identify_tag,
      currentUser.avatar_url,
      isActiveResource,
      markKicked,
      markTerminal,
    ],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (trimmed.length === 0) return "failed" as const;
      return performSend(trimmed, generateUuid(), false);
    },
    [performSend],
  );

  const retryPending = useCallback(
    async (clientMessageId: string) => {
      const optimistic = stateRef.current.pending.get(clientMessageId);
      if (!optimistic) return "failed" as const;
      return performSend(optimistic.content, clientMessageId, true);
    },
    [performSend],
  );

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (tripId === null) return;
      const resourceGeneration = resourceGenerationRef.current;
      if (
        !isActiveResource(tripId, resourceGeneration) ||
        stateRef.current.status !== "ready" ||
        mutationLockReasonRef.current !== null
      ) {
        return;
      }
      const operationKey = resourceMutationKey(resourceGeneration, messageId);
      if (reactionInFlightRef.current.has(operationKey)) return;
      const message = stateRef.current.confirmed.get(messageId);
      if (!message || message.is_deleted_for_everyone) return;
      reactionInFlightRef.current.add(operationKey);
      liveReactionProofRef.current.delete(operationKey);

      // Each user has at most one reaction per message. Find their current one.
      // If they clicked the same emoji → toggle it off. Otherwise → add/replace.
      const currentReaction = message.reactions.find((r) =>
        r.reacted_by_ids.includes(currentUser.id),
      );
      const isSameEmoji = currentReaction?.emoji === emoji;

      try {
        const result = isSameEmoji
          ? await bffRemoveReaction(tripId, messageId, emoji)
          : await bffAddReaction(tripId, messageId, emoji);
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        dispatch({
          type: "UPDATE_REACTIONS",
          messageId,
          reactions: result.reactions,
          changeSequence: result.change_sequence,
          updatedAt: result.updated_at,
        });
      } catch (error) {
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        const proof = liveReactionProofRef.current.get(operationKey);
        if (
          proof !== undefined &&
          proof.change_sequence > message.change_sequence &&
          reactionProofMatchesIntent(
            proof,
            currentUser.id,
            emoji,
            isSameEmoji,
          )
        ) {
          dispatch({ type: "CLEAR_ROOM_ERROR" });
          return;
        }
        const errorCode = extractErrorCode(error, "REACTION_FAILED");
        dispatchRecoverableOrAccessLostError(
          dispatch,
          errorCode,
          markKicked,
          markTerminal,
        );
      } finally {
        reactionInFlightRef.current.delete(operationKey);
        liveReactionProofRef.current.delete(operationKey);
      }
    },
    [tripId, currentUser.id, isActiveResource, markKicked, markTerminal],
  );

  const deleteMessage = useCallback(
    async (messageId: string, mode: DeleteChatMessageMode) => {
      if (tripId === null) return;
      const resourceGeneration = resourceGenerationRef.current;
      if (
        !isActiveResource(tripId, resourceGeneration) ||
        stateRef.current.status !== "ready" ||
        mutationLockReasonRef.current !== null
      ) {
        return;
      }
      const operationKey = resourceMutationKey(resourceGeneration, messageId);
      if (deleteInFlightRef.current.has(operationKey)) return;
      const startingSequence =
        stateRef.current.confirmed.get(messageId)?.change_sequence ?? -1;
      deleteInFlightRef.current.add(operationKey);
      liveDeleteProofRef.current.delete(operationKey);
      try {
        const result = await bffDeleteChatMessage(tripId, messageId, mode);
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        if (result.mode === "for_me") {
          dispatch({ type: "HIDE_MESSAGES", messageIds: result.hidden_message_ids });
          return;
        }
        dispatch({ type: "UPSERT_CONFIRMED", messages: [result.message] });
      } catch (error) {
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        const proof = liveDeleteProofRef.current.get(operationKey);
        if (
          mode === "for_everyone" &&
          proof?.is_deleted_for_everyone &&
          proof.change_sequence > startingSequence
        ) {
          dispatch({ type: "CLEAR_ROOM_ERROR" });
          return;
        }
        const errorCode = extractErrorCode(error, "DELETE_FAILED");
        dispatchRecoverableOrAccessLostError(
          dispatch,
          errorCode,
          markKicked,
          markTerminal,
        );
      } finally {
        deleteInFlightRef.current.delete(operationKey);
        liveDeleteProofRef.current.delete(operationKey);
      }
    },
    [tripId, isActiveResource, markKicked, markTerminal],
  );

  const hideMessagesForMe = useCallback(
    async (messageIds: string[]) => {
      if (tripId === null) return;
      if (messageIds.length === 0) return;
      const resourceGeneration = resourceGenerationRef.current;
      if (
        !isActiveResource(tripId, resourceGeneration) ||
        stateRef.current.status !== "ready" ||
        mutationLockReasonRef.current !== null
      ) {
        return;
      }
      if (hideInFlightRef.current === resourceGeneration) return;
      hideInFlightRef.current = resourceGeneration;
      try {
        const result = await bffHideChatMessagesForMe(tripId, messageIds);
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        dispatch({ type: "HIDE_MESSAGES", messageIds: result.hidden_message_ids });
      } catch (error) {
        if (
          !isActiveResource(tripId, resourceGeneration) ||
          mutationLockReasonRef.current === "terminal"
        ) {
          return;
        }
        const errorCode = extractErrorCode(error, "DELETE_FAILED");
        dispatchRecoverableOrAccessLostError(
          dispatch,
          errorCode,
          markKicked,
          markTerminal,
        );
      } finally {
        if (hideInFlightRef.current === resourceGeneration) {
          hideInFlightRef.current = null;
        }
      }
    },
    [tripId, isActiveResource, markKicked, markTerminal],
  );

  const isRenderedResourceActive = activeResourceTripIdRef.current === tripId;
  return {
    status: isRenderedResourceActive ? state.status : "loading",
    errorCode: isRenderedResourceActive ? state.errorCode : null,
    messages: isRenderedResourceActive ? selectVisibleMessages(state) : [],
    pendingClientIds: isRenderedResourceActive
      ? new Set(state.pending.keys())
      : new Set<string>(),
    failedClientIds: isRenderedResourceActive
      ? new Set(state.failed)
      : new Set<string>(),
    sendLockReason: isRenderedResourceActive ? state.sendLockReason : null,
    hasMoreOlder: isRenderedResourceActive ? state.hasMoreOlder : false,
    isLoadingOlder: isRenderedResourceActive ? state.isLoadingOlder : false,
    isSending: isRenderedResourceActive ? state.isSending : false,
    isAITyping:
      isRenderedResourceActive && state.activeAIInteractionId !== null,
    loadOlder,
    sendMessage,
    retryPending,
    toggleReaction,
    deleteMessage,
    hideMessagesForMe,
  };
}

// -------- Internal helpers --------

function latestChangedCursorFromMessages(
  messages: Iterable<ChatMessage>,
): ChangedSyncCursor | null {
  let latest: ChangedSyncCursor | null = null;
  for (const message of messages) {
    if (!isSafeChangeSequence(message.change_sequence)) continue;
    if (
      latest === null ||
      message.change_sequence > latest.changeSequence ||
      (message.change_sequence === latest.changeSequence && message.id > latest.id)
    ) {
      latest = { changeSequence: message.change_sequence, id: message.id };
    }
  }
  return latest;
}

function recoveryFloorFromMessages(messages: Iterable<ChatMessage>): RecoveryFloor {
  const materialized = [...messages];
  let latestMessage: ChatMessage | null = null;
  for (const message of materialized) {
    if (latestMessage === null || compareMessages(message, latestMessage) > 0) {
      latestMessage = message;
    }
  }
  return {
    gapSinceId: latestMessage?.id ?? null,
    changedCursor: latestChangedCursorFromMessages(materialized),
  };
}

function recoveryFloorFromState(state: ChatState): RecoveryFloor {
  const floor = recoveryFloorFromMessages(state.confirmed.values());
  let changedCursor = floor.changedCursor;
  for (const [id, sequenceFloor] of state.messageFloors) {
    if (
      changedCursor === null ||
      sequenceFloor.changeSequence > changedCursor.changeSequence ||
      (sequenceFloor.changeSequence === changedCursor.changeSequence &&
        id > changedCursor.id)
    ) {
      changedCursor = { changeSequence: sequenceFloor.changeSequence, id };
    }
  }
  return { ...floor, changedCursor };
}

type RecoveryRequestResult<T> =
  | { status: "ok"; value: T }
  | { status: "stale" }
  | { status: "error"; error: unknown };

async function retryRecoveryRequest<T>(
  request: () => Promise<T>,
  shouldApply: () => boolean,
): Promise<RecoveryRequestResult<T>> {
  for (let attempt = 0; attempt < RECOVERY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    if (!shouldApply()) return { status: "stale" };
    try {
      const value = await request();
      return shouldApply() ? { status: "ok", value } : { status: "stale" };
    } catch (error) {
      if (!shouldApply()) return { status: "stale" };
      const errorCode = extractErrorCode(error, "RECOVERY_FAILED");
      if (
        isRoomAccessLostError(errorCode) ||
        attempt + 1 >= RECOVERY_REQUEST_MAX_ATTEMPTS
      ) {
        return { status: "error", error };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RECOVERY_RETRY_DELAY_MS);
      });
    }
  }
  return { status: "stale" };
}

function surfaceRecoveryError(
  error: unknown,
  fallback: string,
  shouldApply: () => boolean,
  dispatch: React.Dispatch<ChatAction>,
  markKicked: () => void,
): void {
  if (!shouldApply()) return;
  const errorCode = extractErrorCode(error, fallback);
  if (isRoomAccessLostError(errorCode)) {
    markKicked();
    return;
  }
  dispatch({ type: "WS_ERROR", errorCode });
}

async function runPostSubscribeCatchUp(
  tripId: string,
  dispatch: React.Dispatch<ChatAction>,
  floor: RecoveryFloor,
  shouldApply: () => boolean,
  markKicked: () => void,
  signal: AbortSignal,
): Promise<void> {
  const gapResult = await runGapFill(
    tripId,
    floor.gapSinceId,
    dispatch,
    shouldApply,
    markKicked,
    signal,
  );
  if (!gapResult.completed || !shouldApply()) return;
  const syncCursor = floor.changedCursor ?? gapResult.fallbackCursor;
  if (syncCursor !== null) {
    await runChangedSync(
      tripId,
      syncCursor.changeSequence,
      syncCursor.id,
      dispatch,
      shouldApply,
      markKicked,
      signal,
    );
  }
}

async function runGapFill(
  tripId: string,
  initialSinceId: string | null,
  dispatch: React.Dispatch<ChatAction>,
  shouldApply: () => boolean,
  markKicked: () => void,
  signal: AbortSignal,
): Promise<{ completed: boolean; fallbackCursor: ChangedSyncCursor | null }> {
  if (initialSinceId === null) {
    const requestResult = await retryRecoveryRequest(
      () => bffListChatHistory(tripId, { limit: HISTORY_PAGE_SIZE }, signal),
      shouldApply,
    );
    if (requestResult.status === "error") {
      surfaceRecoveryError(
        requestResult.error,
        "GAP_FILL_FAILED",
        shouldApply,
        dispatch,
        markKicked,
      );
      return { completed: false, fallbackCursor: null };
    }
    if (requestResult.status === "stale") {
      return { completed: false, fallbackCursor: null };
    }
    dispatch({
      type: "INIT_SUCCESS",
      messages: requestResult.value.results,
      nextCursor: requestResult.value.next_cursor,
    });
    return {
      completed: true,
      fallbackCursor: latestChangedCursorFromMessages(requestResult.value.results),
    };
  }

  let since = initialSinceId;
  for (let page = 0; page < GAP_FILL_MAX_PAGES; page += 1) {
    const requestResult = await retryRecoveryRequest(
      () =>
        bffGapFillChatMessages(tripId, {
          since,
          limit: GAP_FILL_PAGE_SIZE,
        }, signal),
      shouldApply,
    );
    if (requestResult.status === "error") {
      surfaceRecoveryError(
        requestResult.error,
        "GAP_FILL_FAILED",
        shouldApply,
        dispatch,
        markKicked,
      );
      return { completed: false, fallbackCursor: null };
    }
    if (requestResult.status === "stale") {
      return { completed: false, fallbackCursor: null };
    }
    const res = requestResult.value;
    if (res.results.length === 0) {
      if (res.has_more) {
        dispatch({ type: "WS_ERROR", errorCode: "GAP_FILL_INCOMPLETE" });
        return { completed: false, fallbackCursor: null };
      }
      return { completed: true, fallbackCursor: null };
    }
    dispatch({ type: "UPSERT_CONFIRMED", messages: res.results });
    if (!res.has_more) return { completed: true, fallbackCursor: null };
    since = res.results[res.results.length - 1].id;
  }
  if (shouldApply()) {
    dispatch({ type: "WS_ERROR", errorCode: "GAP_FILL_INCOMPLETE" });
  }
  return { completed: false, fallbackCursor: null };
}

async function runChangedSync(
  tripId: string,
  changedSince: number,
  initialChangedSinceId: string | undefined,
  dispatch: React.Dispatch<ChatAction>,
  shouldApply: () => boolean,
  markKicked: () => void,
  signal: AbortSignal,
): Promise<void> {
  let changedSinceCursor = changedSince;
  let changedSinceId = initialChangedSinceId;
  for (let page = 0; page < GAP_FILL_MAX_PAGES; page += 1) {
    const options = {
      changed_since: changedSinceCursor,
      limit: GAP_FILL_PAGE_SIZE,
      ...(changedSinceId ? { changed_since_id: changedSinceId } : {}),
    };
    const requestResult = await retryRecoveryRequest(
      () => bffSyncChangedChatMessages(tripId, options, signal),
      shouldApply,
    );
    if (requestResult.status === "error") {
      surfaceRecoveryError(
        requestResult.error,
        "CHANGE_SYNC_FAILED",
        shouldApply,
        dispatch,
        markKicked,
      );
      return;
    }
    if (requestResult.status === "stale") return;
    const res = requestResult.value;
    if (res.results.length === 0) {
      if (res.has_more) {
        dispatch({ type: "WS_ERROR", errorCode: "CHANGE_SYNC_INCOMPLETE" });
      }
      return;
    }
    dispatch({ type: "PATCH_CONFIRMED", messages: res.results });
    if (!res.has_more) return;
    const last = res.results[res.results.length - 1];
    changedSinceCursor = last.change_sequence;
    changedSinceId = last.id;
  }
  if (shouldApply()) {
    dispatch({ type: "WS_ERROR", errorCode: "CHANGE_SYNC_INCOMPLETE" });
  }
}
