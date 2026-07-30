/**
 * Session-scoped staging for protected media (D3).
 *
 * `Cache-Control: private, no-store` is an instruction not to *persist*, and the
 * loader honours it in the way that matters: bytes land in the reclaimable cache
 * directory under opaque names, inside a namespace this module purges at
 * startup, at sign-out, and on background. Because what reaches `expo-image` is
 * always a local `file://` URI, `expo-image` never performs a network request
 * for a trip photo and so has nothing of its own to persist — the disk residency
 * that actually exists is the staging file, and its lifecycle is owned here.
 *
 * Releasing the last reference marks an entry evictable rather than deleting it.
 * That is not a convenience: `trip_photo_assets` allows 600 requests/hour, and a
 * 200-photo gallery scrolled down and back up remounts enough tiles to spend
 * roughly 400 of them if every remount re-fetched.
 */

import {
  getPrivateMediaEpoch,
  isPrivateMediaSessionOpen,
  createSessionClosedError,
  linkAbortSignals,
  registerPrivateMediaPurger,
  trackPrivateOperation,
} from './privateMediaLifecycle';
import { fetchProtectedResponse } from './fetchProtectedAsset';
import {
  ProtectedAssetError,
  type ProtectedAssetVariant,
  type ProtectedCacheBucket,
  type ProtectedFileStore,
  type ProtectedTransport,
} from './protectedAssetTypes';
import { createOpaqueFileName, nativeProtectedFileStore, nativeProtectedTransport } from './protectedTransport';

/** Roughly twelve screens of a three-column grid. */
export const THUMBNAIL_CACHE_MAX_ENTRIES = 240;
export const THUMBNAIL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** The viewer only ever mounts the current photo and its two neighbours. */
export const MEDIUM_CACHE_MAX_ENTRIES = 5;
export const MEDIUM_CACHE_MAX_BYTES = 40 * 1024 * 1024;

const CACHE_LIMITS: Record<ProtectedCacheBucket, { maxEntries: number; maxBytes: number }> = {
  thumbnail: { maxEntries: THUMBNAIL_CACHE_MAX_ENTRIES, maxBytes: THUMBNAIL_CACHE_MAX_BYTES },
  medium: { maxEntries: MEDIUM_CACHE_MAX_ENTRIES, maxBytes: MEDIUM_CACHE_MAX_BYTES },
};

const INVALID_CONTENT_MESSAGE = 'This image could not be loaded.';

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

interface CacheEntry {
  assetKey: string;
  uri: string;
  bytes: number;
  bucket: ProtectedCacheBucket;
  /** > 0 pins the entry against LRU eviction. A purge overrides every pin. */
  refCount: number;
  lastUsedAt: number;
  store: ProtectedFileStore;
}

interface InFlightLoad {
  promise: Promise<CacheEntry>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightLoad>();
/**
 * Seeded with the production store so the very first `purgeAll()` of a process
 * finds files a previous process left behind, before anything has been staged.
 */
const knownStores = new Set<ProtectedFileStore>([nativeProtectedFileStore]);

let clock = 0;

function tick(): number {
  clock += 1;
  return clock;
}

export interface AcquiredProtectedAsset {
  /** Local `file://` URI. Safe to hand to `expo-image`. */
  uri: string;
  release(): void;
}

export interface AcquireProtectedAssetOptions {
  /** Logical identity, e.g. `trip-photo:<tripId>:<photoId>:thumbnail`. */
  assetKey: string;
  path: string;
  variant: ProtectedAssetVariant;
  signal?: AbortSignal;
  transport?: ProtectedTransport;
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_CONTENT_TYPE[normalized] ?? '.img';
}

/**
 * @param justCommittedKey Exempt from eviction. A freshly staged entry has a ref
 * count of zero until the caller awaiting it pins it, which would otherwise make
 * the asset that was just fetched the only eviction candidate whenever every
 * other entry in the bucket is pinned — the viewer's exact situation.
 */
async function evictBucket(bucket: ProtectedCacheBucket, justCommittedKey?: string): Promise<void> {
  const limits = CACHE_LIMITS[bucket];
  const inBucket = Array.from(entries.values()).filter((entry) => entry.bucket === bucket);

  let count = inBucket.length;
  let bytes = inBucket.reduce((total, entry) => total + entry.bytes, 0);
  if (count <= limits.maxEntries && bytes <= limits.maxBytes) {
    return;
  }

  const evictable = inBucket
    .filter((entry) => entry.refCount === 0 && entry.assetKey !== justCommittedKey)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);

