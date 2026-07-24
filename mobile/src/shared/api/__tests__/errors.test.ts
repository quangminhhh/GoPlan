import { AxiosError, AxiosHeaders } from 'axios';
import { normalizeApiError } from '../errors';

function axiosErrorWith(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}

describe('normalizeApiError', () => {
  it('maps detail + error_code responses', () => {
    const result = normalizeApiError(
      axiosErrorWith(403, { detail: 'Please verify your email address before signing in.', error_code: 'EMAIL_NOT_VERIFIED' }),
    );
    expect(result).toEqual({
      kind: 'message',
      message: 'Please verify your email address before signing in.',
      errorCode: 'EMAIL_NOT_VERIFIED',
      status: 403,
    });
  });

  it('maps DRF field errors to first message per field', () => {
    const result = normalizeApiError(
      axiosErrorWith(400, { email: ['Enter a valid email address.'], password: ['This password is too short.', 'x'] }),
    );
    expect(result.kind).toBe('field');
    expect(result.fieldErrors).toEqual({
      email: 'Enter a valid email address.',
      password: 'This password is too short.',
    });
  });

  it('recursively flattens nested field objects to dotted keys', () => {
    const result = normalizeApiError(
      axiosErrorWith(400, {
        place: {
          provider_id: ['Select a valid place.'],
          coordinates: {
            lat: ['Enter a valid latitude.'],
          },
        },
      }),
    );
    expect(result).toEqual({
      kind: 'field',
      message: 'Please fix the highlighted fields.',
      fieldErrors: {
        'place.provider_id': 'Select a valid place.',
        'place.coordinates.lat': 'Enter a valid latitude.',
      },
      status: 400,
    });
  });

  it.each([
    {
      place: { provider_id: ['Nested message.'] },
      'place.provider_id': ['Explicit message.'],
    },
    {
      'place.provider_id': ['Explicit message.'],
      place: { provider_id: ['Nested message.'] },
    },
  ])('lets a top-level pre-dotted leaf win a nested collision regardless of key order', (data) => {
    const result = normalizeApiError(axiosErrorWith(400, data));
    expect(result.fieldErrors).toEqual({
      'place.provider_id': 'Explicit message.',
    });
  });

  it('keeps mixed flat, nested, and non-field errors while taking the first string array leaf', () => {
    const result = normalizeApiError(
      axiosErrorWith(400, {
        location_label: [null, 'Enter a location.', 'Later location error.'],
        place: {
          title: ['Enter a place title.', 'Later title error.'],
          non_field_errors: ['The place fields do not match.'],
        },
        non_field_errors: ['Review the form.'],
      }),
    );
    expect(result).toEqual({
      kind: 'field',
      message: 'Please fix the highlighted fields.',
      fieldErrors: {
        location_label: 'Enter a location.',
        'place.title': 'Enter a place title.',
        'place.non_field_errors': 'The place fields do not match.',
        non_field_errors: 'Review the form.',
      },
      status: 400,
    });
  });

  it('maps lone non_field_errors to a message error', () => {
    const result = normalizeApiError(axiosErrorWith(400, { non_field_errors: ['Something failed.'] }));
    expect(result).toEqual({ kind: 'message', message: 'Something failed.', status: 400 });
  });

  it('maps 429 to throttled', () => {
    const result = normalizeApiError(axiosErrorWith(429, { detail: 'Request was throttled.' }));
    expect(result).toEqual({
      kind: 'throttled',
      message: 'Too many attempts. Please wait a moment and try again.',
      status: 429,
    });
  });

  it('maps missing response to network error', () => {
    const config = { headers: new AxiosHeaders() };
    const error = new AxiosError('Network Error', 'ERR_NETWORK', config, {});
    expect(normalizeApiError(error)).toEqual({
      kind: 'network',
      message: 'Cannot reach the server. Check your connection.',
    });
  });

  it('maps unknown values to a generic message', () => {
    expect(normalizeApiError(new Error('boom'))).toEqual({
      kind: 'message',
      message: 'Something went wrong. Please try again.',
    });
  });
});
