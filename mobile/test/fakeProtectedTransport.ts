/**
 * Fakes for the protected-media seam (D15).
 *
 * Lives under `__tests__` on purpose: production code must not be able to import
 * it. Everything here is a plain object, so a suite can hold two transports at
 * once and drive 60 concurrent requests to settle in a chosen order — neither of
 * which a module-scope `jest.mock('expo/fetch')` can express.
 */

import type {
  ProtectedFetchInit,
  ProtectedFileSink,
  ProtectedFileStore,
  ProtectedTransport,
} from '@/shared/media/protectedAssetTypes';

export interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string>;
  /** Response body. Chunked deliberately so byte-cap paths are reachable. */
  chunks?: Uint8Array[];
  text?: string;
}

export interface FakeResponseHandle {
  response: Response;
  /** True once the body was cancelled rather than read to completion. */
  cancelled(): boolean;
  bodyRead(): boolean;
}

export function bytes(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

export function createFakeResponse(spec: FakeResponseSpec): FakeResponseHandle {
  const headerEntries = Object.entries(spec.headers ?? {}).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const chunks = spec.chunks ? [...spec.chunks] : [];
  let cancelled = false;
  let read = false;

  const body =
    spec.chunks === undefined
      ? null
      : {
          getReader() {
            return {
              async read(): Promise<{ done: boolean; value?: Uint8Array }> {
                read = true;
                const next = chunks.shift();
                return next === undefined ? { done: true } : { done: false, value: next };
              },
              async cancel(): Promise<void> {
                cancelled = true;
                chunks.length = 0;
              },
            };
          },
          async cancel(): Promise<void> {
            cancelled = true;
            chunks.length = 0;
          },
        };

  const response = {
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: {
      get(name: string): string | null {
        const found = headerEntries.find(([key]) => key === name.toLowerCase());
        return found ? found[1] : null;
      },
    },
    body,
    async text(): Promise<string> {
      read = true;
      return spec.text ?? '';
    },
  } as unknown as Response;

  return {
    response,
    cancelled: () => cancelled,
    bodyRead: () => read,
  };
}

/** A JSON error body with the `Content-Length` the bounded parser requires. */
export function jsonErrorResponse(status: number, body: unknown): FakeResponseHandle {
  const text = JSON.stringify(body);
  return createFakeResponse({
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(text.length) },
    text,
  });
}

export function imageResponse(chunks: Uint8Array[], contentType = 'image/webp'): FakeResponseHandle {
  return createFakeResponse({ status: 200, headers: { 'content-type': contentType }, chunks });
}

export interface FakeFetchCall {
  url: string;
  init: ProtectedFetchInit;
  authorization: string | undefined;
}

export interface FakeFetch {
  fetch(url: string, init: ProtectedFetchInit): Promise<Response>;
  calls: FakeFetchCall[];
  authorizations(): (string | undefined)[];
}

export type FakeFetchHandler = (call: FakeFetchCall, index: number) => Promise<Response> | Response;

export function createFakeFetch(handler: FakeFetchHandler): FakeFetch {
  const calls: FakeFetchCall[] = [];

  return {
    calls,
    authorizations: () => calls.map((call) => call.authorization),
    async fetch(url: string, init: ProtectedFetchInit): Promise<Response> {
      const call: FakeFetchCall = { url, init, authorization: init.headers.Authorization };
      const index = calls.length;
      calls.push(call);
      return handler(call, index);
    },
  };
}

interface FakeFileRecord {
  chunks: Uint8Array[];
  closed: boolean;
}

export interface FakeFileStore extends ProtectedFileStore {
  /** Files currently on the fake filesystem, keyed by URI. */
  contents(): Map<string, FakeFileRecord>;
  /** Simulates the OS reclaiming the cache directory entry. */
  reclaim(uri: string): void;
  setAvailableBytes(value: number | null): void;
  purgeCount(): number;
  discarded(): string[];
}

export function createFakeFileStore(namespace = 'fake-protected'): FakeFileStore {
  const files = new Map<string, FakeFileRecord>();
  const discarded: string[] = [];
  let created = 0;
  let purges = 0;
  let available: number | null = 8 * 1024 * 1024 * 1024;

  function removeFile(uri: string): void {
    files.delete(uri);
  }

  return {
    async createSink(fileName: string): Promise<ProtectedFileSink> {
      created += 1;
      const uri = `file:///${namespace}/${created}-${fileName}`;
      const record: FakeFileRecord = { chunks: [], closed: false };
      files.set(uri, record);
      let written = 0;

      return {
        uri,
        async write(chunk: Uint8Array): Promise<void> {
          record.chunks.push(chunk);
          written += chunk.byteLength;
        },
        async close(): Promise<void> {
          record.closed = true;
        },
        bytesWritten: () => written,
        async discard(): Promise<void> {
          discarded.push(uri);
          removeFile(uri);
        },
      };
    },

    async exists(uri: string): Promise<boolean> {
      return files.has(uri);
    },

    async stat(uri: string): Promise<{ bytes: number } | null> {
      const record = files.get(uri);
      if (!record) {
        return null;
      }
      return { bytes: record.chunks.reduce((total, chunk) => total + chunk.byteLength, 0) };
    },

    async discard(uri: string): Promise<void> {
      discarded.push(uri);
      removeFile(uri);
    },

    async purgeAll(): Promise<void> {
      purges += 1;
      files.clear();
    },

    availableBytes: () => available,

    contents: () => files,
    reclaim: (uri: string) => removeFile(uri),
    setAvailableBytes: (value: number | null) => {
      available = value;
    },
    purgeCount: () => purges,
    discarded: () => discarded,
  };
}

export interface FakeTransport extends ProtectedTransport {
  files: FakeFileStore;
  fetches: FakeFetch;
}

export function createFakeTransport(
  handler: FakeFetchHandler,
  files: FakeFileStore = createFakeFileStore(),
): FakeTransport {
  const fetches = createFakeFetch(handler);
  return {
    fetch: fetches.fetch,
    files,
    fetches,
  };
}

/** A promise a test resolves by hand, for ordering concurrent requests. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/** Lets pending microtasks run. */
export async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}
