import { setAccessToken } from '@/shared/api/token-store';
import {
  __getProtectedAssetEntriesForTests,
  __resetProtectedAssetStoreForTests,
  acquireProtectedAsset,
  invalidateProtectedAsset,
  invalidateProtectedAssets,
  MEDIUM_CACHE_MAX_BYTES,
  MEDIUM_CACHE_MAX_ENTRIES,
} from '../protectedAssetStore';
import {
  __resetPrivateMediaLifecycleForTests,
  beginPrivateMediaShutdown,
  flushPrivateMediaPurge,
  startPrivateMediaSession,
  suspendPrivateMediaSession,
  waitForPrivateNetworkIdle,
} from '../privateMediaLifecycle';
import type { ProtectedAssetVariant } from '../protectedAssetTypes';
import {
  bytes,
  createDeferred,
  createFakeResponse,
  createFakeTransport,
  flushMicrotasks,
  imageResponse,
} from '@test/fakeProtectedTransport';

jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(async () => 'token'),
}));

const THUMBNAIL: ProtectedAssetVariant = {
  name: 'thumbnail',
  bucket: 'thumbnail',
  maxBytes: 4 * 1024 * 1024,
};
const MEDIUM: ProtectedAssetVariant = { name: 'medium', bucket: 'medium', maxBytes: 32 * 1024 * 1024 };

function thumbnailPath(photoId: string): string {
  return `/trips/trip-1/photos/${photoId}/thumbnail`;
}

function thumbnailKey(photoId: string): string {
  return `trip-photo:trip-1:${photoId}:thumbnail`;
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetPrivateMediaLifecycleForTests();
  __resetProtectedAssetStoreForTests();
  setAccessToken('token');
  await startPrivateMediaSession();
});

afterEach(() => {
  setAccessToken(null);
});

describe('staging and reuse', () => {
  it('stages a response into an opaque cache file and hands back a local uri', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(64), bytes(64)]).response);

    const asset = await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });

    expect(asset.uri.startsWith('file:///')).toBe(true);
    // The file name must not describe what the user was looking at.
    expect(asset.uri).not.toContain('trip-1');
    expect(asset.uri).not.toContain('photo-1');
    expect(asset.uri).not.toContain('thumbnail');
    expect(transport.files.contents().size).toBe(1);
  });

  it('de-duplicates concurrent loads of the same key into one request', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(32)]).response;
    });

    const pending = Array.from({ length: 8 }, () =>
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    );
    await flushMicrotasks();
    gate.resolve();
    const assets = await Promise.all(pending);

    expect(transport.fetches.calls).toHaveLength(1);
    expect(new Set(assets.map((asset) => asset.uri)).size).toBe(1);
    expect(__getProtectedAssetEntriesForTests()[0].refCount).toBe(8);
  });

  it('reuses a released entry instead of re-fetching it (D3 throttle budget)', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(32)]).response);
    const options = {
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    };

    const first = await acquireProtectedAsset(options);
    first.release();
    // Releasing the last reference makes the entry evictable, not deleted — this
    // is what keeps a scroll-down-and-back-up from spending the asset budget.
    expect(transport.files.contents().size).toBe(1);

    const second = await acquireProtectedAsset(options);

    expect(transport.fetches.calls).toHaveLength(1);
    expect(second.uri).toBe(first.uri);
  });

  it('re-fetches when the OS has reclaimed the staged file', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(32)]).response);
    const options = {
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    };

    const first = await acquireProtectedAsset(options);
    first.release();
    transport.files.reclaim(first.uri);

    const second = await acquireProtectedAsset(options);

    expect(transport.fetches.calls).toHaveLength(2);
    expect(second.uri).not.toBe(first.uri);
  });

  it.each([true, false])(
    'rejects a stale exists() result of %s without disturbing its replacement',
    async (staleExists) => {
      const transport = createFakeTransport(() => imageResponse([bytes(32)]).response);
      const options = {
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      };
      const first = await acquireProtectedAsset(options);
      first.release();

      const existsStarted = createDeferred<void>();
      const staleExistsResult = createDeferred<boolean>();
      const originalExists = transport.files.exists.bind(transport.files);
      let existsCalls = 0;
      transport.files.exists = async (uri: string) => {
        existsCalls += 1;
        if (existsCalls === 1) {
          existsStarted.resolve();
          return staleExistsResult.promise;
        }
        return originalExists(uri);
      };

      const pendingCacheHit = acquireProtectedAsset(options);
      await existsStarted.promise;
      await invalidateProtectedAsset(options.assetKey);
      const replacement = await acquireProtectedAsset(options);

      staleExistsResult.resolve(staleExists);
      await expect(pendingCacheHit).rejects.toMatchObject({ kind: 'cancelled' });

      expect(transport.fetches.calls).toHaveLength(2);
      expect(await originalExists(first.uri)).toBe(false);
      expect(await originalExists(replacement.uri)).toBe(true);
      expect(__getProtectedAssetEntriesForTests()).toEqual([
        expect.objectContaining({ assetKey: options.assetKey, refCount: 1, uri: replacement.uri }),
      ]);

      replacement.release();
    },
  );

  it('requests exactly the path it was given', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(32)]).response);

    await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-9'),
      path: thumbnailPath('photo-9'),
      variant: THUMBNAIL,
      transport,
    });

    expect(transport.fetches.calls[0].url).toBe(
      'http://testserver:8000/api/trips/trip-1/photos/photo-9/thumbnail',
    );
  });
});

