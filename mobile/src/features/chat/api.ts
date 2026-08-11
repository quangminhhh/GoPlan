import { isAxiosError } from 'axios';
import { apiClient } from '@/shared/api/client';
import { normalizeApiError } from '@/shared/api/errors';
import {
  ChatContractError,
  canonicalizeChatTripId,
  canonicalizeChatUuid,
  isChatChangeSequence,
  isRecord,
  parseChatHistoryResponse,
  parseChatReconciliationResponse,
  parseHiddenMessageIds,
  parseReactionResponse,
  requireChatMessageForTrip,
} from './contracts';
import {
  type AllowedReactionEmoji,
  type ChatApiFailure,
  type ChatGapFillResponse,
  type ChatHistoryResponse,
  type ChatChangeSyncResponse,
  type ChatReactionMutationResult,
  type DeleteChatMessageMode,
  type DeleteChatMessageResult,
  type GapFillChatMessagesOptions,
  type HideChatMessagesResult,
  type ListChatHistoryOptions,
  type SendChatMessageInput,
  type SendChatMessageResult,
  type SyncChangedChatMessagesOptions,
} from './types';

const HISTORY_DEFAULT_LIMIT = 30;
const HISTORY_MAX_LIMIT = 100;
const RECONCILIATION_DEFAULT_LIMIT = 100;
const RECONCILIATION_MAX_LIMIT = 200;
const BULK_HIDE_MAX_MESSAGES = 100;

function assertLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new RangeError(`${label} cannot be empty.`);
  }
}

function requireCanonicalUuid(value: unknown, label: string): string {
  const canonical = canonicalizeChatUuid(value);
  if (canonical === null) {
    throw new RangeError(`${label} must be a valid UUID.`);
  }
  return canonical;
}

