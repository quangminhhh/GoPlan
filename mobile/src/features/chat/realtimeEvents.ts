import {
  canonicalizeChatTripId,
  isChatChangeSequence,
  parseChatMessage,
  parseChatReactionSummaries,
} from './contracts';
import type { ChatMessage, ReactionSummary } from './types';

export interface ChatSubscribedRealtimeEvent {
  readonly type: 'chat.subscribed';
  readonly trip_id: string;
}

export interface ChatUnsubscribedRealtimeEvent {
  readonly type: 'chat.unsubscribed';
  readonly trip_id: string;
}

export interface ChatMessageRealtimeEvent {
  readonly type: 'chat.message';
  readonly trip_id: string;
  readonly message: ChatMessage;
}

export interface ChatMessageDeletedRealtimeEvent {
  readonly type: 'chat.message_deleted';
  readonly trip_id: string;
  readonly message: ChatMessage;
}

export interface ChatReactionUpdateRealtimeEvent {
  readonly type: 'chat.reaction_update';
  readonly trip_id: string;
  readonly message_id: string;
  readonly reactions: readonly ReactionSummary[];
  readonly change_sequence: number;
  readonly updated_at: string;
}

export interface ChatKickedRealtimeEvent {
  readonly type: 'chat.kicked';
  readonly trip_id: string;
}

export interface ChatErrorRealtimeEvent {
  readonly type: 'chat.error';
  readonly trip_id: string;
  /** Open server string; unknown future codes remain recoverable. */
  readonly error_code: string;
  readonly detail: string;
}

export interface ChatAITypingStartedRealtimeEvent {
  readonly type: 'chat.ai_typing_started';
  readonly trip_id: string;
  readonly interaction_id: string;
  readonly requested_by_user_id: string | null;
}

export interface ChatAITypingStoppedRealtimeEvent {
  readonly type: 'chat.ai_typing_stopped';
  readonly trip_id: string;
  readonly interaction_id: string;
}

export type ChatRealtimeEvent =
  | ChatSubscribedRealtimeEvent
  | ChatUnsubscribedRealtimeEvent
  | ChatMessageRealtimeEvent
  | ChatMessageDeletedRealtimeEvent
  | ChatReactionUpdateRealtimeEvent
  | ChatKickedRealtimeEvent
  | ChatErrorRealtimeEvent
  | ChatAITypingStartedRealtimeEvent
  | ChatAITypingStoppedRealtimeEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseTripScopedEvent(
  value: Record<string, unknown>,
): { readonly trip_id: string } | null {
  const tripId = canonicalizeChatTripId(value.trip_id);
  return tripId === null ? null : { trip_id: tripId };
}

export function parseChatRealtimeEvent(value: unknown): ChatRealtimeEvent | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    return null;
  }

  const tripScope = parseTripScopedEvent(value);
  if (tripScope === null) {
    return null;
  }

  switch (value.type) {
    case 'chat.subscribed':
      return { type: value.type, ...tripScope };
    case 'chat.unsubscribed':
      return { type: value.type, ...tripScope };
    case 'chat.kicked':
      return { type: value.type, ...tripScope };
    case 'chat.message':
    case 'chat.message_deleted': {
      const message = parseChatMessage(value.message);
      if (message === null || message.trip_id !== tripScope.trip_id) {
        return null;
      }
      return { type: value.type, ...tripScope, message };
    }
    case 'chat.reaction_update': {
      const reactions = parseChatReactionSummaries(value.reactions);
      if (
        !isNonEmptyString(value.message_id) ||
        reactions === null ||
        !isChatChangeSequence(value.change_sequence) ||
        !isNonEmptyString(value.updated_at)
      ) {
        return null;
      }
      return {
        type: value.type,
        ...tripScope,
        message_id: value.message_id,
        reactions,
        change_sequence: value.change_sequence,
        updated_at: value.updated_at,
      };
    }
    case 'chat.error':
      if (
        !isNonEmptyString(value.error_code) ||
        typeof value.detail !== 'string'
      ) {
        return null;
      }
      return {
        type: value.type,
        ...tripScope,
        error_code: value.error_code,
        detail: value.detail,
      };
    case 'chat.ai_typing_started':
      if (
        !isNonEmptyString(value.interaction_id) ||
        (value.requested_by_user_id !== null &&
          !isNonEmptyString(value.requested_by_user_id))
      ) {
        return null;
      }
      return {
        type: value.type,
        ...tripScope,
        interaction_id: value.interaction_id,
        requested_by_user_id: value.requested_by_user_id,
      };
    case 'chat.ai_typing_stopped':
      if (!isNonEmptyString(value.interaction_id)) {
        return null;
      }
      return {
        type: value.type,
        ...tripScope,
        interaction_id: value.interaction_id,
      };
    default:
      return null;
  }
}
