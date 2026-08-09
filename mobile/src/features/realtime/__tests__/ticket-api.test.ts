import { apiClient } from '@/shared/api/client';
import {
  parseRetryAfterMs,
  realtimeTicketApi,
} from '../infrastructure/ticket-api';

describe('realtimeTicketApi', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the direct-Django ticket endpoints and returns validated tickets', async () => {
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ data: { ticket: 'issue-ticket' } })
      .mockResolvedValueOnce({ data: { ticket: 'refresh-ticket' } });

    await expect(realtimeTicketApi.issue()).resolves.toBe('issue-ticket');
    await expect(realtimeTicketApi.refresh()).resolves.toBe('refresh-ticket');
    expect(post).toHaveBeenNthCalledWith(1, '/realtime/ws-ticket');
    expect(post).toHaveBeenNthCalledWith(2, '/realtime/ws-ticket/refresh');
  });

  it.each([null, {}, { ticket: '' }, { ticket: 7 }])(
    'rejects malformed successful payload %p',
    async (data) => {
      jest.spyOn(apiClient, 'post').mockResolvedValue({ data });
      await expect(realtimeTicketApi.issue()).rejects.toMatchObject({
        kind: 'transient',
      });
    },
  );

  it.each([
    [401, 'hardAuth'],
    [403, 'hardAuth'],
    [500, 'transient'],
  ])('classifies HTTP %s as %s', async (status, kind) => {
    jest.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status, headers: {} },
    });
    await expect(realtimeTicketApi.issue()).rejects.toMatchObject({ kind });
  });

  it('preserves parsed Retry-After on throttling', async () => {
    jest.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 429, headers: { 'retry-after': '42' } },
    });
    await expect(realtimeTicketApi.issue()).rejects.toEqual(
      expect.objectContaining({
        kind: 'throttled',
        retryAfterMs: 42_000,
      }),
    );
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-08-09T00:00:00.000Z');

  it('supports delta-seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('17', now)).toBe(17_000);
    expect(parseRetryAfterMs('Sun, 09 Aug 2026 00:00:42 GMT', now)).toBe(42_000);
  });

  it.each([
    '0',
    '-1',
    '17junk',
    'invalid',
    'Sat, 08 Aug 2026 23:59:59 GMT',
  ])('rejects invalid or past value %s', (value) => {
    expect(parseRetryAfterMs(value, now)).toBeNull();
  });
});
