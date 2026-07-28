import { AxiosError } from 'axios';

export interface ApiError {
  kind: 'field' | 'message' | 'throttled' | 'network';
  message: string;
  errorCode?: string;
  fieldErrors?: Record<string, string>;
  status?: number;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const NETWORK_MESSAGE = 'Cannot reach the server. Check your connection.';
const THROTTLED_MESSAGE = 'Too many attempts. Please wait a moment and try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string');
  }
  return undefined;
}

function flattenFieldErrors(body: Record<string, unknown>): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const explicitTopLevelLeaves = new Set<string>();

  for (const [field, value] of Object.entries(body)) {
    const message = firstString(value);
    if (message !== undefined) {
      explicitTopLevelLeaves.add(field);
      fieldErrors[field] = message;
    }
  }

  function flattenNested(value: Record<string, unknown>, prefix: string): void {
    for (const [field, nestedValue] of Object.entries(value)) {
      const path = `${prefix}.${field}`;
      const message = firstString(nestedValue);
      if (message !== undefined) {
        if (!explicitTopLevelLeaves.has(path)) {
          fieldErrors[path] = message;
        }
      } else if (isRecord(nestedValue)) {
        flattenNested(nestedValue, path);
      }
    }
  }

  for (const [field, value] of Object.entries(body)) {
    if (isRecord(value)) {
      flattenNested(value, field);
    }
  }

  return fieldErrors;
}

export function normalizeApiError(error: unknown): ApiError {
  if (!(error instanceof AxiosError)) {
    return { kind: 'message', message: GENERIC_MESSAGE };
  }
  if (!error.response) {
    return { kind: 'network', message: NETWORK_MESSAGE };
  }

  const { status, data } = error.response;
  if (status === 429) {
    return { kind: 'throttled', message: THROTTLED_MESSAGE, status };
  }

  if (data && typeof data === 'object') {
    const body = data as Record<string, unknown>;

    if (typeof body.detail === 'string') {
      return {
        kind: 'message',
        message: body.detail,
        status,
        ...(typeof body.error_code === 'string' ? { errorCode: body.error_code } : {}),
      };
    }

    const fieldErrors = flattenFieldErrors(body);
    const fields = Object.keys(fieldErrors);
    if (fields.length === 1 && fields[0] === 'non_field_errors') {
      return { kind: 'message', message: fieldErrors.non_field_errors, status };
    }
    if (fields.length > 0) {
      return { kind: 'field', message: 'Please fix the highlighted fields.', fieldErrors, status };
    }
  }

  return { kind: 'message', message: GENERIC_MESSAGE, status };
}