  for (const entry of evictable) {
    if (count <= limits.maxEntries && bytes <= limits.maxBytes) {
      break;
    }
    entries.delete(entry.assetKey);
    count -= 1;
    bytes -= entry.bytes;
    await entry.store.discard(entry.uri);
  }
}

interface StageOptions {
  assetKey: string;
  path: string;
  variant: ProtectedAssetVariant;
  transport: ProtectedTransport;
  signal: AbortSignal;
  epochAtStart: number;
}

async function stageAsset(options: StageOptions): Promise<CacheEntry> {
  const { assetKey, path, variant, transport, signal, epochAtStart } = options;

  const response = await fetchProtectedResponse({ path, signal, transport });

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.trim().toLowerCase().startsWith('image/')) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, { status: response.status });
  }

  // Both checks are needed. `Content-Length` rejects an oversized body before a
  // single byte is written; the streamed count catches a response that lies or
  // omits the header. The caps sit above the raw-RGB size of each variant, so a
  // legitimate asset is never rejected — only a proxy error page would be.
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > variant.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, { status: response.status });
  }

  const body = response.body;
  if (!body) {
    throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, { status: response.status });
  }

  const sink = await transport.files.createSink(createOpaqueFileName(extensionForContentType(contentType)));
  const reader = body.getReader();
  let received = 0;

  try {
    for (;;) {
      if (signal.aborted || getPrivateMediaEpoch() !== epochAtStart) {
        throw createSessionClosedError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      received += value.byteLength;
      if (received > variant.maxBytes) {
        throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE);
      }
      await sink.write(value);
    }
    await sink.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await sink.discard();
    throw error;
  }

  // Commit barrier. A completion belonging to a session that has already ended
  // must never put private bytes back on disk, so the epoch is re-read after the
  // last await rather than trusted from before it.
  if (signal.aborted || getPrivateMediaEpoch() !== epochAtStart || !isPrivateMediaSessionOpen()) {
    await sink.discard();
    throw createSessionClosedError();
  }

  knownStores.add(transport.files);

  const entry: CacheEntry = {
    assetKey,
    uri: sink.uri,
    bytes: received,
    bucket: variant.bucket,
    refCount: 0,
    lastUsedAt: tick(),
    store: transport.files,
  };
  entries.set(assetKey, entry);
  await evictBucket(variant.bucket, assetKey);

  return entry;
}

function startLoad(options: Omit<StageOptions, 'signal' | 'epochAtStart'>): InFlightLoad {
  const controller = new AbortController();
  const load: InFlightLoad = {
    controller,
    waiters: 0,
    settled: false,
    promise: undefined as unknown as Promise<CacheEntry>,
  };

  load.promise = trackPrivateOperation(async (lifecycleSignal) => {
    const epochAtStart = getPrivateMediaEpoch();
    const linked = linkAbortSignals([controller.signal, lifecycleSignal]);
    try {
      return await stageAsset({ ...options, signal: linked.signal, epochAtStart });
    } finally {
      linked.dispose();
    }
  });

  const finish = (): void => {
    load.settled = true;
    if (inFlight.get(options.assetKey) === load) {
      inFlight.delete(options.assetKey);
    }
  };
  load.promise.then(finish, finish);

  return load;
}

function pin(entry: CacheEntry): AcquiredProtectedAsset {
  entry.refCount += 1;
  entry.lastUsedAt = tick();
  let released = false;

  return {
    uri: entry.uri,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      // Deliberately not deleted here — see the module comment. The entry simply
      // becomes eligible for LRU eviction and stays reusable until then.
      entry.lastUsedAt = tick();
    },
  };
}

/**
 * Resolves to a local file URI for a protected asset, fetching it only when it is
 * not already staged. Concurrent callers for the same `assetKey` share one
 * request.
 */
