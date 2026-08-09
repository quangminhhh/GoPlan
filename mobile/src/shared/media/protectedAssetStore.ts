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
  type AcquireProtectedAssetOptions,
  type ProtectedAssetVariant,
  type ProtectedCacheBucket,
  type ProtectedFileSink,
  type ProtectedFileStore,
  type ProtectedTransport,
} from './protectedAssetTypes';
import { createOpaqueFileName, nativeProtectedFileStore, nativeProtectedTransport } from './protectedTransport';

export type { AcquireProtectedAssetOptions } from './protectedAssetTypes';

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
  invalidationPrefix: string;
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
  invalidationPrefix: string;
  waiters: number;
  settled: boolean;
}

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightLoad>();
/**
 * Explicit invalidation is a per-key hard boundary. Session epochs protect the
 * whole namespace, while this version prevents an older cache check or staging
 * operation from resurrecting one photo after delete/PHOTO_NOT_FOUND removed it.
 *
 * Versions deliberately survive a normal purge: clearing them would create an
 * ABA window where an old `0` becomes current `0` again in a later session.
 */
const assetVersions = new Map<string, number>();
/**
 * Trip-wide invalidation is a separate monotonic fence. It must move even when
 * no matching key has reached either registry yet, otherwise a stage that was
 * already between awaits could commit after a seemingly empty invalidation.
 */
const prefixVersions = new Map<string, number>();
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

function assetVersion(assetKey: string): number {
  return assetVersions.get(assetKey) ?? 0;
}

function invalidateAssetVersion(assetKey: string): void {
  assetVersions.set(assetKey, assetVersion(assetKey) + 1);
}

function prefixVersion(prefix: string): number {
  return prefixVersions.get(prefix) ?? 0;
}

function invalidatePrefixVersion(prefix: string): void {
  prefixVersions.set(prefix, prefixVersion(prefix) + 1);
}

export interface AcquiredProtectedAsset {
  /** Local `file://` URI. Safe to hand to `expo-image`. */
  uri: string;
  release(): void;
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

  const initialBytes = inBucket.reduce((total, entry) => total + entry.bytes, 0);
  if (inBucket.length <= limits.maxEntries && initialBytes <= limits.maxBytes) {
    return;
  }

  const evictable = inBucket
    .filter(
      (entry) =>
        entry.refCount === 0 &&
        entry.assetKey !== justCommittedKey &&
        !inFlight.has(entry.assetKey),
    )
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);

  for (const entry of evictable) {
    const currentEntries = Array.from(entries.values()).filter(
      (candidate) => candidate.bucket === bucket,
    );
    const currentBytes = currentEntries.reduce(
      (total, candidate) => total + candidate.bytes,
      0,
    );
    if (currentEntries.length <= limits.maxEntries && currentBytes <= limits.maxBytes) {
      break;
    }

    // `discard()` yields. A cache hit can reserve a later candidate while an
    // earlier file is being removed, so the snapshot above is never authority
    // for deletion after an await.
    if (
      entries.get(entry.assetKey) !== entry ||
      entry.refCount !== 0 ||
      inFlight.has(entry.assetKey)
    ) {
      continue;
    }
    entries.delete(entry.assetKey);
    await entry.store.discard(entry.uri);
  }
}

interface StageOptions {
  assetKey: string;
  invalidationPrefix: string;
  path: string;
  variant: ProtectedAssetVariant;
  transport: ProtectedTransport;
  signal: AbortSignal;
  epochAtStart: number;
  assetVersionAtStart: number;
  prefixVersionAtStart: number;
}

