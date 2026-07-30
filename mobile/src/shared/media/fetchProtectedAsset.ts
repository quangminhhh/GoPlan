/**
 * Status-aware fetch for member-only media (D1).
 *
 * `expo-image` can take `source={{ uri, headers }}`, but its error channel is a
 * single string — there is no way to tell 401 from 404 from a dropped
 * connection, and therefore no way to know when refreshing the token is the
 * right response. So the network request happens here, against `expo/fetch`,
 * and `expo-image` only ever renders the local file that comes out of it.
 *
 * The header is read immediately before each attempt rather than captured once,
 * because the access token rotates and a 60-tile grid scrolls for minutes.
 */

import { getApiBaseUrl } from '@/shared/api/base-url';
import { refreshTokens } from '@/shared/api/refresh';
import { getAccessToken } from '@/shared/api/token-store';
import {
  isPrivateMediaSessionOpen,
  createSessionClosedError,
  trackPrivateOperation,
} from './privateMediaLifecycle';
import {
  ProtectedAssetError,
  type ProtectedAssetErrorKind,
  type ProtectedTransport,
} from './protectedAssetTypes';
import { nativeProtectedTransport } from './protectedTransport';

/**
 * Ceiling on an error body before it is parsed. Generous for a DRF error,
 * far below anything a misconfigured proxy would return as an HTML page.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

const AUTH_MESSAGE = 'Your session has expired. Sign in again.';
const NETWORK_MESSAGE = 'Cannot reach the server. Check your connection.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const THROTTLED_MESSAGE = 'Too many requests. Please wait a moment and try again.';
const NOT_FOUND_MESSAGE = 'This content is no longer available.';
const FORBIDDEN_MESSAGE = 'You do not have access to this content.';

/**
 * Checked by code point rather than by regex: a control-character class written
 * literally in source is invisible in review and trips `no-control-regex`.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface ProtectedFetchOptions {
  /** API path relative to the `/api` root, e.g. `/trips/x/photos/y/thumbnail`. */
  path: string;
  method?: 'GET' | 'POST';
  body?: string;
  /** Never `Authorization` — this module owns that header. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  transport?: ProtectedTransport;
}

/**
 * Rejects anything that could send a bearer token somewhere other than the API
 * origin, and anything that could smuggle a token into a URL.
 *
 * Query strings are refused outright rather than sanitised. Nothing in this flow
 * needs one — list paging goes through Axios — so refusing them makes "the token
 * is never in a query string" a property of the code instead of a review note.
 */
export function assertSameOriginApiPath(path: string): void {
  const invalid = (): never => {
    throw new ProtectedAssetError('request', 'Invalid media path.');
  };

  if (typeof path !== 'string' || path.length === 0) {
    invalid();
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    // A protocol-relative path would let `new URL()` replace the origin.
    invalid();
  }
  if (path.includes('\\') || hasControlCharacter(path)) {
    invalid();
  }
  if (path.includes('://') || path.includes('?') || path.includes('#')) {
    invalid();
  }
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') {
      invalid();
    }
  }
}

function assertNoCallerAuthorization(headers: Record<string, string> | undefined): void {
  if (!headers) {
    return;
  }
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization') {
      throw new ProtectedAssetError('request', 'Invalid media request.');
    }
  }
}

/**
 * One controller fed by several signals. `AbortSignal.any` is not dependable
 * across the RN and Jest runtimes this code has to run in, and the linkage is
 * five lines.
 */
export function linkAbortSignals(signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  for (const source of signals) {
    if (!source) {
      continue;
    }
    if (source.aborted) {
      controller.abort();
      break;
    }
    const forward = (): void => controller.abort();
    source.addEventListener('abort', forward);
    cleanups.push(() => source.removeEventListener('abort', forward));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function kindForStatus(status: number): ProtectedAssetErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'server';
  return 'request';
}

function defaultMessageForKind(kind: ProtectedAssetErrorKind): string {
  switch (kind) {
    case 'auth':
      return AUTH_MESSAGE;
    case 'forbidden':
      return FORBIDDEN_MESSAGE;
    case 'notFound':
      return NOT_FOUND_MESSAGE;
    case 'throttled':
      return THROTTLED_MESSAGE;
    case 'network':
      return NETWORK_MESSAGE;
    default:
      return GENERIC_MESSAGE;
  }
}

/** Releases the native stream behind a response this flow will not read. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body already consumed or already errored rejects here; either way the
    // native resource is released and there is nothing left to do.
  }
}

export interface ParsedErrorBody {
  detail?: string;
  errorCode?: string;
}

/**
 * Reads a non-2xx body defensively.
 *
 * Two shapes reach here. The service layer returns `{detail, error_code}`. DRF
 * serializers reject earlier — an empty `photo_ids`, a non-UUID entry, a
 * mistyped `files` — and return a field-error object with neither key. The
 * second shape must degrade to a safe generic message: raw JSON is not something
 * to show a user, and a parser that assumes `detail` exists crashes on it.
 *
 * Bounded by `Content-Length`: without a declared, small length the body is
 * cancelled unread rather than buffered. Django sends the header on every
 * non-streaming error response, so this costs nothing in practice and removes
 * the "hostile response fills memory" case entirely.
 */
export async function parseProtectedErrorBody(response: Response): Promise<ParsedErrorBody> {
  const declared = Number(response.headers.get('content-length'));
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_ERROR_BODY_BYTES) {
    await discardBody(response);
    return {};
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return {};
  }

  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return {};
    }
    const record = body as Record<string, unknown>;
    return {
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      ...(typeof record.error_code === 'string' ? { errorCode: record.error_code } : {}),
    };
  } catch {
    return {};
  }
}

