import { isAxiosError } from 'axios';
import { apiClient } from '@/shared/api/client';
import { normalizeApiError } from '@/shared/api/errors';
import {
  ChatContractError,
  canonicalizeChatTripId,
  isChatChangeSequence,
  isRecord,
  parseChatHistoryResponse,
  parseChatReconciliationResponse,
  parseHiddenMessageIds,
  parseReactionResponse,
  requireChatMessage,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

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

function chatMessagesPath(tripId: string): string {
  const canonicalTripId = canonicalizeChatTripId(tripId);
  if (canonicalTripId === null) {
    throw new RangeError('Trip id must be a valid UUID.');
  }
  return `/trips/${encodeURIComponent(canonicalTripId)}/chat/messages`;
}

function chatMessagePath(tripId: string, messageId: string): string {
  return `${chatMessagesPath(tripId)}/${encodeURIComponent(messageId)}`;
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
  return parseChatHistoryResponse(response.data);
}

export async function gapFillChatMessages(
  tripId: string,
  options: GapFillChatMessagesOptions,
  signal?: AbortSignal,
): Promise<ChatGapFillResponse> {
  const limit = options.limit ?? RECONCILIATION_DEFAULT_LIMIT;
  assertLimit(limit, RECONCILIATION_MAX_LIMIT, 'Gap-fill limit');
  assertNonEmpty(options.since, 'Gap-fill anchor');
  const response = await apiClient.get<unknown>(chatMessagesPath(tripId), {
    params: { since: options.since, limit },
    signal,
  });
  return parseChatReconciliationResponse(response.data);
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
    assertNonEmpty(options.changedSinceId, 'Change-sync id');
    params.changed_since_id = options.changedSinceId;
  }
  const response = await apiClient.get<unknown>(chatMessagesPath(tripId), {
    params,
    signal,
  });
  return parseChatReconciliationResponse(response.data);
}

export async function sendChatMessage(
  tripId: string,
  input: SendChatMessageInput,
  signal?: AbortSignal,
): Promise<SendChatMessageResult> {
  const response = await apiClient.post<unknown>(
    chatMessagesPath(tripId),
    {
      content: input.content,
      client_message_id: input.clientMessageId,
    },
    { signal },
  );
  if (!isRecord(response.data) || (response.status !== 200 && response.status !== 201)) {
    throw new ChatContractError();
  }
  return {
    message: requireChatMessage(response.data.message),
    disposition: response.status === 201 ? 'created' : 'replayed',
  };
}

export async function deleteChatMessage(
  tripId: string,
  messageId: string,
  mode: DeleteChatMessageMode,
  signal?: AbortSignal,
): Promise<DeleteChatMessageResult> {
  const response = await apiClient.delete<unknown>(
    chatMessagePath(tripId, messageId),
    { data: { mode }, signal },
  );
  if (mode === 'for_me') {
    return {
      mode,
      hidden_message_ids: parseHiddenMessageIds(response.data),
    };
  }
  if (!isRecord(response.data)) {
    throw new ChatContractError();
  }
  return {
    mode,
    message: requireChatMessage(response.data.message),
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
  if (!messageIds.every(isNonEmptyString)) {
    throw new RangeError('Bulk hide message ids cannot be empty.');
  }
  const response = await apiClient.post<unknown>(
    `${chatMessagesPath(tripId)}/hide`,
    { message_ids: [...messageIds] },
    { signal },
  );
  return { hidden_message_ids: parseHiddenMessageIds(response.data) };
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
