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
});
