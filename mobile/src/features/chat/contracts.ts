import {
  ALLOWED_REACTION_EMOJIS,
  type AllowedReactionEmoji,
  type ChatGapFillResponse,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatChangeSyncResponse,
  type ChatReactionMutationResult,
  type OpaqueChatActionDraft,
  type ReactionSummary,
} from './types';

export class ChatContractError extends Error {
  constructor() {
    super('The chat server returned an invalid response.');
    this.name = 'ChatContractError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns one canonical room identity, or null for a malformed route/wire id. */
export function canonicalizeChatTripId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

export function isChatChangeSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isAllowedReactionEmoji(value: unknown): value is AllowedReactionEmoji {
  return (
    typeof value === 'string' &&
    ALLOWED_REACTION_EMOJIS.some((candidate) => candidate === value)
  );
}

export function parseStringIds(
  value: unknown,
  requireUnique: boolean = false,
): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    return null;
  }
  if (requireUnique && new Set(value).size !== value.length) {
    return null;
  }
  return [...value];
}

function parseActionDrafts(
  value: unknown,
): readonly OpaqueChatActionDraft[] | null {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    return null;
  }
  // Copy only the envelope. Nested values intentionally remain opaque so #66
  // cannot strip fields later interpreted by #67.
  return value.map((draft) => ({ ...draft }));
}

export function parseChatReactionSummaries(
  value: unknown,
): readonly ReactionSummary[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed: ReactionSummary[] = [];
  const seenEmojis = new Set<AllowedReactionEmoji>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isAllowedReactionEmoji(candidate.emoji) ||
      seenEmojis.has(candidate.emoji) ||
      typeof candidate.count !== 'number' ||
      !Number.isInteger(candidate.count) ||
      candidate.count < 0
    ) {
      return null;
    }
    const reactedByIds = parseStringIds(candidate.reacted_by_ids, true);
    if (reactedByIds === null || candidate.count !== reactedByIds.length) {
      return null;
    }
    seenEmojis.add(candidate.emoji);
    parsed.push({
      emoji: candidate.emoji,
      count: candidate.count,
      reacted_by_ids: reactedByIds,
    });
  }
  return parsed;
}

export function parseChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value) || !isRecord(value.sender)) {
    return null;
  }

  const sender = value.sender;
  const tripId = canonicalizeChatTripId(value.trip_id);
  const reactions = parseChatReactionSummaries(value.reactions);
  const actionDrafts = parseActionDrafts(value.action_drafts);
  if (
    !isNonEmptyString(value.id) ||
    tripId === null ||
    !isNullableNonEmptyString(sender.id) ||
    typeof sender.display_name !== 'string' ||
    !isNullableString(sender.identify_tag) ||
    !isNullableString(sender.avatar_url) ||
    (value.sender_kind !== 'USER' && value.sender_kind !== 'AI') ||
    (value.ai_status !== null &&
      value.ai_status !== 'SUCCESS' &&
      value.ai_status !== 'ERROR') ||
    typeof value.content !== 'string' ||
    !isNullableNonEmptyString(value.client_message_id) ||
    !isNonEmptyString(value.created_at) ||
    !isNonEmptyString(value.updated_at) ||
    !isChatChangeSequence(value.change_sequence) ||
    typeof value.is_deleted_for_everyone !== 'boolean' ||
    !isNullableString(value.deleted_for_everyone_at) ||
    !isNullableNonEmptyString(value.deleted_for_everyone_by_id) ||
    !isNullableString(value.delete_for_everyone_until) ||
    typeof value.can_delete_for_everyone !== 'boolean' ||
    reactions === null ||
    actionDrafts === null
  ) {
    return null;
  }

  return {
    id: value.id,
    trip_id: tripId,
    sender: {
      id: sender.id,
      display_name: sender.display_name,
      identify_tag: sender.identify_tag,
      avatar_url: sender.avatar_url,
    },
    sender_kind: value.sender_kind,
    ai_status: value.ai_status,
    content: value.content,
    client_message_id: value.client_message_id,
    created_at: value.created_at,
    updated_at: value.updated_at,
    change_sequence: value.change_sequence,
    is_deleted_for_everyone: value.is_deleted_for_everyone,
    deleted_for_everyone_at: value.deleted_for_everyone_at,
    deleted_for_everyone_by_id: value.deleted_for_everyone_by_id,
    delete_for_everyone_until: value.delete_for_everyone_until,
    can_delete_for_everyone: value.can_delete_for_everyone,
    reactions,
    action_drafts: actionDrafts,
  };
}

export function requireChatMessage(value: unknown): ChatMessage {
  const message = parseChatMessage(value);
  if (message === null) {
    throw new ChatContractError();
  }
  return message;
}

function requireChatMessages(value: unknown): readonly ChatMessage[] {
  if (!Array.isArray(value)) {
    throw new ChatContractError();
  }
  return value.map(requireChatMessage);
}

export function parseChatHistoryResponse(value: unknown): ChatHistoryResponse {
  if (!isRecord(value) || !isNullableString(value.next_cursor)) {
    throw new ChatContractError();
  }
  return {
    results: requireChatMessages(value.results),
    next_cursor: value.next_cursor,
  };
}

export function parseChatReconciliationResponse(
  value: unknown,
): ChatGapFillResponse | ChatChangeSyncResponse {
  if (!isRecord(value) || typeof value.has_more !== 'boolean') {
    throw new ChatContractError();
  }
  return {
    results: requireChatMessages(value.results),
    has_more: value.has_more,
  };
}

export function parseHiddenMessageIds(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    throw new ChatContractError();
  }
  const messageIds = parseStringIds(value.hidden_message_ids, true);
  if (messageIds === null) {
    throw new ChatContractError();
  }
  return messageIds;
}

export function parseReactionResponse(value: unknown): ChatReactionMutationResult {
  if (!isRecord(value)) {
    throw new ChatContractError();
  }
  const reactions = parseChatReactionSummaries(value.reactions);
  if (
    reactions === null ||
    !isChatChangeSequence(value.change_sequence) ||
    !isNonEmptyString(value.updated_at)
  ) {
    throw new ChatContractError();
  }
  return {
    reactions,
    change_sequence: value.change_sequence,
    updated_at: value.updated_at,
  };
}
