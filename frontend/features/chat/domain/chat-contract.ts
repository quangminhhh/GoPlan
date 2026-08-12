import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";

import type {
  ChatChangeSyncResponse,
  ChatGapFillResponse,
  ChatHistoryResponse,
  ChatMessage,
  DeleteChatMessageResult,
  DeleteChatMessageMode,
  HideChatMessagesResult,
  ReactionMutationResult,
  ReactionSummary,
} from "@/features/chat/domain/types";
import {
  ALLOWED_REACTION_EMOJIS,
  type AllowedEmoji,
} from "@/features/chat/domain/types";

type UnknownRecord = Record<string, unknown>;

export class ChatContractError extends Error {
  readonly code = "INVALID_CHAT_CONTRACT";

  constructor() {
    super("Invalid chat contract from server.");
    this.name = "ChatContractError";
  }
}

function fail(): never {
  throw new ChatContractError();
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): UnknownRecord {
  return isUnknownRecord(value) ? value : fail();
}

function requireString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail();
  return value;
}

function requireNullableString(value: unknown): string | null {
  return value === null ? null : requireString(value, true);
}

function requireNullableNonEmptyString(value: unknown): string | null {
  return value === null ? null : requireString(value);
}

function requireBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}

function requireSafeSequence(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail();
}

function requireUniqueNonEmptyStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0) ||
    new Set(value).size !== value.length
  ) {
    fail();
  }
  return value;
}

const ALLOWED_REACTION_EMOJI_SET = new Set<string>(ALLOWED_REACTION_EMOJIS);
const REACTION_EMOJI_ORDER = new Map<string, number>(
  ALLOWED_REACTION_EMOJIS.map((emoji, index) => [emoji, index]),
);

function requireAllowedReactionEmoji(value: unknown): AllowedEmoji {
  if (typeof value !== "string" || !ALLOWED_REACTION_EMOJI_SET.has(value)) {
    fail();
  }
  return value as AllowedEmoji;
}

export function parseReactionSummaries(value: unknown): ReactionSummary[] {
  if (!Array.isArray(value)) fail();
  const seenEmojis = new Set<AllowedEmoji>();
  const parsed = value.map((item) => {
    const record = requireRecord(item);
    const emoji = requireAllowedReactionEmoji(record.emoji);
    const count = record.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      fail();
    }
    const reactedByIds = requireUniqueNonEmptyStringArray(record.reacted_by_ids);
    if (seenEmojis.has(emoji) || count !== reactedByIds.length) fail();
    seenEmojis.add(emoji);
    return {
      emoji,
      count,
      reacted_by_ids: reactedByIds,
    };
  });
  return parsed.sort(
    (left, right) =>
      (REACTION_EMOJI_ORDER.get(left.emoji) ?? Number.MAX_SAFE_INTEGER) -
      (REACTION_EMOJI_ORDER.get(right.emoji) ?? Number.MAX_SAFE_INTEGER),
  );
}

function parseOpaqueActionDrafts(value: unknown): ChatMessage["action_drafts"] {
  if (!Array.isArray(value) || !value.every(isUnknownRecord)) fail();
  // Issue #67 owns the draft schema. Chat validates only the array/object
  // envelope and preserves every opaque/nested field exactly as received.
  return value as ChatMessage["action_drafts"];
}

