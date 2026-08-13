import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

jest.mock('@/shared/api/client', () => ({
  apiClient: {
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import {
  cancelAIActionDraft,
  confirmAIActionDraft,
  getAIActionDraft,
  isAmbiguousConfirmFailure,
  normalizeAIActionDraftApiError,
  parseRetryAfterMs,
  patchAIActionDraft,
} from '../api';
// eslint-disable-next-line import/first
import { makeRawDraftFixture as makeRawDraft } from '../__fixtures__/drafts';

const mockGet = jest.mocked(apiClient.get);
const mockPatch = jest.mocked(apiClient.patch);
const mockPost = jest.mocked(apiClient.post);

function config(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() };
}

function response<T>(data: T, status: number = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: '',
    headers: {},
    config: config(),
  };
}

function axiosError(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): AxiosError {
  const requestConfig = config();
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', requestConfig, {}, {
    status,
    data,
    headers: new AxiosHeaders(headers),
    statusText: 'Request failed',
    config: requestConfig,
  });
}

describe('AI action draft direct-Django API', () => {
  const tripId = '11111111-1111-4111-8111-111111111111';
  const draftId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses canonical UUID GET/PATCH/confirm/cancel routes and PATCH {payload}', async () => {
    const envelope = { draft: makeRawDraft() };
    mockGet.mockResolvedValueOnce(response(envelope));
    mockPatch.mockResolvedValueOnce(response(envelope));
    mockPost
      .mockResolvedValueOnce(response(envelope))
      .mockResolvedValueOnce(response(envelope));

    await getAIActionDraft(tripId, draftId);
    await patchAIActionDraft(tripId, draftId, { total_amount: '500000' });
    await confirmAIActionDraft(tripId, draftId);
    await cancelAIActionDraft(tripId, draftId);

    const path = `/trips/${tripId}/ai/action-drafts/${draftId}`;
    expect(mockGet).toHaveBeenCalledWith(path, { signal: undefined });
    expect(mockPatch).toHaveBeenCalledWith(
      path,
      { payload: { total_amount: '500000' } },
      { signal: undefined },
    );
    expect(mockPost).toHaveBeenNthCalledWith(
      1,
      `${path}/confirm`,
      undefined,
      { signal: undefined },
    );
    expect(mockPost).toHaveBeenNthCalledWith(
      2,
      `${path}/cancel`,
      undefined,
      { signal: undefined },
    );
  });

  it.each([
    ['spaces', 'trip 1', draftId],
    ['non-UUID text', tripId, 'draft'],
  ])('fails closed for non-canonical path input: %s', async (_label, trip, draft) => {
    await expect(getAIActionDraft(trip, draft)).rejects.toThrow('canonical UUID');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('canonicalizes uppercase and surrounding whitespace before issuing a request', async () => {
    mockGet.mockResolvedValueOnce(response({ draft: makeRawDraft() }));
    await getAIActionDraft(` ${tripId.toUpperCase()} `, ` ${draftId.toUpperCase()} `);
    expect(mockGet).toHaveBeenCalledWith(
      `/trips/${tripId}/ai/action-drafts/${draftId}`,
      { signal: undefined },
    );
  });

  it('rejects malformed success payloads instead of trusting Axios generics', async () => {
    mockGet.mockResolvedValueOnce(response({ draft: { id: 'only-an-id' } }));
    await expect(getAIActionDraft(tripId, draftId)).rejects.toThrow(
      'invalid response',
    );
  });

  it.each([
    ['GET', () => getAIActionDraft(tripId, draftId), () => mockGet.mockResolvedValueOnce(
      response({ draft: makeRawDraft({ id: '33333333-3333-4333-8333-333333333333' }) }),
    )],
    ['PATCH', () => patchAIActionDraft(tripId, draftId, { title: 'Lunch' }), () =>
      mockPatch.mockResolvedValueOnce(
        response({ draft: makeRawDraft({ id: '33333333-3333-4333-8333-333333333333' }) }),
      )],
    ['confirm', () => confirmAIActionDraft(tripId, draftId), () =>
      mockPost.mockResolvedValueOnce(
        response({ draft: makeRawDraft({ id: '33333333-3333-4333-8333-333333333333' }) }),
      )],
    ['cancel', () => cancelAIActionDraft(tripId, draftId), () =>
      mockPost.mockResolvedValueOnce(
        response({ draft: makeRawDraft({ id: '33333333-3333-4333-8333-333333333333' }) }),
      )],
  ] as const)(
    'rejects a valid but mismatched draft id in a %s success envelope',
    async (_operation, request, arrange) => {
      arrange();
      await expect(request()).rejects.toThrow('invalid response');
    },
  );

  it('normalizes optional current draft, field errors, error code, and Retry-After', () => {
    const failure = normalizeAIActionDraftApiError(
      axiosError(
        400,
        {
          detail: 'Field validation failed.',
          error_code: 'FIELD_VALIDATION_FAILED',
          field_errors: {
            total_amount: 'Enter a positive amount.',
            ignored_non_string: 9,
          },
          draft: makeRawDraft({ status: 'NEEDS_INFO', can_confirm: false }),
        },
        { 'Retry-After': '17' },
      ),
      'patch',
    );
    expect(failure.errorCode).toBe('FIELD_VALIDATION_FAILED');
    expect(failure.fieldErrors).toEqual({
      total_amount: 'Enter a positive amount.',
    });
    expect(failure.draft?.status).toBe('NEEDS_INFO');
    expect(failure.retryAfterMs).toBeNull();
  });

  it('ignores malformed optional error drafts without losing the server detail', () => {
    const failure = normalizeAIActionDraftApiError(
      axiosError(409, {
        detail: 'Draft changed.',
        error_code: 'AI_DRAFT_STALE',
        draft: { id: 'malformed' },
      }),
      'confirm',
    );
    expect(failure.draft).toBeNull();
    expect(failure.message).toBe('Draft changed.');
  });

  it('ignores a valid error draft whose canonical id does not match the request', () => {
    const failure = normalizeAIActionDraftApiError(
      axiosError(409, {
        detail: 'Draft changed.',
        error_code: 'AI_DRAFT_STALE',
        draft: makeRawDraft({
          id: '33333333-3333-4333-8333-333333333333',
          status: 'EXPIRED',
        }),
      }),
      'patch',
      Date.parse('2026-08-10T00:00:00.000Z'),
      draftId,
    );
    expect(failure.draft).toBeNull();
    expect(failure.message).toBe('Draft changed.');
  });

  it('names the 30/hour confirmation limit and parses Retry-After', () => {
    const failure = normalizeAIActionDraftApiError(
      axiosError(
        429,
        { detail: 'Request was throttled.', error_code: 'THROTTLED' },
        { 'Retry-After': '30' },
      ),
      'confirm',
    );
    expect(failure.kind).toBe('throttled');
    expect(failure.message).toContain('30 action confirmations per hour');
    expect(failure.retryAfterMs).toBe(30_000);
    expect(isAmbiguousConfirmFailure(failure)).toBe(true);
  });

  it('parses seconds and HTTP-date Retry-After while rejecting invalid values', () => {
    expect(parseRetryAfterMs('12', 0)).toBe(12_000);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60_000);
    expect(parseRetryAfterMs('0', 0)).toBeNull();
    expect(parseRetryAfterMs('not-a-date', 0)).toBeNull();
    expect(parseRetryAfterMs('9007199254741', 0)).toBeNull();
    expect(
      parseRetryAfterMs(
        'Fri, 13 Sep 275760 00:00:00 GMT',
        -8_640_000_000_000_000,
      ),
    ).toBeNull();
  });

  it.each([
    [new AxiosError('timeout', 'ECONNABORTED'), true],
    [axiosError(500, { detail: 'Server error.' }), true],
    [axiosError(429, { detail: 'Throttled.' }), true],
    [axiosError(409, { detail: 'Stale.' }), false],
  ])('classifies confirm ambiguity without guessing (%#)', (error, ambiguous) => {
    const failure = normalizeAIActionDraftApiError(error, 'confirm');
    expect(isAmbiguousConfirmFailure(failure)).toBe(ambiguous);
  });
});
