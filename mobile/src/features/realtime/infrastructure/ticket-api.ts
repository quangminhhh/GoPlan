import { isAxiosError } from 'axios';
import { apiClient } from '@/shared/api/client';

export type TicketRequestErrorKind = 'hardAuth' | 'throttled' | 'transient';

export class TicketRequestError extends Error {
  readonly kind: TicketRequestErrorKind;
  readonly retryAfterMs: number | null;

  constructor(kind: TicketRequestErrorKind, retryAfterMs: number | null = null) {
    super('Realtime ticket request failed.');
    this.name = 'TicketRequestError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TicketApi {
  issue(): Promise<string>;
  refresh(): Promise<string>;
}

export function parseRetryAfterMs(
  value: unknown,
  nowMs: number = Date.now(),
): number | null {
  const normalized = typeof value === 'string' ? value.trim() : String(value);
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1_000 : null;
  }

  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs) return null;
  return retryAtMs - nowMs;
}

function classifyTicketError(error: unknown): TicketRequestError {
  if (!isAxiosError(error)) {
    return new TicketRequestError('transient');
  }

  const status = error.response?.status;
  if (status === 401 || status === 403) {
    return new TicketRequestError('hardAuth');
  }
  if (status === 429) {
    return new TicketRequestError(
      'throttled',
      parseRetryAfterMs(error.response?.headers?.['retry-after']),
    );
  }
  return new TicketRequestError('transient');
}

function parseTicketResponse(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('ticket' in value) ||
    typeof value.ticket !== 'string' ||
    value.ticket.length === 0
  ) {
    throw new TicketRequestError('transient');
  }
  return value.ticket;
}

async function requestTicket(path: string): Promise<string> {
  try {
    const response = await apiClient.post<unknown>(path);
    return parseTicketResponse(response.data);
  } catch (error) {
    if (error instanceof TicketRequestError) {
      throw error;
    }
    throw classifyTicketError(error);
  }
}

export const realtimeTicketApi: TicketApi = {
  issue: () => requestTicket('/realtime/ws-ticket'),
  refresh: () => requestTicket('/realtime/ws-ticket/refresh'),
};
