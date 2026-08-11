import { isAxiosError } from 'axios';
import { apiClient } from '@/shared/api/client';
import { normalizeApiError, type ApiError } from '@/shared/api/errors';
import {
  isAIRecord,
  canonicalizeAIUuid,
  parseAIActionDraft,
  requireMatchingAIActionDraft,
  requireMatchingAIActionDraftEnvelope,
  type AIActionDraft,
  type AIActionDraftEnvelope,
} from './drafts';

export type AIActionDraftOperation = 'get' | 'patch' | 'confirm' | 'cancel';

export interface AIActionDraftApiFailure {
  readonly kind: ApiError['kind'];
  readonly message: string;
  readonly operation: AIActionDraftOperation;
  readonly errorCode: string | null;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  readonly draft: AIActionDraft | null;
}

function requireCanonicalUuid(value: string, label: string): string {
  const canonical = canonicalizeAIUuid(value);
  if (canonical === null) {
    throw new RangeError(`${label} must be a canonical UUID.`);
  }
  return canonical;
}

export function aiActionDraftPath(tripId: string, draftId: string): string {
  const canonicalTripId = requireCanonicalUuid(tripId, 'Trip id');
  const canonicalDraftId = requireCanonicalUuid(draftId, 'Draft id');
  return `/trips/${canonicalTripId}/ai/action-drafts/${canonicalDraftId}`;
}

export async function getAIActionDraft(
  tripId: string,
  draftId: string,
  signal?: AbortSignal,
): Promise<AIActionDraftEnvelope> {
  const response = await apiClient.get<unknown>(
    aiActionDraftPath(tripId, draftId),
    { signal },
  );
  return requireMatchingAIActionDraftEnvelope(response.data, draftId);
}

export async function patchAIActionDraft(
  tripId: string,
  draftId: string,
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<AIActionDraftEnvelope> {
  const response = await apiClient.patch<unknown>(
    aiActionDraftPath(tripId, draftId),
    { payload: { ...payload } },
    { signal },
  );
  return requireMatchingAIActionDraftEnvelope(response.data, draftId);
}

export async function confirmAIActionDraft(
  tripId: string,
  draftId: string,
  signal?: AbortSignal,
): Promise<AIActionDraftEnvelope> {
  const response = await apiClient.post<unknown>(
    `${aiActionDraftPath(tripId, draftId)}/confirm`,
    undefined,
    { signal },
  );
  return requireMatchingAIActionDraftEnvelope(response.data, draftId);
}

export async function cancelAIActionDraft(
  tripId: string,
  draftId: string,
  signal?: AbortSignal,
): Promise<AIActionDraftEnvelope> {
  const response = await apiClient.post<unknown>(
    `${aiActionDraftPath(tripId, draftId)}/cancel`,
    undefined,
    { signal },
  );
  return requireMatchingAIActionDraftEnvelope(response.data, draftId);
}

function parseFieldErrors(
  value: unknown,
): Readonly<Record<string, string>> | null {
  if (!isAIRecord(value)) {
    return null;
  }
  const fieldErrors: Record<string, string> = {};
  for (const [field, message] of Object.entries(value)) {
    if (typeof message === 'string') {
      fieldErrors[field] = message;
    }
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : null;
}

function headerValue(headers: unknown, name: string): unknown {
  if (!isAIRecord(headers)) {
    return undefined;
  }
  const getter = headers.get;
  if (typeof getter === 'function') {
    return Reflect.apply(getter, headers, [name]);
  }
  const lowerName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

export function parseRetryAfterMs(
  value: unknown,
  nowMs: number = Date.now(),
): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds) && milliseconds > 0
      ? milliseconds
      : null;
  }
  const retryAtMs = Date.parse(normalized);
  const delayMs = retryAtMs - nowMs;
  return Number.isFinite(retryAtMs) && Number.isSafeInteger(delayMs) && delayMs > 0
    ? delayMs
    : null;
}

function fallbackForOperation(operation: AIActionDraftOperation): string {
  if (operation === 'patch') {
    return 'The draft could not be updated.';
  }
  if (operation === 'confirm') {
    return 'The confirmation outcome could not be determined.';
  }
  if (operation === 'cancel') {
    return 'The draft could not be cancelled.';
  }
  return 'The latest draft status could not be loaded.';
}

function throttledMessage(operation: AIActionDraftOperation): string | null {
  if (operation === 'confirm') {
    return 'GoPlanAI allows 30 action confirmations per hour. Confirmation was not retried; checking the draft status is required.';
  }
  return null;
}

export function normalizeAIActionDraftApiError(
  error: unknown,
  operation: AIActionDraftOperation,
  nowMs: number = Date.now(),
  requestedDraftId?: string,
): AIActionDraftApiFailure {
  const base = normalizeApiError(error);
  if (!isAxiosError(error)) {
    return {
      kind: base.kind,
      message: base.message || fallbackForOperation(operation),
      operation,
      errorCode: base.errorCode ?? null,
      status: base.status ?? null,
      retryAfterMs: null,
      fieldErrors: base.fieldErrors ?? null,
      draft: null,
    };
  }

  const response = error.response;
  const status = response?.status ?? base.status ?? null;
  const body = isAIRecord(response?.data) ? response.data : null;
  const detail = body && typeof body.detail === 'string' ? body.detail : null;
  const errorCode =
    body && typeof body.error_code === 'string'
      ? body.error_code
      : (base.errorCode ?? null);
  const parsedDraft = body ? parseAIActionDraft(body.draft) : null;
  let draft: AIActionDraft | null = parsedDraft;
  if (parsedDraft !== null && requestedDraftId !== undefined) {
    try {
      draft = requireMatchingAIActionDraft(parsedDraft, requestedDraftId);
    } catch {
      draft = null;
    }
  }
  const explicitFieldErrors = body ? parseFieldErrors(body.field_errors) : null;
  const retryAfterMs =
    status === 429
      ? parseRetryAfterMs(headerValue(response?.headers, 'retry-after'), nowMs)
      : null;
  const specificThrottle = status === 429 ? throttledMessage(operation) : null;
  const message =
    specificThrottle === null
      ? (detail ?? base.message ?? fallbackForOperation(operation))
      : detail === null
        ? specificThrottle
        : `${specificThrottle} Server response: ${detail}`;

  return {
    kind: status === 429 ? 'throttled' : base.kind,
    message,
    operation,
    errorCode,
    status,
    retryAfterMs,
    fieldErrors: explicitFieldErrors ?? base.fieldErrors ?? null,
    draft,
  };
}

export function isAmbiguousConfirmFailure(
  failure: AIActionDraftApiFailure,
): boolean {
  return (
    failure.operation === 'confirm' &&
    (failure.status === null ||
      failure.kind === 'network' ||
      failure.status === 429 ||
      (failure.status !== null && failure.status >= 500))
  );
}