describe('response validation', () => {
  it('rejects a success response that is not an image', async () => {
    const transport = createFakeTransport(
      () =>
        createFakeResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          chunks: [bytes(32)],
        }).response,
    );

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    ).rejects.toMatchObject({ kind: 'invalidContent' });
    expect(transport.files.contents().size).toBe(0);
  });

  it('rejects an oversized body declared by content-length before writing a byte', async () => {
    const transport = createFakeTransport(
      () =>
        createFakeResponse({
          status: 200,
          headers: { 'content-type': 'image/webp', 'content-length': String(THUMBNAIL.maxBytes + 1) },
          chunks: [bytes(32)],
        }).response,
    );

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    ).rejects.toMatchObject({ kind: 'invalidContent' });
    expect(transport.files.contents().size).toBe(0);
  });

  it('cancels the stream and discards the partial file when a body exceeds the cap without a length', async () => {
    const small: ProtectedAssetVariant = { name: 'tiny', bucket: 'thumbnail', maxBytes: 100 };
    const transport = createFakeTransport(() => imageResponse([bytes(64), bytes(64)]).response);

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: small,
        transport,
      }),
    ).rejects.toMatchObject({ kind: 'invalidContent' });

    expect(transport.files.contents().size).toBe(0);
    expect(transport.files.discarded()).toHaveLength(1);
  });

  it('cancels an owned response body when createSink rejects before streaming starts', async () => {
    const response = imageResponse([bytes(32)]);
    const transport = createFakeTransport(() => response.response);
    transport.files.createSink = jest.fn(async () => {
      throw new Error('sink creation failed');
    });

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    ).rejects.toThrow('sink creation failed');

    expect(response.cancelled()).toBe(true);
    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
  });

  it('cancels the body immediately and discards a sink that resolves after caller abort', async () => {
    const response = imageResponse([bytes(32)]);
    const transport = createFakeTransport(() => response.response);
    const sinkStarted = createDeferred<void>();
    const allowSink = createDeferred<void>();
    const createSink = transport.files.createSink.bind(transport.files);
    transport.files.createSink = async (fileName: string) => {
      sinkStarted.resolve();
      await allowSink.promise;
      return createSink(fileName);
    };
    const controller = new AbortController();

    const pending = acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      signal: controller.signal,
      transport,
    });
    await sinkStarted.promise;

    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(response.cancelled()).toBe(true);

    allowSink.resolve();
    await waitForPrivateNetworkIdle();

    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
  });
});

