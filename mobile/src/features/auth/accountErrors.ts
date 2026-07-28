import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { ImagePreprocessError, type PreprocessTarget } from '@/shared/media/types';

/**
 * The server rejects any upload over 500 KB before processing and any source
 * edge over 1024 px, then stores a center-cropped 512x512 image. Preprocessing
 * to exactly that shape keeps a 4 MB camera photo inside the ceiling. This is a
 * transport-size optimisation; the server remains the sole validator.
 */
export const AVATAR_TARGET: PreprocessTarget = { maxEdgePx: 512, maxBytes: 500 * 1024 };

const PREPROCESS_FAILED_MESSAGE = 'Could not prepare that photo. Try another one.';

/**
 * Server error copy is already user-facing and per-error-code distinct, so it is
 * shown as returned. Only genuinely client-side failures get our own wording.
 */
export function describeAvatarError(error: unknown): string {
  if (error instanceof ImagePreprocessError) {
    return PREPROCESS_FAILED_MESSAGE;
  }
  return normalizeApiError(error).message;
}

export interface NameFieldErrors {
  firstName?: string;
  lastName?: string;
  form?: string;
  routeToProfileSetup: boolean;
}

export function mapProfileNameError(error: ApiError): NameFieldErrors {
  switch (error.errorCode) {
    case 'PROFILE_SETUP_REQUIRED':
      return { routeToProfileSetup: true };
    case 'INVALID_FIRST_NAME':
      return { firstName: error.message, routeToProfileSetup: false };
    case 'INVALID_LAST_NAME':
      return { lastName: error.message, routeToProfileSetup: false };
    default:
      break;
  }
  if (error.kind === 'field') {
    return {
      firstName: error.fieldErrors?.first_name,
      lastName: error.fieldErrors?.last_name,
      routeToProfileSetup: false,
    };
  }
  return { form: error.message, routeToProfileSetup: false };
}

export interface PasswordFieldErrors {
  currentPassword?: string;
  newPassword?: string;
  form?: string;
}

export function mapChangePasswordError(error: ApiError): PasswordFieldErrors {
  switch (error.errorCode) {
    case 'INVALID_CURRENT_PASSWORD':
      return { currentPassword: error.message };
    case 'SAME_PASSWORD':
    case 'WEAK_PASSWORD':
      return { newPassword: error.message };
    default:
      break;
  }
  if (error.kind === 'field') {
    return {
      currentPassword: error.fieldErrors?.current_password,
      newPassword: error.fieldErrors?.new_password,
    };
  }
  return { form: error.message };
}