function canonicalResponseIds(ids: readonly string[]): readonly string[] {
  const canonicalIds = ids.map(canonicalizeChatUuid);
  if (canonicalIds.some((id) => id === null)) {
    throw new ChatContractError();
  }
  return canonicalIds as readonly string[];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function chatMessagesPath(tripId: string): string {
  const canonicalTripId = canonicalizeChatTripId(tripId);
  if (canonicalTripId === null) {
    throw new RangeError('Trip id must be a valid UUID.');
  }
  return `/trips/${encodeURIComponent(canonicalTripId)}/chat/messages`;
}

function chatMessagePath(tripId: string, messageId: string): string {
  const canonicalMessageId = requireCanonicalUuid(messageId, 'Message id');
  return `${chatMessagesPath(tripId)}/${encodeURIComponent(canonicalMessageId)}`;
}

function reactionPath(tripId: string, messageId: string): string {
  return `${chatMessagePath(tripId, messageId)}/reactions`;
}

export async function listChatHistory(
  tripId: string,
  options: ListChatHistoryOptions = {},
  signal?: AbortSignal,
): Promise<ChatHistoryResponse> {
  const limit = options.limit ?? HISTORY_DEFAULT_LIMIT;
  assertLimit(limit, HISTORY_MAX_LIMIT, 'History limit');
  const params: Record<string, string | number> = { limit };
  if (options.cursor !== undefined) {
    assertNonEmpty(options.cursor, 'History cursor');
    params.cursor = options.cursor;
  }
  const response = await apiClient.get<unknown>(chatMessagesPath(tripId), {
    params,
    signal,
  });
  return parseChatHistoryResponse(response.data, tripId);
}

export async function gapFillChatMessages(
  tripId: string,
  options: GapFillChatMessagesOptions,
  signal?: AbortSignal,
): Promise<ChatGapFillResponse> {
  const limit = options.limit ?? RECONCILIATION_DEFAULT_LIMIT;
  assertLimit(limit, RECONCILIATION_MAX_LIMIT, 'Gap-fill limit');
  const canonicalSince = requireCanonicalUuid(
    options.since,
    'Gap-fill anchor',
  );
  const response = await apiClient.get<unknown>(chatMessagesPath(tripId), {
    params: { since: canonicalSince, limit },
    signal,
  });
  return parseChatReconciliationResponse(response.data, tripId);
}

export async function syncChangedChatMessages(
  tripId: string,
  options: SyncChangedChatMessagesOptions,
  signal?: AbortSignal,
): Promise<ChatChangeSyncResponse> {
  const limit = options.limit ?? RECONCILIATION_DEFAULT_LIMIT;
  assertLimit(limit, RECONCILIATION_MAX_LIMIT, 'Change-sync limit');
  if (!isChatChangeSequence(options.changedSince)) {
    throw new RangeError(
      'Change-sync cursor must be a nonnegative safe integer.',
    );
  }
  const params: Record<string, string | number> = {
    changed_since: options.changedSince,
    limit,
  };
  if (options.changedSinceId !== undefined) {
    params.changed_since_id = requireCanonicalUuid(
      options.changedSinceId,
      'Change-sync id',
    );
  }
  const response = await apiClient.get<unknown>(chatMessagesPath(tripId), {
    params,
    signal,
  });
  return parseChatReconciliationResponse(response.data, tripId);
}

export async function sendChatMessage(
  tripId: string,
  input: SendChatMessageInput,
  signal?: AbortSignal,
): Promise<SendChatMessageResult> {
  const canonicalClientMessageId = requireCanonicalUuid(
    input.clientMessageId,
    'Client message id',
  );
  const response = await apiClient.post<unknown>(
    chatMessagesPath(tripId),
    {
      content: input.content,
      client_message_id: canonicalClientMessageId,
    },
    { signal },
  );
  if (!isRecord(response.data) || (response.status !== 200 && response.status !== 201)) {
    throw new ChatContractError();
  }
  const message = requireChatMessageForTrip(response.data.message, tripId);
  const responseClientMessageId = canonicalizeChatUuid(
    message.client_message_id,
  );
  if (responseClientMessageId !== canonicalClientMessageId) {
    throw new ChatContractError();
  }
  return {
    message: {
      ...message,
      client_message_id: responseClientMessageId,
    },
    disposition: response.status === 201 ? 'created' : 'replayed',
  };
}

export async function deleteChatMessage(
  tripId: string,
  messageId: string,
  mode: DeleteChatMessageMode,
  signal?: AbortSignal,
): Promise<DeleteChatMessageResult> {
  const canonicalMessageId = requireCanonicalUuid(messageId, 'Message id');
  const response = await apiClient.delete<unknown>(
    chatMessagePath(tripId, messageId),
    { data: { mode }, signal },
  );
  if (mode === 'for_me') {
    if (
      !isRecord(response.data) ||
      !hasOwn(response.data, 'hidden_message_ids') ||
      hasOwn(response.data, 'message')
    ) {
      throw new ChatContractError();
    }
    const hiddenMessageIds = canonicalResponseIds(
      parseHiddenMessageIds(response.data),
    );
    if (
      hiddenMessageIds.length !== 1 ||
      hiddenMessageIds[0] !== canonicalMessageId
    ) {
      throw new ChatContractError();
    }
    return {
      mode,
      hidden_message_ids: hiddenMessageIds,
    };
  }
  if (
    !isRecord(response.data) ||
    !hasOwn(response.data, 'message') ||
    hasOwn(response.data, 'hidden_message_ids')
  ) {
    throw new ChatContractError();
  }
  const message = requireChatMessageForTrip(response.data.message, tripId);
  const responseMessageId = canonicalizeChatUuid(message.id);
  if (
    responseMessageId !== canonicalMessageId ||
    !message.is_deleted_for_everyone
  ) {
    throw new ChatContractError();
  }
  return {
    mode,
    message: { ...message, id: responseMessageId },
  };
}

export async function hideChatMessages(
  tripId: string,
  messageIds: readonly string[],
  signal?: AbortSignal,
): Promise<HideChatMessagesResult> {
  if (messageIds.length < 1 || messageIds.length > BULK_HIDE_MAX_MESSAGES) {
    throw new RangeError(
      `Bulk hide requires 1 to ${BULK_HIDE_MAX_MESSAGES} message ids.`,
    );
  }
  const canonicalMessageIds = messageIds.map((messageId) =>
    canonicalizeChatUuid(messageId),
  );
  if (
    canonicalMessageIds.some((messageId) => messageId === null) ||
    new Set(canonicalMessageIds).size !== canonicalMessageIds.length
  ) {
    throw new RangeError('Bulk hide message ids must be unique UUIDs.');
  }
  const response = await apiClient.post<unknown>(
    `${chatMessagesPath(tripId)}/hide`,
    { message_ids: canonicalMessageIds },
    { signal },
  );
  const hiddenMessageIds = canonicalResponseIds(
    parseHiddenMessageIds(response.data),
  );
  const requestedSet = new Set(canonicalMessageIds);
  if (
    hiddenMessageIds.length !== canonicalMessageIds.length ||
    new Set(hiddenMessageIds).size !== hiddenMessageIds.length ||
    hiddenMessageIds.some((messageId) => !requestedSet.has(messageId))
  ) {
    throw new ChatContractError();
  }
  return { hidden_message_ids: hiddenMessageIds };
}

export async function addChatReaction(
  tripId: string,
  messageId: string,
  emoji: AllowedReactionEmoji,
  signal?: AbortSignal,
): Promise<ChatReactionMutationResult> {
  const response = await apiClient.post<unknown>(
    reactionPath(tripId, messageId),
    { emoji },
    { signal },
  );
  return parseReactionResponse(response.data);
}

export async function removeChatReaction(
  tripId: string,
  messageId: string,
  emoji: AllowedReactionEmoji,
  signal?: AbortSignal,
): Promise<ChatReactionMutationResult> {
  const response = await apiClient.delete<unknown>(
    `${reactionPath(tripId, messageId)}/${encodeURIComponent(emoji)}`,
    { signal },
  );
  return parseReactionResponse(response.data);
}

function parseRetryAfterMs(value: unknown, nowMs: number = Date.now()): number | null {
  const normalized = typeof value === 'string' ? value.trim() : String(value);
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1_000 : null;
  }

  const retryAtMs = Date.parse(normalized);
  return Number.isFinite(retryAtMs) && retryAtMs > nowMs
    ? retryAtMs - nowMs
    : null;
}

export function normalizeChatApiError(error: unknown): ChatApiFailure {
  const base = normalizeApiError(error);
  if (!isAxiosError(error)) {
    return {
      kind: base.kind,
      message: base.message,
      errorCode: base.errorCode ?? null,
      status: base.status ?? null,
      retryAfterMs: null,
      fieldErrors: base.fieldErrors ?? null,
    };
  }

  const status = error.response?.status ?? base.status ?? null;
  const body = isRecord(error.response?.data) ? error.response.data : null;
  const detail = body && typeof body.detail === 'string' ? body.detail : null;
  const errorCode =
    body && typeof body.error_code === 'string'
      ? body.error_code
      : (base.errorCode ?? null);
  const retryAfterMs =
    status === 429
      ? parseRetryAfterMs(error.response?.headers?.['retry-after'])
      : null;

  return {
    kind: status === 429 ? 'throttled' : base.kind,
    message: detail ?? base.message,
    errorCode,
    status,
    retryAfterMs,
    fieldErrors: base.fieldErrors ?? null,
  };
}