describe('LRU caps', () => {
  it('evicts the least recently used unpinned entry once the entry cap is passed', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES + 2; index += 1) {
      const asset = await acquireProtectedAsset({
        assetKey: `trip-photo:trip-1:photo-${index}:medium`,
        path: `/trips/trip-1/photos/photo-${index}/medium`,
        variant: MEDIUM,
        transport,
      });
      asset.release();
    }

    const keys = __getProtectedAssetEntriesForTests().map((entry) => entry.assetKey);
    expect(keys).toHaveLength(MEDIUM_CACHE_MAX_ENTRIES);
    expect(keys).not.toContain('trip-photo:trip-1:photo-0:medium');
    expect(keys).toContain(`trip-photo:trip-1:photo-${MEDIUM_CACHE_MAX_ENTRIES + 1}:medium`);
  });

  it('never evicts a pinned entry', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES + 2; index += 1) {
      // No release: every entry stays referenced by a mounted consumer.
      await acquireProtectedAsset({
        assetKey: `trip-photo:trip-1:photo-${index}:medium`,
        path: `/trips/trip-1/photos/photo-${index}/medium`,
        variant: MEDIUM,
        transport,
      });
    }

    expect(__getProtectedAssetEntriesForTests()).toHaveLength(MEDIUM_CACHE_MAX_ENTRIES + 2);
  });

  it('rebalances an over-cap bucket when pinned entries are released', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    const pinned = [];

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES + 2; index += 1) {
      pinned.push(
        await acquireProtectedAsset({
          assetKey: `trip-photo:trip-1:photo-${index}:medium`,
          path: `/trips/trip-1/photos/photo-${index}/medium`,
          variant: MEDIUM,
          transport,
        }),
      );
    }
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(MEDIUM_CACHE_MAX_ENTRIES + 2);

    for (const asset of pinned) {
      asset.release();
    }
    await flushMicrotasks();

    expect(__getProtectedAssetEntriesForTests()).toHaveLength(MEDIUM_CACHE_MAX_ENTRIES);
  });

  it('does not evict an entry reserved by a cache hit while an earlier discard awaits', async () => {
    const entryBytes = MEDIUM_CACHE_MAX_BYTES / MEDIUM_CACHE_MAX_ENTRIES;
    const transport = createFakeTransport((_call, index) =>
      imageResponse([bytes(index < MEDIUM_CACHE_MAX_ENTRIES ? entryBytes : entryBytes * 2)]).response,
    );

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES; index += 1) {
      const asset = await acquireProtectedAsset({
        assetKey: `trip-photo:trip-1:photo-${index}:medium`,
        path: `/trips/trip-1/photos/photo-${index}/medium`,
        variant: MEDIUM,
        transport,
      });
      asset.release();
    }

    const firstDiscardStarted = createDeferred<void>();
    const releaseFirstDiscard = createDeferred<void>();
    const discard = transport.files.discard.bind(transport.files);
    let discardCount = 0;
    transport.files.discard = async (uri: string) => {
      discardCount += 1;
      if (discardCount === 1) {
        firstDiscardStarted.resolve();
        await releaseFirstDiscard.promise;
      }
      await discard(uri);
    };

    const overCap = acquireProtectedAsset({
      assetKey: 'trip-photo:trip-1:photo-new:medium',
      path: '/trips/trip-1/photos/photo-new/medium',
      variant: MEDIUM,
      transport,
    });
    await firstDiscardStarted.promise;

    const reserved = await acquireProtectedAsset({
      assetKey: 'trip-photo:trip-1:photo-1:medium',
      path: '/trips/trip-1/photos/photo-1/medium',
      variant: MEDIUM,
      transport,
    });
    releaseFirstDiscard.resolve();
    const committed = await overCap;

    expect(await transport.files.exists(reserved.uri)).toBe(true);
    expect(
      __getProtectedAssetEntriesForTests().find(
        (entry) => entry.assetKey === 'trip-photo:trip-1:photo-1:medium',
      )?.refCount,
    ).toBe(1);

    reserved.release();
    committed.release();
  });

  it('does not evict a newly committed entry while its shared load is still in flight', async () => {
    const entryBytes = MEDIUM_CACHE_MAX_BYTES / MEDIUM_CACHE_MAX_ENTRIES;
    const transport = createFakeTransport((_call, index) =>
      imageResponse([bytes(index < MEDIUM_CACHE_MAX_ENTRIES ? entryBytes : entryBytes * 2)]).response,
    );
    const pinned = [];

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES; index += 1) {
      pinned.push(
        await acquireProtectedAsset({
          assetKey: `trip-photo:trip-1:photo-${index}:medium`,
          path: `/trips/trip-1/photos/photo-${index}/medium`,
          variant: MEDIUM,
          transport,
        }),
      );
    }
    pinned[0].release();

    const firstDiscardStarted = createDeferred<void>();
    const releaseFirstDiscard = createDeferred<void>();
    const secondDiscardFinished = createDeferred<void>();
    const discard = transport.files.discard.bind(transport.files);
    let discardCount = 0;
    transport.files.discard = async (uri: string) => {
      discardCount += 1;
      const callNumber = discardCount;
      if (callNumber === 1) {
        firstDiscardStarted.resolve();
        await releaseFirstDiscard.promise;
      }
      await discard(uri);
      if (callNumber === 2) {
        secondDiscardFinished.resolve();
      }
    };

    const overCap = acquireProtectedAsset({
      assetKey: 'trip-photo:trip-1:photo-new:medium',
      path: '/trips/trip-1/photos/photo-new/medium',
      variant: MEDIUM,
      transport,
    });
    await firstDiscardStarted.promise;
    const committingUri = Array.from(transport.files.contents().keys()).at(-1);
    expect(committingUri).toBeDefined();

    // This starts a second eviction pass while the first pass — and therefore
    // the new asset's shared load — is still waiting for cleanup to finish.
    pinned[1].release();
    await secondDiscardFinished.promise;
    releaseFirstDiscard.resolve();
    const committed = await overCap;

    expect(committed.uri).toBe(committingUri);
    expect(await transport.files.exists(committed.uri)).toBe(true);
    expect(
      __getProtectedAssetEntriesForTests().some(
        (entry) => entry.assetKey === 'trip-photo:trip-1:photo-new:medium',
      ),
    ).toBe(true);

    for (const asset of pinned) {
      asset.release();
    }
    committed.release();
  });

  it('does not return a stage explicitly invalidated while eviction is pending', async () => {
    const entryBytes = MEDIUM_CACHE_MAX_BYTES / MEDIUM_CACHE_MAX_ENTRIES;
    const transport = createFakeTransport(() => imageResponse([bytes(entryBytes)]).response);

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES; index += 1) {
      const asset = await acquireProtectedAsset({
        assetKey: `trip-photo:trip-1:photo-${index}:medium`,
        path: `/trips/trip-1/photos/photo-${index}/medium`,
        variant: MEDIUM,
        transport,
      });
      asset.release();
    }

    const evictionStarted = createDeferred<void>();
    const allowEviction = createDeferred<void>();
    const discard = transport.files.discard.bind(transport.files);
    let discardCalls = 0;
    transport.files.discard = async (uri: string) => {
      discardCalls += 1;
      if (discardCalls === 1) {
        evictionStarted.resolve();
        await allowEviction.promise;
      }
      await discard(uri);
    };

    const assetKey = 'trip-photo:trip-1:photo-new:medium';
    const pending = acquireProtectedAsset({
      assetKey,
      path: '/trips/trip-1/photos/photo-new/medium',
      variant: MEDIUM,
      transport,
    });
    await evictionStarted.promise;
    const stagedUri = __getProtectedAssetEntriesForTests().find(
      (entry) => entry.assetKey === assetKey,
    )?.uri;
    if (!stagedUri) {
      throw new Error('Expected the new stage to be registered before eviction settled.');
    }

    await invalidateProtectedAsset(assetKey);
    allowEviction.resolve();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(__getProtectedAssetEntriesForTests().some((entry) => entry.assetKey === assetKey)).toBe(
      false,
    );
    await expect(transport.files.exists(stagedUri)).resolves.toBe(false);
  });

  it('evicts on the byte cap even when the entry count is within budget', async () => {
    const chunkBytes = Math.ceil(MEDIUM_CACHE_MAX_BYTES / (MEDIUM_CACHE_MAX_ENTRIES - 1));
    const transport = createFakeTransport(() => imageResponse([bytes(chunkBytes)]).response);

    for (let index = 0; index < MEDIUM_CACHE_MAX_ENTRIES; index += 1) {
      const asset = await acquireProtectedAsset({
        assetKey: `trip-photo:trip-1:photo-${index}:medium`,
        path: `/trips/trip-1/photos/photo-${index}/medium`,
        variant: MEDIUM,
        transport,
      });
      asset.release();
    }

    const entries = __getProtectedAssetEntriesForTests();
    expect(entries.length).toBeLessThan(MEDIUM_CACHE_MAX_ENTRIES);
    expect(entries.reduce((total, entry) => total + entry.bytes, 0)).toBeLessThanOrEqual(
      MEDIUM_CACHE_MAX_BYTES,
    );
  });
});

