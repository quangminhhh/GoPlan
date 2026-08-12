import {
  isUnknownRecord,
  parseChatMessage,
  parseReactionSummaries,
} from "@/features/chat/domain/chat-contract";
import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";
import { CHAT_WS_MESSAGE_TYPES } from "@/features/realtime/domain/types";

import type { WsChatServerMessage } from "@/features/chat/domain/types";

function stringValue(value: unknown, allowEmpty = false): string | null {
  return typeof value === "string" && (allowEmpty || value.length > 0)
    ? value
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function safeSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function parseChatWsEvent(
  expectedType: string,
  value: unknown,
): WsChatServerMessage | null {
  if (!isUnknownRecord(value) || value.type !== expectedType) return null;
  const tripId = canonicalizeChatTripId(value.trip_id);
  if (tripId === null) return null;

  try {
    switch (expectedType) {
      case CHAT_WS_MESSAGE_TYPES.MESSAGE: {
        const message = parseChatMessage(value.message, tripId);
        return { type: CHAT_WS_MESSAGE_TYPES.MESSAGE, trip_id: tripId, message };
      }
      case CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED: {
        const message = parseChatMessage(value.message, tripId);
        if (!message.is_deleted_for_everyone) return null;
        return {
          type: CHAT_WS_MESSAGE_TYPES.MESSAGE_DELETED,
          trip_id: tripId,
          message,
        };
      }
      case CHAT_WS_MESSAGE_TYPES.KICKED:
        return { type: CHAT_WS_MESSAGE_TYPES.KICKED, trip_id: tripId };
      case CHAT_WS_MESSAGE_TYPES.ERROR: {
        const errorCode = stringValue(value.error_code);
        const detail = stringValue(value.detail, true);
        if (errorCode === null || detail === null) return null;
        return {
          type: CHAT_WS_MESSAGE_TYPES.ERROR,
          trip_id: tripId,
          error_code: errorCode,
          detail,
        };
      }
      case CHAT_WS_MESSAGE_TYPES.SUBSCRIBED:
        return { type: CHAT_WS_MESSAGE_TYPES.SUBSCRIBED, trip_id: tripId };
      case CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED:
        return { type: CHAT_WS_MESSAGE_TYPES.UNSUBSCRIBED, trip_id: tripId };
      case CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE: {
        const messageId = stringValue(value.message_id);
        const changeSequence = safeSequence(value.change_sequence);
        const updatedAt = stringValue(value.updated_at);
        if (messageId === null || changeSequence === null || updatedAt === null) {
          return null;
        }
        return {
          type: CHAT_WS_MESSAGE_TYPES.REACTION_UPDATE,
          trip_id: tripId,
          message_id: messageId,
          reactions: parseReactionSummaries(value.reactions),
          change_sequence: changeSequence,
          updated_at: updatedAt,
        };
      }
      case CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED: {
        const interactionId = stringValue(value.interaction_id);
        const requestedByUserId = nullableString(value.requested_by_user_id);
        if (interactionId === null || requestedByUserId === undefined) return null;
        return {
          type: CHAT_WS_MESSAGE_TYPES.AI_TYPING_STARTED,
          trip_id: tripId,
          interaction_id: interactionId,
          requested_by_user_id: requestedByUserId,
        };
      }
      case CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED: {
        const interactionId = stringValue(value.interaction_id);
        if (interactionId === null) return null;
        return {
          type: CHAT_WS_MESSAGE_TYPES.AI_TYPING_STOPPED,
          trip_id: tripId,
          interaction_id: interactionId,
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