function readStreamChunk(
  signal: AbortSignal,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(createSessionClosedError());
  }

  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(createSessionClosedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

async function stageAsset(options: StageOptions): Promise<CacheEntry> {
  const {
    assetKey,
    invalidationPrefix,
    path,
    variant,
    transport,
    signal,
    epochAtStart,
    assetVersionAtStart,
    prefixVersionAtStart,
  } = options;

  const response = await fetchProtectedResponse({ path, signal, transport });
  const body = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sink: ProtectedFileSink | null = null;
  let detachAbort = (): void => {};
  let received = 0;
  const throwIfInvalidated = (): void => {
    if (
      signal.aborted ||
      getPrivateMediaEpoch() !== epochAtStart ||
      assetVersion(assetKey) !== assetVersionAtStart ||
      prefixVersion(invalidationPrefix) !== prefixVersionAtStart ||
      !isPrivateMediaSessionOpen()
    ) {
      throw createSessionClosedError();
    }
  };

  try {
    // Own the response body before the first post-fetch boundary. If shutdown
    // landed as the headers resolved, this catch still has something to cancel.
    throwIfInvalidated();

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.trim().toLowerCase().startsWith('image/')) {
      throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, {
        status: response.status,
      });
    }

    // Both checks are needed. `Content-Length` rejects an oversized body before
    // a byte is written; the streamed count catches a lying/absent header.
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > variant.maxBytes) {
      throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, {
        status: response.status,
      });
    }
    if (!body) {
      throw new ProtectedAssetError('invalidContent', INVALID_CONTENT_MESSAGE, {
        status: response.status,
      });
    }

    // Lock and observe the body before awaiting filesystem work. `createSink`
    // can reject or finish after an abort; in both cases this scope still owns
    // the reader and can cancel it, then discard any late sink it receives.
    reader = body.getReader();
    const ownedReader = reader;
    const cancelReader = (): void => {
      void ownedReader.cancel().catch(() => undefined);
    };
    if (signal.aborted) {
      cancelReader();
    } else {
      signal.addEventListener('abort', cancelReader);
      detachAbort = () => signal.removeEventListener('abort', cancelReader);
    }
    throwIfInvalidated();

    sink = await transport.files.createSink(
      createOpaqueFileName(extensionForContentType(contentType)),
    );
    throwIfInvalidated();

    for (;;) {
      throwIfInvalidated();
      const { done, value } = await readStreamChunk(signal, ownedReader);
      throwIfInvalidated();
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
      throwIfInvalidated();
    }
    await sink.close();
    throwIfInvalidated();
  } catch (error) {
    if (reader) {
      await reader.cancel().catch(() => undefined);
    } else {
      await body?.cancel().catch(() => undefined);
    }
    await sink?.discard().catch(() => undefined);
    throw error;
  } finally {
    detachAbort();
  }

  // The successful stream path necessarily created a sink. Keep this explicit
  // instead of asserting away the nullable ownership state above.
  if (!sink) {
    throw new ProtectedAssetError('server', INVALID_CONTENT_MESSAGE);
  }

  // Commit barrier. A completion belonging to a session that has already ended
  // or an asset explicitly invalidated must never put private bytes back on
  // disk, so every boundary is re-read after the last await.
  try {
    throwIfInvalidated();
  } catch (error) {
    await sink.discard().catch(() => undefined);
    throw error;
  }

  knownStores.add(transport.files);

  const entry: CacheEntry = {
    assetKey,
    invalidationPrefix,
    uri: sink.uri,
    bytes: received,
    bucket: variant.bucket,
    refCount: 0,
    lastUsedAt: tick(),
    store: transport.files,
  };
  entries.set(assetKey, entry);

  try {
    await evictBucket(variant.bucket, assetKey);
    // Eviction yields. Explicit invalidation may have removed this entry and a
    // fresh request may already have installed a replacement under the key.
    // Never return/pin the old URI, and never delete the replacement.
    throwIfInvalidated();
    if (entries.get(assetKey) !== entry) {
      throw createSessionClosedError();
    }
  } catch (error) {
    if (entries.get(assetKey) === entry) {
      entries.delete(assetKey);
    }
    await sink.discard().catch(() => undefined);
    throw error;
  }

  return entry;
}