describe('explicit invalidation', () => {
  it('deletes the file for one asset, unlike release', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    const options = {
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    };
    const asset = await acquireProtectedAsset(options);
    asset.release();

    await invalidateProtectedAsset(options.assetKey);

    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);

    await acquireProtectedAsset(options);
    expect(transport.fetches.calls).toHaveLength(2);
  });

  it('invalidates every asset of a trip by prefix (TRIP_NOT_FOUND)', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    for (const photoId of ['photo-1', 'photo-2']) {
      const asset = await acquireProtectedAsset({
        assetKey: thumbnailKey(photoId),
        path: thumbnailPath(photoId),
        variant: THUMBNAIL,
        transport,
      });
      asset.release();
    }
    const other = await acquireProtectedAsset({
      assetKey: 'trip-photo:trip-2:photo-9:thumbnail',
      path: '/trips/trip-2/photos/photo-9/thumbnail',
      variant: THUMBNAIL,
      transport,
    });
    other.release();

    await invalidateProtectedAssets('trip-photo:trip-1:');

    expect(__getProtectedAssetEntriesForTests().map((entry) => entry.assetKey)).toEqual([
      'trip-photo:trip-2:photo-9:thumbnail',
    ]);
    expect(transport.files.contents().size).toBe(1);
  });

  it('aborts a load in progress for the invalidated key', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(16)]).response;
    });

    const pending = acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });
    await flushMicrotasks();

    await invalidateProtectedAsset(thumbnailKey('photo-1'));
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(transport.files.contents().size).toBe(0);
  });
});

