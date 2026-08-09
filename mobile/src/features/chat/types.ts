import type { ApiError } from '@/shared/api/errors';

export const ALLOWED_REACTION_EMOJIS = [
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
  '👍',
  '👎',
] as const;

export type AllowedReactionEmoji = (typeof ALLOWED_REACTION_EMOJIS)[number];

/**
 * Issue #66 must retain AI action drafts without interpreting #67's evolving
 * contract. Unknown top-level and nested values therefore stay opaque.
 */
export type OpaqueChatActionDraft = Readonly<Record<string, unknown>>;

export interface ReactionSummary {
  readonly emoji: AllowedReactionEmoji;
  readonly count: number;
  readonly reacted_by_ids: readonly string[];
}

export interface ChatSender {
  readonly id: string | null;
  readonly display_name: string;
  readonly identify_tag: string | null;
  readonly avatar_url: string | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly trip_id: string;
  readonly sender: ChatSender;
  readonly sender_kind: 'USER' | 'AI';
  readonly ai_status: 'SUCCESS' | 'ERROR' | null;
  readonly content: string;
  readonly client_message_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** Server-authored per-trip mutation order; timestamps are presentation only. */
  readonly change_sequence: number;
  readonly is_deleted_for_everyone: boolean;
  readonly deleted_for_everyone_at: string | null;
  readonly deleted_for_everyone_by_id: string | null;
  readonly delete_for_everyone_until: string | null;
  readonly can_delete_for_everyone: boolean;
  readonly reactions: readonly ReactionSummary[];
  readonly action_drafts: readonly OpaqueChatActionDraft[];
}

/** Results are newest-first; `next_cursor` is opaque. */
export interface ChatHistoryResponse {
  readonly results: readonly ChatMessage[];
  readonly next_cursor: string | null;
}

/** Results are oldest-first after the `since` anchor. */
export interface ChatGapFillResponse {
  readonly results: readonly ChatMessage[];
  readonly has_more: boolean;
}

/** Results are ordered by `(change_sequence, id)` ascending. */
export interface ChatChangeSyncResponse {
  readonly results: readonly ChatMessage[];
  readonly has_more: boolean;
}

export interface ChatReactionMutationResult {
  readonly reactions: readonly ReactionSummary[];
  readonly change_sequence: number;
  readonly updated_at: string;
}

export interface SendChatMessageInput {
  readonly content: string;
  readonly clientMessageId: string;
}

export interface SendChatMessageResult {
  readonly message: ChatMessage;
  readonly disposition: 'created' | 'replayed';
}

export type DeleteChatMessageMode = 'for_me' | 'for_everyone';

export type DeleteChatMessageResult =
  | {
      readonly mode: 'for_me';
      readonly hidden_message_ids: readonly string[];
    }
  | {
      readonly mode: 'for_everyone';
      readonly message: ChatMessage;
    };

export interface HideChatMessagesResult {
  readonly hidden_message_ids: readonly string[];
}

export interface ListChatHistoryOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface GapFillChatMessagesOptions {
  readonly since: string;
  readonly limit?: number;
}

export interface SyncChangedChatMessagesOptions {
  readonly changedSince: number;
  readonly changedSinceId?: string;
  readonly limit?: number;
}

/**
 * Chat retains the shared error categories while making every field explicit
 * for reducer code. `retryAfterMs` is populated from the HTTP Retry-After
 * header and does not imply that a retry should be queued automatically.
 */
export interface ChatApiFailure {
  readonly kind: ApiError['kind'];
  readonly message: string;
  readonly errorCode: string | null;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
}

export interface ChatSubscribeCommand {
  readonly type: 'chat.subscribe';
  readonly trip_id: string;
}

export interface ChatUnsubscribeCommand {
  readonly type: 'chat.unsubscribe';
  readonly trip_id: string;
}

export type ChatClientCommand = ChatSubscribeCommand | ChatUnsubscribeCommand;
