import type { AIActionDraft } from "@/features/chat/domain/ai-action-drafts";

export const ALLOWED_REACTION_EMOJIS = [
  "❤️",
  "😂",
  "😮",
  "😢",
  "😡",
  "👍",
  "👎",
] as const;

export type AllowedEmoji = (typeof ALLOWED_REACTION_EMOJIS)[number];

export type ReactionSummary = {
  emoji: AllowedEmoji;
  count: number;
  /** User IDs who reacted with this emoji — used to derive reacted_by_me client-side. */
  reacted_by_ids: string[];
};

export type ChatSender = {
  id: string | null;
  display_name: string;
  identify_tag: string | null;
  avatar_url: string | null;
};

export type ChatMessage = {
  id: string;
  trip_id: string;
  sender: ChatSender;
  sender_kind: "USER" | "AI";
  ai_status: "SUCCESS" | "ERROR" | null;
  content: string;
  client_message_id: string | null;
  created_at: string;
  updated_at: string;
  /** Monotonic server-authored mutation order for this trip chat. */
  change_sequence: number;
  is_deleted_for_everyone: boolean;
  deleted_for_everyone_at: string | null;
  deleted_for_everyone_by_id: string | null;
  delete_for_everyone_until: string | null;
  can_delete_for_everyone: boolean;
  reactions: ReactionSummary[];
  action_drafts: AIActionDraft[];
};

export type ChatHistoryResponse = {
  results: ChatMessage[];
  next_cursor: string | null;
};

export type ChatGapFillResponse = {
  results: ChatMessage[];
  has_more: boolean;
};

export type ChatChangeSyncResponse = {
  results: ChatMessage[];
  has_more: boolean;
};

export type SendChatMessageInput = {
  content: string;
  client_message_id: string;
};

export type SendChatMessageResult = {
  message: ChatMessage;
  /** 201 when newly created, 200 when an idempotent retry returned the existing row. */
  status: 200 | 201;
};

export type DeleteChatMessageMode = "for_me" | "for_everyone";

export type HideChatMessagesResult = {
  hidden_message_ids: string[];
};

export type DeleteChatMessageResult =
  | {
      mode: "for_me";
      hidden_message_ids: string[];
    }
  | {
      mode: "for_everyone";
      message: ChatMessage;
    };

export type ReactionMutationResult = {
  reactions: ReactionSummary[];
  change_sequence: number;
  updated_at: string;
};

// -------- WebSocket payloads (browser wire format, dotted namespace) --------

export type WsChatSubscribe = {
  type: "chat.subscribe";
  trip_id: string;
};

export type WsChatUnsubscribe = {
  type: "chat.unsubscribe";
  trip_id: string;
};

export type WsChatSubscribed = {
  type: "chat.subscribed";
  trip_id: string;
};

export type WsChatUnsubscribed = {
  type: "chat.unsubscribed";
  trip_id: string;
};

export type WsChatMessagePush = {
  type: "chat.message";
  trip_id: string;
  message: ChatMessage;
};

export type WsChatMessageDeleted = {
  type: "chat.message_deleted";
  trip_id: string;
  message: ChatMessage;
};

export type WsChatKicked = {
  type: "chat.kicked";
  trip_id: string;
};

export type WsChatErrorCode =
  | "TRIP_NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_PAYLOAD"
  | "SERVER_ERROR";

export type WsChatError = {
  type: "chat.error";
  trip_id: string;
  error_code: WsChatErrorCode | string;
  detail: string;
};

export type WsChatReactionUpdate = {
  type: "chat.reaction_update";
  trip_id: string;
  message_id: string;
  reactions: ReactionSummary[];
  change_sequence: number;
  updated_at: string;
};

export type WsChatAITypingStarted = {
  type: "chat.ai_typing_started";
  trip_id: string;
  interaction_id: string;
  requested_by_user_id: string | null;
};

export type WsChatAITypingStopped = {
  type: "chat.ai_typing_stopped";
  trip_id: string;
  interaction_id: string;
};

export type WsChatClientMessage = WsChatSubscribe | WsChatUnsubscribe;

export type WsChatServerMessage =
  | WsChatSubscribed
  | WsChatUnsubscribed
  | WsChatMessagePush
  | WsChatMessageDeleted
  | WsChatKicked
  | WsChatError
  | WsChatReactionUpdate
  | WsChatAITypingStarted
  | WsChatAITypingStopped;