describe('session boundaries', () => {
  it('discards a completion that belongs to a session that has ended', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(16)]).response;
    });

    const pending = acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });
    await flushMicrotasks();

    beginPrivateMediaShutdown();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await waitForPrivateNetworkIdle();
    await flushPrivateMediaPurge();

    // The response arrived after sign-out: nothing may be left on disk and the
    // registry must not have gained an entry.
    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
  });

  it('purges staged files on sign-out', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    const asset = await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });
    asset.release();
    expect(transport.files.contents().size).toBe(1);

    beginPrivateMediaShutdown();
    await flushPrivateMediaPurge();

    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
  });

  it('purges pinned files too — a session boundary overrides every pin', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });

    suspendPrivateMediaSession();
    await flushPrivateMediaPurge();

    expect(transport.files.contents().size).toBe(0);
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
  });

  it('does not let cleanup from the old session delete a file staged by the new one', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    const first = await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });
    first.release();

    beginPrivateMediaShutdown();
    // Session B opens without waiting for session A's cleanup to be observed by
    // the test: the purge queue is what has to order them, not the caller.
    await startPrivateMediaSession();

    const second = await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-2'),
      path: thumbnailPath('photo-2'),
      variant: THUMBNAIL,
      transport,
    });
    await flushPrivateMediaPurge();

    expect(await transport.files.exists(second.uri)).toBe(true);
    expect(__getProtectedAssetEntriesForTests().map((entry) => entry.assetKey)).toEqual([
      thumbnailKey('photo-2'),
    ]);
  });

  it('refuses to stage anything while the gate is closed', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    beginPrivateMediaShutdown();

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(transport.fetches.calls).toHaveLength(0);
  });

  it('refuses a cache hit in the synchronous window before shutdown purge runs', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
    const asset = await acquireProtectedAsset({
      assetKey: thumbnailKey('photo-1'),
      path: thumbnailPath('photo-1'),
      variant: THUMBNAIL,
      transport,
    });
    asset.release();

    beginPrivateMediaShutdown();

    await expect(
      acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(transport.fetches.calls).toHaveLength(1);
    await flushPrivateMediaPurge();
  });

  it.each([true, false])(
    'refuses an async cache existence result of %s after the session boundary',
    async (existsAfterShutdown) => {
      const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);
      const asset = await acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      });
      asset.release();

      const existsGate = createDeferred<boolean>();
      transport.files.exists = async () => existsGate.promise;
      const pending = acquireProtectedAsset({
        assetKey: thumbnailKey('photo-1'),
        path: thumbnailPath('photo-1'),
        variant: THUMBNAIL,
        transport,
      });
      await flushMicrotasks();

      beginPrivateMediaShutdown();
      existsGate.resolve(existsAfterShutdown);

      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
      // A false result must not fall through and spend a fetch in the closed
      // session before the top-of-loop boundary runs again.
      expect(transport.fetches.calls).toHaveLength(1);
      await flushPrivateMediaPurge();
    },
  );
});
