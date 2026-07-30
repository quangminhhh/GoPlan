/**
 * One failure shape for both transports, plus the 404 split every owner must
 * respect (D18).
 *
 * Photo work arrives through two paths: Axios for list/upload/delete, and
 * `fetchProtectedResponse` for asset bytes and the bulk ZIP. They throw
 * different error types, and every call site needs the same three facts — what
 * kind of failure, what the server called it, and what is safe to show.
 */

import { normalizeApiError } from '@/shared/api/errors';
import { AxiosError } from 'axios';
import {
  isProtectedAssetError,
  type ProtectedAssetErrorKind,
} from '@/shared/media/protectedAssetTypes';

export type PhotoFailureKind = ProtectedAssetErrorKind;

export interface PhotoFailure {
  kind: PhotoFailureKind;
  /** Safe to display and safe to log. Never contains a path or a token. */
  message: string;
  status?: number;
  errorCode?: string;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export const PHOTO_ERROR_MESSAGES = {
  tripNotFound: 'Trip not found.',
  photoGone: 'This photo is no longer available.',
  uploadThrottled: 'Upload limit reached. Try again later.',
  assetThrottled: 'Too many photo requests. Please wait a moment and try again.',
  downloadThrottled: 'Download limit reached. Try again later.',
  bulkThrottled: 'Download limit reached. Try again later.',
  bulkStale: 'Some selected photos are no longer available.',
  lowStorage: 'Not enough storage space to prepare these photos.',
  selectionCap: 'You can select up to 100 photos.',
} as const;

function kindForStatus(status: number | undefined): PhotoFailureKind {
  if (status === undefined) return 'network';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  if (status >= 400) return 'request';
  return 'server';
}

/**
 * Normalises anything a photo call can throw.
 *
 * Note the DRF field-error case: `normalizeApiError` only surfaces `error_code`
 * when the body carries `detail`, so a serializer rejection produces a generic
 * message and no code. Callers must therefore never assume `errorCode` exists on
 * a 400 — see "Body dạng field-error" in the plan.
 */
export function toPhotoFailure(error: unknown): PhotoFailure {
  if (isProtectedAssetError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.errorCode !== undefined ? { errorCode: error.errorCode } : {}),
    };
  }

  if (error instanceof AxiosError) {
    if (error.code === 'ERR_CANCELED') {
      return { kind: 'cancelled', message: GENERIC_MESSAGE };
    }
    const normalized = normalizeApiError(error);
    return {
      kind: normalized.kind === 'network' ? 'network' : kindForStatus(normalized.status),
      message: normalized.message,
      ...(normalized.status !== undefined ? { status: normalized.status } : {}),
      ...(normalized.errorCode !== undefined ? { errorCode: normalized.errorCode } : {}),
    };
  }

  return { kind: 'server', message: GENERIC_MESSAGE };
}

export function isCancelledFailure(failure: PhotoFailure): boolean {
  return failure.kind === 'cancelled';
}

/**
 * What a 404 actually means at this call site.
 *
 * Asset, delete, single save and bulk download all resolve membership before
 * they resolve a photo, so any of them can answer either way. Collapsing both
 * into "photo is stale" tombstones tiles one by one while the real story is that
 * the user was removed from the trip.
 *
 * `unknown` is the honest third answer: a malformed 404, or one whose body was
 * too large to parse. The owner must reconcile before acting on it, never guess
 * by reading `detail` — that string is user-facing copy, not contract.
 */
export type PhotoNotFoundScope = 'trip' | 'photo' | 'unknown';

export function classifyNotFound(failure: PhotoFailure): PhotoNotFoundScope {
  if (failure.errorCode === 'TRIP_NOT_FOUND') return 'trip';
  if (failure.errorCode === 'PHOTO_NOT_FOUND') return 'photo';
  return 'unknown';
}

export function isTripNotFound(failure: PhotoFailure): boolean {
  return failure.kind === 'notFound' && classifyNotFound(failure) === 'trip';
}

/**
 * Codes that mean the client built a request the server was always going to
 * reject. They are batching bugs, not user errors: the server's own wording is
 * shown, the session stops, and nothing is retried automatically.
 */
export const BATCHING_INVARIANT_CODES = new Set([
  'TOO_MANY_FILES',
  'PHOTO_UPLOAD_TOO_LARGE',
  'PHOTO_DIMENSIONS_TOO_LARGE',
  'HEIC_UNSUPPORTED',
  'NO_FILES',
]);

export function isBatchingInvariantViolation(failure: PhotoFailure): boolean {
  return failure.errorCode !== undefined && BATCHING_INVARIANT_CODES.has(failure.errorCode);
}

/**
 * True when the request outcome cannot be known.
 *
 * The upload endpoint has no idempotency key, and a 5xx can be raised after the
 * rows were committed — while serializing the response, or at a proxy. Treating
 * that as a definite failure and retrying is how duplicate photos get created,
 * so 5xx sits with network and timeout rather than with the deterministic 4xx.
 */
export function isUncertainOutcome(failure: PhotoFailure): boolean {
  return failure.kind === 'network' || failure.kind === 'server';
}