function startLoad(
  options: Omit<
    StageOptions,
    'signal' | 'epochAtStart' | 'assetVersionAtStart' | 'prefixVersionAtStart'
  >,
): InFlightLoad {
  const controller = new AbortController();
  const versionAtStart = assetVersion(options.assetKey);
  const prefixAtStart = prefixVersion(options.invalidationPrefix);
  const load: InFlightLoad = {
    controller,
    invalidationPrefix: options.invalidationPrefix,
    waiters: 0,
    settled: false,
    promise: undefined as unknown as Promise<CacheEntry>,
  };

  load.promise = trackPrivateOperation(async (lifecycleSignal) => {
    const epochAtStart = getPrivateMediaEpoch();
    const linked = linkAbortSignals([controller.signal, lifecycleSignal]);
    try {
      return await stageAsset({
        ...options,
        signal: linked.signal,
        epochAtStart,
        assetVersionAtStart: versionAtStart,
        prefixVersionAtStart: prefixAtStart,
      });
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

function assertAcquireStillCurrent(
  assetKey: string,
  invalidationPrefix: string,
  requestEpoch: number,
  requestAssetVersion: number,
  requestPrefixVersion: number,
  signal?: AbortSignal,
): void {
  if (
    signal?.aborted ||
    !isPrivateMediaSessionOpen() ||
    getPrivateMediaEpoch() !== requestEpoch ||
    assetVersion(assetKey) !== requestAssetVersion ||
    prefixVersion(invalidationPrefix) !== requestPrefixVersion
  ) {
    throw createSessionClosedError();
  }
}

function pin(entry: CacheEntry, alreadyReserved = false): AcquiredProtectedAsset {
  if (!alreadyReserved) {
    entry.refCount += 1;
  }
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
      // A bucket can exceed its caps while every entry is pinned. Releasing the
      // last consumer is the first moment the LRU can restore the budget.
      void evictBucket(entry.bucket).catch(() => undefined);
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
  const {
    assetKey,
    invalidationPrefix,
    path,
    variant,
    signal,
    transport = nativeProtectedTransport,
  } = options;

  // Check before the cache lookup. A shutdown closes the gate synchronously but
  // purges files asynchronously; without this guard, a cache hit in that small
  // window could hand private bytes to a signed-out/backgrounded caller.
  if (signal?.aborted || !isPrivateMediaSessionOpen()) {
    throw createSessionClosedError();
  }

  const requestEpoch = getPrivateMediaEpoch();
  const requestAssetVersion = assetVersion(assetKey);
  const requestPrefixVersion = prefixVersion(invalidationPrefix);
  for (;;) {
    assertAcquireStillCurrent(
      assetKey,
      invalidationPrefix,
      requestEpoch,
      requestAssetVersion,
      requestPrefixVersion,
      signal,
    );

    const cached = entries.get(assetKey);
    if (!cached) {
      break;
    }
    if (cached.invalidationPrefix !== invalidationPrefix) {
      throw createSessionClosedError();
    }

    // The cache directory is reclaimable, so a registry hit is a hypothesis
    // until the file is confirmed to still be there. Reserve it before the
    // asynchronous check so a release-triggered LRU pass cannot delete the file
    // between `exists()` and `pin()`.
    cached.refCount += 1;
    let exists: boolean;
    try {
      exists = await cached.store.exists(cached.uri);
    } catch (error) {
      cached.refCount = Math.max(0, cached.refCount - 1);
      throw error;
    }

    try {
      // A false result is just as asynchronous as a true one. Check the session
      // and per-key boundaries before it can fall through into a fresh fetch.
      assertAcquireStillCurrent(
        assetKey,
        invalidationPrefix,
        requestEpoch,
        requestAssetVersion,
        requestPrefixVersion,
        signal,
      );
    } catch (error) {
      cached.refCount = Math.max(0, cached.refCount - 1);
      throw error;
    }

    // `exists()` yields. An explicit invalidation may remove this entry and a
    // retry may commit a replacement under the same key before the check
    // completes. Never pin the stale URI or delete the replacement.
    if (entries.get(assetKey) !== cached) {
      cached.refCount = Math.max(0, cached.refCount - 1);
      continue;
    }

    if (exists) {
      return pin(cached, true);
    }
    cached.refCount = Math.max(0, cached.refCount - 1);
    // No await separates the identity check above from this delete.
    entries.delete(assetKey);
    // Loop through the boundary again before a missing cache entry can start a
    // network load. A concurrent waiter may also have installed a replacement.
  }

  assertAcquireStillCurrent(
    assetKey,
    invalidationPrefix,
    requestEpoch,
    requestAssetVersion,
    requestPrefixVersion,
    signal,
  );
  let load = inFlight.get(assetKey);
  if (load && load.invalidationPrefix !== invalidationPrefix) {
    throw createSessionClosedError();
  }
  if (!load) {
    load = startLoad({ assetKey, invalidationPrefix, path, variant, transport });
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
    assertAcquireStillCurrent(
      assetKey,
      invalidationPrefix,
      requestEpoch,
      requestAssetVersion,
      requestPrefixVersion,
      signal,
    );
    if (entries.get(assetKey) !== entry) {
      throw createSessionClosedError();
    }
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

/**
 * Forgets one asset completely: aborts a load in progress, drops the registry
 * entry and deletes the file.
 *
 * This is what a delete or a `PHOTO_NOT_FOUND` must call. `release()` is not a
 * substitute — by design it leaves the file reusable, which for a photo that no
 * longer exists on the server is exactly wrong.
 */
export async function invalidateProtectedAsset(assetKey: string): Promise<void> {
  invalidateAssetVersion(assetKey);
  const load = inFlight.get(assetKey);
  if (load && inFlight.get(assetKey) === load) {
    inFlight.delete(assetKey);
  }
  const entry = entries.get(assetKey);
  if (entry && entries.get(assetKey) === entry) {
    entries.delete(assetKey);
  }

  load?.controller.abort();
  if (entry) {
    await entry.store.discard(entry.uri);
  }
}

/**
 * Invalidates every asset registered under the feature-supplied canonical
 * `prefix` — the trip-level form used when membership is lost.
 */
export async function invalidateProtectedAssets(prefix: string): Promise<void> {
  // This entire front half is synchronous. A later acquire therefore sees the
  // new prefix generation and neither registry can expose an old object while
  // its filesystem cleanup is awaiting native I/O.
  invalidatePrefixVersion(prefix);

  const detachedLoads = Array.from(inFlight.entries()).filter(
    ([, load]) => load.invalidationPrefix === prefix,
  );
  const detachedEntries = Array.from(entries.entries()).filter(
    ([, entry]) => entry.invalidationPrefix === prefix,
  );

  const detachedKeys = new Set<string>();
  for (const [assetKey, load] of detachedLoads) {
    if (inFlight.get(assetKey) === load) {
      inFlight.delete(assetKey);
      detachedKeys.add(assetKey);
    }
  }
  for (const [assetKey, entry] of detachedEntries) {
    if (entries.get(assetKey) === entry) {
      entries.delete(assetKey);
      detachedKeys.add(assetKey);
    }
  }
  for (const assetKey of detachedKeys) {
    invalidateAssetVersion(assetKey);
  }
  for (const [, load] of detachedLoads) {
    load.controller.abort();
  }

  await Promise.allSettled(
    detachedEntries.map(([, entry]) => entry.store.discard(entry.uri)),
  );
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
  assetVersions.clear();
  prefixVersions.clear();
  knownStores.clear();
  knownStores.add(nativeProtectedFileStore);
  clock = 0;
}

/** Test-only view of the registry. */
export function __getProtectedAssetEntriesForTests(): {
  assetKey: string;
  invalidationPrefix: string;
  uri: string;
  bytes: number;
  bucket: ProtectedCacheBucket;
  refCount: number;
}[] {
  return Array.from(entries.values()).map(({
    assetKey,
    invalidationPrefix,
    uri,
    bytes,
    bucket,
    refCount,
  }) => ({
    assetKey,
    invalidationPrefix,
    uri,
    bytes,
    bucket,
    refCount,
  }));
}
