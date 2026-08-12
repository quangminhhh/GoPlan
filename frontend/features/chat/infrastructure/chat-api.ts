import { bff } from "@/shared/http/bff-client";
import {
  ChatContractError,
  parseChatChangeSyncResponse,
  parseChatGapFillResponse,
  parseChatHistoryResponse,
  parseChatSendResponse,
  parseDeleteChatMessageResult,
  parseHideChatMessagesResult,
  parseReactionMutationResult,
} from "@/features/chat/domain/chat-contract";

import type {
  ChatGapFillResponse,
  ChatHistoryResponse,
  ChatChangeSyncResponse,
  DeleteChatMessageResult,
  DeleteChatMessageMode,
  HideChatMessagesResult,
  ReactionMutationResult,
  SendChatMessageInput,
  SendChatMessageResult,
} from "@/features/chat/domain/types";
import { requireCanonicalChatTripId } from "@/features/chat/domain/trip-id";

const HISTORY_DEFAULT_LIMIT = 30;
const GAP_FILL_DEFAULT_LIMIT = 100;

function chatBasePath(tripId: string): string {
  return `/api/trips/${encodeURIComponent(requireCanonicalChatTripId(tripId))}/chat/messages`;
}

function reactionBasePath(tripId: string, messageId: string): string {
  return `${chatBasePath(tripId)}/${encodeURIComponent(messageId)}/reactions`;
}

/**
 * `POST /api/trips/<trip_id>/chat/messages` — see issue #14 REST contract.
 * Resolves to {message, status} so the caller can distinguish between a
 * freshly-created row (201) and an idempotent retry hit (200).
 */
export async function bffSendChatMessage(
  tripId: string,
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  const canonicalTripId = requireCanonicalChatTripId(tripId);
  const res = await bff.post<unknown>(
    chatBasePath(canonicalTripId),
    input,
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new ChatContractError();
  }
  const status = res.status;
  const parsed = parseChatSendResponse(res.data, canonicalTripId);
  return { message: parsed.message, status };
}

export type ListChatHistoryOptions = {
  cursor?: string;
  limit?: number;
};

/**
 * `GET .../messages?cursor=&limit=` — descending history page.
 * Mutually exclusive with `bffGapFillChatMessages` (issue #14 contract).
 */
export async function bffListChatHistory(
  tripId: string,
  options: ListChatHistoryOptions = {},
  signal?: AbortSignal,
): Promise<ChatHistoryResponse> {
  const canonicalTripId = requireCanonicalChatTripId(tripId);
  const params: Record<string, string | number> = {
    limit: options.limit ?? HISTORY_DEFAULT_LIMIT,
  };
  if (options.cursor) params.cursor = options.cursor;

  const res = await bff.get<unknown>(chatBasePath(canonicalTripId), {
    params,
    ...(signal ? { signal } : {}),
  });
  return parseChatHistoryResponse(res.data, canonicalTripId);
}

export type GapFillChatOptions = {
  since: string;
  limit?: number;
};

/**
 * `GET .../messages?since=&limit=` — ascending gap-fill page.
 * The hook keeps calling this with the latest received message id until
 * `has_more === false`.
 */
export async function bffGapFillChatMessages(
  tripId: string,
  options: GapFillChatOptions,
  signal?: AbortSignal,
): Promise<ChatGapFillResponse> {
  const canonicalTripId = requireCanonicalChatTripId(tripId);
  const res = await bff.get<unknown>(chatBasePath(canonicalTripId), {
    params: {
      since: options.since,
      limit: options.limit ?? GAP_FILL_DEFAULT_LIMIT,
    },
    ...(signal ? { signal } : {}),
  });
  return parseChatGapFillResponse(res.data, canonicalTripId);
}

export type SyncChangedChatOptions = {
  changed_since: number;
  changed_since_id?: string;
  limit?: number;
};

/**
 * `GET .../messages?changed_since=&limit=` — ascending mutation catch-up page.
 * This covers updates to already-known messages, such as reactions and delete
 * tombstones, which `since=<message_id>` cannot see.
 */
export async function bffSyncChangedChatMessages(
  tripId: string,
  options: SyncChangedChatOptions,
  signal?: AbortSignal,
): Promise<ChatChangeSyncResponse> {
  const canonicalTripId = requireCanonicalChatTripId(tripId);
  const params: Record<string, string | number> = {
    changed_since: options.changed_since,
    limit: options.limit ?? GAP_FILL_DEFAULT_LIMIT,
  };
  if (options.changed_since_id) params.changed_since_id = options.changed_since_id;

  const res = await bff.get<unknown>(chatBasePath(canonicalTripId), {
    params,
    ...(signal ? { signal } : {}),
  });
  return parseChatChangeSyncResponse(res.data, canonicalTripId);
}

export async function bffAddReaction(
  tripId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionMutationResult> {
  const res = await bff.post<unknown>(
    reactionBasePath(tripId, messageId),
    { emoji },
  );
  return parseReactionMutationResult(res.data);
}

export async function bffRemoveReaction(
  tripId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionMutationResult> {
  const res = await bff.delete<unknown>(
    `${reactionBasePath(tripId, messageId)}/${encodeURIComponent(emoji)}`,
  );
  return parseReactionMutationResult(res.data);
}

export async function bffDeleteChatMessage(
  tripId: string,
  messageId: string,
  mode: DeleteChatMessageMode,
): Promise<DeleteChatMessageResult> {
  const canonicalTripId = requireCanonicalChatTripId(tripId);
  const res = await bff.delete<unknown>(
    `${chatBasePath(canonicalTripId)}/${encodeURIComponent(messageId)}`,
    { data: { mode } },
  );
  return parseDeleteChatMessageResult(res.data, canonicalTripId, mode);
}

export async function bffHideChatMessagesForMe(
  tripId: string,
  messageIds: string[],
): Promise<HideChatMessagesResult> {
  const res = await bff.post<unknown>(
    `${chatBasePath(tripId)}/hide`,
    { message_ids: messageIds },
  );
  return parseHideChatMessagesResult(res.data);
}