export function parseChatMessage(
  value: unknown,
  expectedTripId?: string,
): ChatMessage {
  const record = requireRecord(value);
  const tripId = canonicalizeChatTripId(record.trip_id);
  if (tripId === null) fail();
  if (expectedTripId !== undefined) {
    const expected = canonicalizeChatTripId(expectedTripId);
    if (expected === null || tripId !== expected) fail();
  }

  const sender = requireRecord(record.sender);
  const senderKind = record.sender_kind;
  if (senderKind !== "USER" && senderKind !== "AI") fail();
  const aiStatus = record.ai_status;
  if (aiStatus !== null && aiStatus !== "SUCCESS" && aiStatus !== "ERROR") fail();

  return {
    id: requireString(record.id),
    trip_id: tripId,
    sender: {
      id: requireNullableNonEmptyString(sender.id),
      display_name: requireString(sender.display_name, true),
      identify_tag: requireNullableString(sender.identify_tag),
      avatar_url: requireNullableString(sender.avatar_url),
    },
    sender_kind: senderKind,
    ai_status: aiStatus,
    content: requireString(record.content, true),
    client_message_id: requireNullableNonEmptyString(record.client_message_id),
    created_at: requireString(record.created_at),
    updated_at: requireString(record.updated_at),
    change_sequence: requireSafeSequence(record.change_sequence),
    is_deleted_for_everyone: requireBoolean(record.is_deleted_for_everyone),
    deleted_for_everyone_at: requireNullableString(record.deleted_for_everyone_at),
    deleted_for_everyone_by_id: requireNullableNonEmptyString(
      record.deleted_for_everyone_by_id,
    ),
    delete_for_everyone_until: requireNullableString(
      record.delete_for_everyone_until,
    ),
    can_delete_for_everyone: requireBoolean(record.can_delete_for_everyone),
    reactions: parseReactionSummaries(record.reactions),
    action_drafts: parseOpaqueActionDrafts(record.action_drafts),
  };
}

function parseMessageArray(value: unknown, expectedTripId: string): ChatMessage[] {
  if (!Array.isArray(value)) fail();
  return value.map((message) => parseChatMessage(message, expectedTripId));
}

export function parseChatHistoryResponse(
  value: unknown,
  expectedTripId: string,
): ChatHistoryResponse {
  const record = requireRecord(value);
  return {
    results: parseMessageArray(record.results, expectedTripId),
    next_cursor: requireNullableString(record.next_cursor),
  };
}

export function parseChatGapFillResponse(
  value: unknown,
  expectedTripId: string,
): ChatGapFillResponse {
  const record = requireRecord(value);
  return {
    results: parseMessageArray(record.results, expectedTripId),
    has_more: requireBoolean(record.has_more),
  };
}

export function parseChatChangeSyncResponse(
  value: unknown,
  expectedTripId: string,
): ChatChangeSyncResponse {
  return parseChatGapFillResponse(value, expectedTripId);
}

export function parseChatSendResponse(
  value: unknown,
  expectedTripId: string,
): { message: ChatMessage } {
  const record = requireRecord(value);
  return { message: parseChatMessage(record.message, expectedTripId) };
}

export function parseHideChatMessagesResult(value: unknown): HideChatMessagesResult {
  const record = requireRecord(value);
  return {
    hidden_message_ids: requireUniqueNonEmptyStringArray(record.hidden_message_ids),
  };
}

export function parseDeleteChatMessageResult(
  value: unknown,
  expectedTripId: string,
  mode: DeleteChatMessageMode,
): DeleteChatMessageResult {
  const record = requireRecord(value);
  const hasMessage = Object.prototype.hasOwnProperty.call(record, "message");
  const hasHiddenIds = Object.prototype.hasOwnProperty.call(
    record,
    "hidden_message_ids",
  );
  if (mode === "for_everyone") {
    if (!hasMessage || hasHiddenIds) fail();
    const message = parseChatMessage(record.message, expectedTripId);
    if (!message.is_deleted_for_everyone) fail();
    return { mode: "for_everyone", message };
  }
  if (hasMessage || !hasHiddenIds) fail();
  return { mode: "for_me", ...parseHideChatMessagesResult(record) };
}

export function parseReactionMutationResult(value: unknown): ReactionMutationResult {
  const record = requireRecord(value);
  return {
    reactions: parseReactionSummaries(record.reactions),
    change_sequence: requireSafeSequence(record.change_sequence),
    updated_at: requireString(record.updated_at),
  };
}