async function toProtectedAssetError(response: Response): Promise<ProtectedAssetError> {
  const kind = kindForStatus(response.status);
  const { detail, errorCode } = await parseProtectedErrorBody(response);
  // A 401 message is owned by this module: the backend's own wording for an
  // expired token is not something to surface after a failed retry.
  const message = kind === 'auth' ? AUTH_MESSAGE : (detail ?? defaultMessageForKind(kind));
  return new ProtectedAssetError(kind, message, {
    status: response.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
  });
}

/**
 * Performs an authenticated request against the API origin and returns the
 * response only when it is 2xx.
 *
 * Registration with the private-media lifecycle happens before control returns
 * to the caller, so a sign-out that starts one tick later can already abort this
 * request and wait for it — including any refresh it triggers.
 */
export function fetchProtectedResponse(options: ProtectedFetchOptions): Promise<Response> {
  const { path, method = 'GET', body, headers, signal, transport = nativeProtectedTransport } = options;

  // Validate before the operation is registered: a malformed path is a
  // programming error, not private-network activity worth tracking.
  assertSameOriginApiPath(path);
  assertNoCallerAuthorization(headers);

  return trackPrivateOperation(async (lifecycleSignal) => {
    const linked = linkAbortSignals([signal, lifecycleSignal]);
    try {
      return await runProtectedRequest({
        url: `${getApiBaseUrl()}${path}`,
        method,
        body,
        headers,
        signal: linked.signal,
        transport,
      });
    } finally {
      linked.dispose();
    }
  });
}

interface ProtectedRequestContext {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  transport: ProtectedTransport;
}

async function runProtectedRequest(context: ProtectedRequestContext): Promise<Response> {
  const { url, method, body, headers, signal, transport } = context;

  const throwIfCancelled = (): void => {
    if (signal.aborted || !isPrivateMediaSessionOpen()) {
      throw createSessionClosedError();
    }
  };

  const send = async (token: string): Promise<Response> => {
    throwIfCancelled();
    let response: Response;
    try {
      response = await transport.fetch(url, {
        method,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body } : {}),
        signal,
        // A redirect would replay the bearer token against whatever origin the
        // response names. There is no legitimate redirect in this contract.
        redirect: 'error',
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw createSessionClosedError();
      }
      throw new ProtectedAssetError('network', NETWORK_MESSAGE);
    }

    // A transport that races the abort and resolves anyway must not hand a live
    // body to a caller that has already given up on it.
    if (signal.aborted) {
      await discardBody(response);
      throw createSessionClosedError();
    }
    return response;
  };

  throwIfCancelled();

  let token = getAccessToken();
  if (token === null) {
    // Nothing to send. One refresh either restores a usable session or proves
    // there is none; both beat firing a request that is guaranteed to 401.
    token = await refreshTokens();
    throwIfCancelled();
    if (token === null) {
      throw new ProtectedAssetError('auth', AUTH_MESSAGE, { status: 401 });
    }
  }

  let response = await send(token);

  if (response.status === 401) {
    await discardBody(response);
    // Checked before choosing what to do about the 401, not after: a sign-out
    // that landed while this was in flight must never be followed by a refresh
    // that writes a fresh token into a store the user just cleared (D20).
    throwIfCancelled();

    const current = getAccessToken();
    let retryToken: string | null;

    if (current === null) {
      // Signed out while this was in flight. Refreshing now would resurrect a
      // session the user just ended, and `Bearer null` is never sent.
      throw new ProtectedAssetError('auth', AUTH_MESSAGE, { status: 401 });
    } else if (current !== token) {
      // Another request already refreshed and this 401 simply resolved late.
      // Retrying with the token that is current costs one request; asking for a
      // second refresh costs one too, and this way the 60-tile case stays at
      // exactly one refresh (D4).
      retryToken = current;
    } else {
      retryToken = await refreshTokens();
    }

    throwIfCancelled();
    if (retryToken === null) {
      throw new ProtectedAssetError('auth', AUTH_MESSAGE, { status: 401 });
    }

    // Exactly one retry. A second 401 is an authentication failure, not a race.
    response = await send(retryToken);
  }

  if (!response.ok) {
    throw await toProtectedAssetError(response);
  }

  return response;
}
