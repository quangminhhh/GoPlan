import { normalizeApiError } from '@/shared/api/errors';
import { ImagePreprocessError, type PreprocessTarget } from '@/shared/media/types';

/**
 * Mirrors backend TRIP_COVER_MAX_EDGE / TRIP_COVER_MAX_BYTES, and the web target
 * in frontend/features/trips/presentation/cover-image-picker.tsx. Preprocessing
 * is a transport-size optimisation; the server re-encodes every accepted upload
 * to WebP and remains the sole validator.
 */
export const TRIP_COVER_TARGET: PreprocessTarget = {
  maxEdgePx: 2560,
  maxBytes: 10 * 1024 * 1024,
};

const PREPROCESS_FAILED_MESSAGE = 'Could not prepare that photo. Try another one.';

/**
 * Server error copy is already user-facing and per-error-code distinct, so it is
 * shown as returned. Only genuinely client-side failures get our own wording.
 */
export function describeCoverError(error: unknown): string {
  if (error instanceof ImagePreprocessError) {
    return PREPROCESS_FAILED_MESSAGE;
  }
  return normalizeApiError(error).message;
}