export async function acquireProtectedAsset(
  options: AcquireProtectedAssetOptions,
): Promise<AcquiredProtectedAsset> {
  const { assetKey, path, variant, signal, transport = nativeProtectedTransport } = options;

  // Check before the cache lookup. A shutdown closes the gate synchronously but
  // purges files asynchronously; without this guard, a cache hit in that small
  // window could hand private bytes to a signed-out/backgrounded caller.
  if (signal?.aborted || !isPrivateMediaSessionOpen()) {
    throw createSessionClosedError();
  }

  const cached = entries.get(assetKey);
  if (cached) {
    // The cache directory is reclaimable, so a registry hit is a hypothesis
    // until the file is confirmed to still be there.
    if (await cached.store.exists(cached.uri)) {
      return pin(cached);
    }
    entries.delete(assetKey);
  }

  let load = inFlight.get(assetKey);
  if (!load) {
    load = startLoad({ assetKey, path, variant, transport });
    inFlight.set(assetKey, load);
  }

  load.waiters += 1;
  let detachAbort = (): void => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!signal) {
      return;
    }
    const onAbort = (): void => reject(createSessionClosedError());
    signal.addEventListener('abort', onAbort);
    detachAbort = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    const entry = await Promise.race([load.promise, cancellation]);
    return pin(entry);
  } finally {
    detachAbort();
    load.waiters -= 1;
    // Only the departure of the *last* interested caller cancels a shared load;
    // one tile scrolling out of the window must not blank its neighbours.
    if (load.waiters === 0 && !load.settled) {
      load.controller.abort();
    }
  }
}

async function dropEntry(entry: CacheEntry): Promise<void> {
  entries.delete(entry.assetKey);
  await entry.store.discard(entry.uri);
}

/**
 * Forgets one asset completely: aborts a load in progress, drops the registry
 * entry and deletes the file.
 *
 * This is what a delete or a `PHOTO_NOT_FOUND` must call. `release()` is not a
 * substitute — by design it leaves the file reusable, which for a photo that no
 * longer exists on the server is exactly wrong.
 */
export async function invalidateProtectedAsset(assetKey: string): Promise<void> {
  const load = inFlight.get(assetKey);
  if (load) {
    inFlight.delete(assetKey);
    load.controller.abort();
  }
  const entry = entries.get(assetKey);
  if (entry) {
    await dropEntry(entry);
  }
}

/**
 * Invalidates every asset whose key starts with `prefix` — the trip-level form
 * used when membership is lost (`TRIP_NOT_FOUND`).
 */
export async function invalidateProtectedAssets(prefix: string): Promise<void> {
  for (const [assetKey, load] of Array.from(inFlight.entries())) {
    if (assetKey.startsWith(prefix)) {
      inFlight.delete(assetKey);
      load.controller.abort();
    }
  }
  for (const entry of Array.from(entries.values())) {
    if (entry.assetKey.startsWith(prefix)) {
      await dropEntry(entry);
    }
  }
}

/**
 * Drops all staging metadata and deletes both this process's files and any left
 * by a previous one. Registered with the lifecycle, so sign-out, sign-in and
 * background all reach it through the serialized purge queue.
 */
export async function purgeProtectedAssets(): Promise<void> {
  entries.clear();
  inFlight.clear();
  for (const store of Array.from(knownStores)) {
    await store.purgeAll();
  }
}

registerPrivateMediaPurger('protected-assets', purgeProtectedAssets);

export function __resetProtectedAssetStoreForTests(): void {
  entries.clear();
  inFlight.clear();
  knownStores.clear();
  knownStores.add(nativeProtectedFileStore);
  clock = 0;
}

/** Test-only view of the registry. */
export function __getProtectedAssetEntriesForTests(): {
  assetKey: string;
  uri: string;
  bytes: number;
  bucket: ProtectedCacheBucket;
  refCount: number;
}[] {
  return Array.from(entries.values()).map(({ assetKey, uri, bytes, bucket, refCount }) => ({
    assetKey,
    uri,
    bytes,
    bucket,
    refCount,
  }));
}
