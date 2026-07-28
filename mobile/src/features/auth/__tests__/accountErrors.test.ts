import { axiosError } from '@test/axiosError';
import { ImagePreprocessError } from '@/shared/media/types';
import { describeAvatarError, mapChangePasswordError, mapProfileNameError } from '../accountErrors';

describe('describeAvatarError', () => {
  it.each([
    ['AVATAR_TOO_LARGE', 'Avatar file exceeds 500KB limit.'],
    ['AVATAR_INVALID_FORMAT', 'Unsupported image format.'],
    ['AVATAR_DIMENSIONS_TOO_LARGE', 'Image dimensions exceed 1024x1024.'],
    ['AVATAR_STORAGE_SAVE_FAILED', 'Could not update avatar storage safely. Please try again.'],
  ])('passes the server message through unchanged for %s', (errorCode, message) => {
    const error = axiosError(400, { detail: message, error_code: errorCode });

    expect(describeAvatarError(error)).toBe(message);
  });

  it('surfaces a 429 as the throttled state, not a generic failure', () => {
    expect(describeAvatarError(axiosError(429, {}))).toBe(
      'Too many attempts. Please wait a moment and try again.',
    );
  });

  it('reports a client-side preprocess failure in its own words', () => {
    const error = new ImagePreprocessError('BUDGET_UNREACHABLE', 'internal');

    expect(describeAvatarError(error)).toBe('Could not prepare that photo. Try another one.');
  });
});

describe('mapProfileNameError', () => {
  it('routes PROFILE_SETUP_REQUIRED to profile setup instead of surfacing a raw error', () => {
    expect(mapProfileNameError({ kind: 'message', message: 'Profile setup is required.', errorCode: 'PROFILE_SETUP_REQUIRED', status: 409 })).toEqual({
      routeToProfileSetup: true,
    });
  });

  it('places INVALID_FIRST_NAME on the first name input', () => {
    expect(mapProfileNameError({ kind: 'message', message: 'First name cannot be empty.', errorCode: 'INVALID_FIRST_NAME', status: 400 })).toEqual({
      firstName: 'First name cannot be empty.',
      routeToProfileSetup: false,
    });
  });

  it('places INVALID_LAST_NAME on the last name input', () => {
    expect(mapProfileNameError({ kind: 'message', message: 'Last name must be a single word (no spaces).', errorCode: 'INVALID_LAST_NAME', status: 400 })).toEqual({
      lastName: 'Last name must be a single word (no spaces).',
      routeToProfileSetup: false,
    });
  });

  it('falls back to a form-level error for INVALID_IDENTITY_PAYLOAD', () => {
    expect(mapProfileNameError({ kind: 'message', message: 'Invalid identity payload.', errorCode: 'INVALID_IDENTITY_PAYLOAD', status: 400 })).toEqual({
      form: 'Invalid identity payload.',
      routeToProfileSetup: false,
    });
  });

  it('surfaces a throttled response as its own form-level state', () => {
    expect(mapProfileNameError({ kind: 'throttled', message: 'Too many attempts. Please wait a moment and try again.', status: 429 })).toEqual({
      form: 'Too many attempts. Please wait a moment and try again.',
      routeToProfileSetup: false,
    });
  });
});

describe('mapChangePasswordError', () => {
  it('places INVALID_CURRENT_PASSWORD on the current password input', () => {
    expect(mapChangePasswordError({ kind: 'message', message: 'Current password is incorrect.', errorCode: 'INVALID_CURRENT_PASSWORD', status: 400 })).toEqual({
      currentPassword: 'Current password is incorrect.',
    });
  });

  it.each(['SAME_PASSWORD', 'WEAK_PASSWORD'])('places %s on the new password input', (errorCode) => {
    expect(mapChangePasswordError({ kind: 'message', message: 'server copy', errorCode, status: 400 })).toEqual({
      newPassword: 'server copy',
    });
  });

  it('maps DRF field errors onto the matching inputs', () => {
    expect(
      mapChangePasswordError({
        kind: 'field',
        message: 'Please fix the highlighted fields.',
        fieldErrors: { new_password: 'Ensure this field has at least 8 characters.' },
        status: 400,
      }),
    ).toEqual({ newPassword: 'Ensure this field has at least 8 characters.' });
  });

  it('surfaces a throttled response as its own form-level state', () => {
    expect(mapChangePasswordError({ kind: 'throttled', message: 'Too many attempts. Please wait a moment and try again.', status: 429 })).toEqual({
      form: 'Too many attempts. Please wait a moment and try again.',
    });
  });
});
