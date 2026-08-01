/**
 * Contracts for loading member-only media the backend serves behind
 * `IsAuthenticated` + membership with `Cache-Control: private, no-store`.
 *
 * Consumers: trip photos (issue #64) today, memory posters (#65) next. This is
 * deliberately a types-only module: nothing here may import a native module, so
 * every unit test can build the whole flow out of fakes. The one production
 * implementation lives in protectedTransport.ts.
 */

/**
 * Staging files are capped per bucket rather than globally: a grid holds a few
 * hundred small thumbnails at once, while the viewer only ever mounts three
 * medium variants and each is two orders of magnitude larger.
 */
export type ProtectedCacheBucket = 'thumbnail' | 'medium';

export interface ProtectedAssetVariant {
  /** Stable identifier; appears in cache keys, never in a log line. */
  readonly name: string;
  readonly bucket: ProtectedCacheBucket;
  /**
   * Hard ceiling on the response body, enforced against `Content-Length` when
   * the server sends one and against streamed bytes when it does not. Every
   * variant must declare a finite number — `Infinity` would turn a broken proxy
   * response into an unbounded write into the cache directory.
   */
  readonly maxBytes: number;
}

export type ProtectedAssetErrorKind =
  /** 401 that survived one refresh-and-retry, or a signed-out session. */
  | 'auth'
  /** 404. The owner must branch on `errorCode` before acting — see D18. */
  | 'notFound'
  /** 403. */
  | 'forbidden'
  /** 429 on any of the photo throttle scopes. */
  | 'throttled'
  /**
   * A deterministic 4xx that is neither auth nor throttling — 400 and 409. The
   * server has decided; the owner reads `errorCode` and stops rather than
   * retrying.
   */
  | 'request'
  /** Transport failure: no status was ever received. */
  | 'network'
  /** 5xx, or a 2xx whose body could not be used. */
  | 'server'
  /** 2xx with the wrong content type, an oversized body, or a truncated write. */
  | 'invalidContent'
  /**
   * Caller abort, sign-out, or a session boundary. Never user-facing: an
   * operation the app itself cancelled is not an error the user should read.
   */
  | 'cancelled';

export interface ProtectedAssetErrorOptions {
  status?: number;
  /** `error_code` from the DRF body. Absent on field-error bodies. */
  errorCode?: string;
}

/**
 * The only error type protected media throws.
 *
 * `message` is always safe to display and safe to log: constructors must never
 * be handed a URL, an `Authorization` header, or a token. `Error.toString()`
 * is `name: message`, so that invariant covers stringification too.
 */
export class ProtectedAssetError extends Error {
  readonly kind: ProtectedAssetErrorKind;
  readonly status?: number;
  readonly errorCode?: string;

  constructor(kind: ProtectedAssetErrorKind, message: string, options: ProtectedAssetErrorOptions = {}) {
    super(message);
    this.name = 'ProtectedAssetError';
    this.kind = kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.errorCode !== undefined) {
      this.errorCode = options.errorCode;
    }
  }
}

export function isProtectedAssetError(error: unknown): error is ProtectedAssetError {
  return error instanceof ProtectedAssetError;
}

/** True for the outcomes the UI must swallow rather than render. */
export function isCancelledProtectedAssetError(error: unknown): boolean {
  return isProtectedAssetError(error) && error.kind === 'cancelled';
}

export interface ProtectedFetchInit {
  method: 'GET' | 'POST';
  /** Includes the `Authorization` header this module owns. */
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /**
   * Always `'error'`. A redirect would carry the bearer token to whatever origin
   * the response names, which is exactly the leak the same-origin path check
   * exists to prevent.
   */
  redirect: 'error';
}

/**
 * The only boundary that touches native code in the protected-media flow.
 *
 * Every entry point takes one of these as an optional argument defaulting to the
 * production implementation, following the `ImageCodec` seam issue #62
 * established. Module-scope `jest.mock('expo/fetch')` cannot express the tests
 * this feature needs — 60 concurrent 401s resolving in a chosen order, a purge
 * landing between a write and its commit, a cache directory the OS reclaimed —
 * because those need two different transports inside one test file.
 */
export interface ProtectedTransport {
  fetch(url: string, init: ProtectedFetchInit): Promise<Response>;
  files: ProtectedFileStore;
}

export interface AcquireProtectedAssetOptions {
  /** Logical identity, e.g. `trip-photo:<tripId>:<photoId>:thumbnail`. */
  assetKey: string;
  /**
   * Canonical owner scope supplied by the feature. The cache never parses an
   * opaque asset key to guess which trip-level invalidation fence owns it.
   */
  invalidationPrefix: string;
  path: string;
  variant: ProtectedAssetVariant;
  signal?: AbortSignal;
  transport?: ProtectedTransport;
}

export interface ProtectedFileStore {
  /**
   * Creates a sink inside this store's own namespace.
   *
   * Rejection is atomic: because no URI has escaped to the caller yet, the
   * implementation must remove any file it created before rejecting.
   */
  createSink(fileName: string): Promise<ProtectedFileSink>;
  /** The cache directory can be reclaimed by the OS between two acquires. */
  exists(uri: string): Promise<boolean>;
  stat(uri: string): Promise<{ bytes: number } | null>;
  /** Best-effort and idempotent: a missing file is a success. */
  discard(uri: string): Promise<void>;
  /** Deletes the whole namespace, including files left by a previous process. */
  purgeAll(): Promise<void>;
  /** Free bytes on the volume; `null` when the platform cannot report it. */
  availableBytes(): number | null;
}

/**
 * A file being written one chunk at a time.
 *
 * Chunk-at-a-time rather than `response.body.pipeTo(sink.writable)` because two
 * requirements cannot be expressed through `pipeTo`: a per-variant byte ceiling
 * that has to cancel the stream and discard the partial file the moment it is
 * crossed (§1.3), and the periodic free-disk check a streamed photo save needs
 * (D21). The native mechanism underneath is still `File.writableStream()` — this
 * only moves the loop into JavaScript, where the abort signal is observable
 * between chunks.
 */
export interface ProtectedFileSink {
  readonly uri: string;
  write(chunk: Uint8Array): Promise<void>;
  /** Flushes and closes. A sink that is discarded instead is never closed. */
  close(): Promise<void>;
  /**
   * Bytes accepted by `write` so far.
   *
   * Counted here rather than read back off the filesystem: a `File.size` poll
   * races the native writer's own flushing, and progress that goes backwards is
   * worse than progress that is one chunk optimistic.
   */
  bytesWritten(): number;
  /** Best-effort; must never replace the error that caused the discard. */
  discard(): Promise<void>;
}
