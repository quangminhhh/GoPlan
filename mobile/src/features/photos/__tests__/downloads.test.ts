import { setAccessToken } from '@/shared/api/token-store';
import {
  __resetPrivateMediaLifecycleForTests,
  beginPrivateMediaShutdown,
  flushPrivateMediaPurge,
  startPrivateMediaSession,
  waitForPrivateNetworkIdle,
} from '@/shared/media/privateMediaLifecycle';
import {
  downloadAndShareTripPhotoArchive,
  extensionForDownload,
  hasDiskRoomForArchive,
  isZipResponse,
  saveTripPhotoToLibrary,
  zipFileNameFrom,
  type NativePhotoActions,
} from '../downloads';
import { PRIVATE_MEDIA_DISK_RESERVE_BYTES } from '../constants';
import {
  bytes,
  createDeferred,
  createFakeResponse,
  createFakeTransport,
  flushMicrotasks,
  jsonErrorResponse,
} from '@test/fakeProtectedTransport';

jest.mock('@/shared/api/refresh', () => ({ refreshTokens: jest.fn(async () => 'token') }));

function nativeActions(overrides: Partial<NativePhotoActions> = {}): NativePhotoActions {
  return {
    requestAddOnlyPermission: jest.fn(async () => ({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    })),
    createAsset: jest.fn(async () => undefined),
    isSharingAvailable: jest.fn(async () => true),
    share: jest.fn(async () => undefined),
    ...overrides,
  };
}

function downloadResponse(contentType = 'image/webp', disposition = 'attachment; filename="photo.webp"') {
  return createFakeResponse({
    status: 200,
    headers: { 'content-type': contentType, 'content-disposition': disposition },
    chunks: [bytes(32), bytes(32)],
  }).response;
}

function responseWithDeferredFirstRead(
  headers: Record<string, string>,
): {
  response: Response;
  read: ReturnType<typeof createDeferred<{ done: boolean; value?: Uint8Array }>>;
  started: Promise<void>;
  cancel: jest.Mock<Promise<void>, []>;
} {
  const read = createDeferred<{ done: boolean; value?: Uint8Array }>();
  const started = createDeferred<void>();
  const cancel = jest.fn(async () => undefined);
  let reads = 0;
  const body = {
    getReader() {
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          reads += 1;
          started.resolve();
          return reads === 1 ? read.promise : { done: true };
        },
        cancel,
      };
    },
    async cancel(): Promise<void> {},
  };
  const normalized = Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ] as const);
  return {
    read,
    started: started.promise,
    cancel,
    response: {
      status: 200,
      ok: true,
      headers: {
        get(name: string): string | null {
          return normalized.find(([key]) => key === name.toLowerCase())?.[1] ?? null;
        },
      },
      body,
    } as unknown as Response,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetPrivateMediaLifecycleForTests();
  setAccessToken('token');
  await startPrivateMediaSession();
});

afterEach(() => {
  setAccessToken(null);
});

describe('extensionForDownload', () => {
  it('prefers the content type', () => {
    expect(extensionForDownload('image/webp', 'attachment; filename="x.jpg"')).toBe('.webp');
    expect(extensionForDownload('image/jpeg; charset=binary', null)).toBe('.jpg');
  });

  it('falls back to the server-generated filename', () => {
    expect(extensionForDownload(null, 'attachment; filename="trip-photo.webp"')).toBe('.webp');
  });

  it('refuses anything that is not a plain extension', () => {
    expect(extensionForDownload(null, 'attachment; filename="../../etc/passwd"')).toBe('.img');
    expect(extensionForDownload(null, 'attachment; filename="photo."')).toBe('.img');
    expect(extensionForDownload(null, null)).toBe('.img');
  });
});

describe('saveTripPhotoToLibrary', () => {
  it('asks for add-only permission and saves through Asset.create, not the deprecated api', async () => {
    const native = nativeActions();
    const transport = createFakeTransport(() => downloadResponse());

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native,
    });

    expect(outcome).toEqual({ status: 'saved' });
    // writeOnly, photos only: saving needs to add an asset, not to read the
    // user's whole library.
    expect(native.requestAddOnlyPermission).toHaveBeenCalledTimes(1);
    expect(native.createAsset).toHaveBeenCalledTimes(1);
    expect((native.createAsset as jest.Mock).mock.calls[0][0]).toContain('file:///');
  });

  it('requests the download variant, not the medium one already staged', async () => {
    const transport = createFakeTransport(() => downloadResponse());

    await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native: nativeActions(),
    });

    expect(transport.fetches.calls[0].url).toBe(
      'http://testserver:8000/api/trips/trip-1/photos/photo-1/download',
    );
  });

  it('deletes the staged copy whether the save succeeds or fails', async () => {
    const transport = createFakeTransport(() => downloadResponse());
    await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native: nativeActions(),
    });
    expect(transport.files.contents().size).toBe(0);

    const failing = createFakeTransport(() => downloadResponse());
    await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport: failing,
      native: nativeActions({
        createAsset: jest.fn(async () => {
          throw new Error('library refused');
        }),
      }),
    });
    expect(failing.files.contents().size).toBe(0);
  });

  it('stops at a denied permission without downloading anything', async () => {
    const transport = createFakeTransport(() => downloadResponse());
    const native = nativeActions({
      requestAddOnlyPermission: jest.fn(async () => ({
        granted: false,
        canAskAgain: true,
        status: 'denied',
      })),
    });

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native,
    });

    expect(outcome).toEqual({ status: 'permissionDenied', canAskAgain: true });
    expect(transport.fetches.calls).toHaveLength(0);
    expect(native.createAsset).not.toHaveBeenCalled();
  });

  it('reports when the OS will not ask again, so the caller can point at Settings', async () => {
    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport: createFakeTransport(() => downloadResponse()),
      native: nativeActions({
        requestAddOnlyPermission: jest.fn(async () => ({
          granted: false,
          canAskAgain: false,
          status: 'denied',
        })),
      }),
    });

    expect(outcome).toEqual({ status: 'permissionDenied', canAskAgain: false });
  });

  it('maps a native permission rejection instead of rejecting the action promise', async () => {
    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport: createFakeTransport(() => downloadResponse()),
      native: nativeActions({
        requestAddOnlyPermission: jest.fn(async () => {
          throw new Error('native bridge unavailable');
        }),
      }),
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'server' } });
  });

  it('surfaces a stale photo with its error code so the caller can branch (D18)', async () => {
    const transport = createFakeTransport(
      () => jsonErrorResponse(404, { detail: 'Photo not found.', error_code: 'PHOTO_NOT_FOUND' }).response,
    );

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { kind: 'notFound', errorCode: 'PHOTO_NOT_FOUND' },
    });
  });

  it('rejects a body larger than the medium ceiling and leaves nothing behind', async () => {
    const transport = createFakeTransport(
      () =>
        createFakeResponse({
          status: 200,
          headers: { 'content-type': 'image/webp' },
          // Two chunks of 20 MiB overshoot the 32 MiB ceiling on the second.
          chunks: [bytes(20 * 1024 * 1024), bytes(20 * 1024 * 1024)],
        }).response,
    );

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalidContent' } });
    expect(transport.files.contents().size).toBe(0);
  });

  it('rejects a non-image success response before creating a Photos asset', async () => {
    const native = nativeActions();
    const transport = createFakeTransport(() => downloadResponse('text/html'));

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native,
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalidContent' } });
    expect(native.createAsset).not.toHaveBeenCalled();
    expect(transport.files.contents().size).toBe(0);
  });

  it('does not hand a completed file to Photos after the session is invalidated', async () => {
    const native = nativeActions();
    const transport = createFakeTransport(() => downloadResponse());
    const createSink = transport.files.createSink.bind(transport.files);
    transport.files.createSink = async (fileName: string) => {
      const sink = await createSink(fileName);
      return {
        ...sink,
        close: async () => {
          await sink.close();
          beginPrivateMediaShutdown();
        },
      };
    };

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native,
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'cancelled' } });
    expect(native.createAsset).not.toHaveBeenCalled();
    expect(transport.files.contents().size).toBe(0);
  });

  it('deletes a sink created after the shutdown purge while createSink was pending', async () => {
    const response = createFakeResponse({
      status: 200,
      headers: {
        'content-type': 'image/webp',
        'content-disposition': 'attachment; filename="photo.webp"',
      },
      chunks: [bytes(64)],
    });
    const transport = createFakeTransport(() => response.response);
    const createSinkStarted = createDeferred<void>();
    const allowSinkCreation = createDeferred<void>();
    const createSink = transport.files.createSink.bind(transport.files);
    transport.files.createSink = async (fileName: string) => {
      createSinkStarted.resolve();
      await allowSinkCreation.promise;
      return createSink(fileName);
    };

    const pending = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native: nativeActions(),
    });
    await createSinkStarted.promise;
    beginPrivateMediaShutdown();
    await flushPrivateMediaPurge();
    await flushMicrotasks();
    expect(response.cancelled()).toBe(true);

    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    allowSinkCreation.resolve();
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'cancelled' },
    });
    await waiting;
    expect(idle).toBe(true);
    expect(transport.files.contents().size).toBe(0);
  });

  it('cancels the response body when creating the photo sink rejects', async () => {
    const response = createFakeResponse({
      status: 200,
      headers: {
        'content-type': 'image/webp',
        'content-disposition': 'attachment; filename="photo.webp"',
      },
      chunks: [bytes(64)],
    });
    const transport = createFakeTransport(() => response.response);
    transport.files.createSink = jest.fn(async () => {
      throw new Error('filesystem unavailable');
    });
    const native = nativeActions();

    const outcome = await saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport,
      native,
    });

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(response.cancelled()).toBe(true);
    expect(transport.files.contents().size).toBe(0);
    expect(native.createAsset).not.toHaveBeenCalled();
  });

  it('keeps sign-out waiting while the response body read is still pending', async () => {
    const deferred = responseWithDeferredFirstRead({
      'content-type': 'image/webp',
      'content-disposition': 'attachment; filename="photo.webp"',
    });
    const pending = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport: createFakeTransport(() => deferred.response),
      native: nativeActions(),
    });
    await deferred.started;

    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    beginPrivateMediaShutdown();
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'cancelled' },
    });
    await waiting;
    expect(idle).toBe(true);
    expect(deferred.cancel).toHaveBeenCalled();
    deferred.read.resolve({ done: true });
  });

  it('waits through native Photos handoff and rejects a post-handoff old epoch', async () => {
    const handoff = createDeferred<void>();
    const pending = saveTripPhotoToLibrary({
      tripId: 'trip-1',
      photoId: 'photo-1',
      transport: createFakeTransport(() => downloadResponse()),
      native: nativeActions({ createAsset: jest.fn(async () => handoff.promise) }),
    });
    await flushMicrotasks(10);

    beginPrivateMediaShutdown();
    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    handoff.resolve();
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'cancelled' },
    });
    await waiting;
  });
});

describe('zip response validation', () => {
  it('accepts the zip content types the backend can send', () => {
    expect(isZipResponse('application/zip', null)).toBe(true);
    expect(isZipResponse('application/x-zip-compressed', null)).toBe(true);
  });

  it('accepts octet-stream only with attachment evidence', () => {
    expect(
      isZipResponse('application/octet-stream', 'attachment; filename="trip-photos.zip"'),
    ).toBe(true);
    expect(isZipResponse('application/octet-stream', null)).toBe(false);
    expect(isZipResponse('application/octet-stream', 'inline; filename="trip.zip"')).toBe(false);
    expect(
      isZipResponse('application/octet-stream', 'attachment; filename="trip-photos.html"'),
    ).toBe(false);
  });

  it('rejects a success response that is html or json', () => {
    expect(isZipResponse('text/html', 'attachment; filename="x.zip"')).toBe(false);
    expect(isZipResponse('application/json', null)).toBe(false);
    expect(isZipResponse(null, null)).toBe(false);
  });
});

describe('zipFileNameFrom', () => {
  it('uses the server filename when it is a plain zip name', () => {
    expect(zipFileNameFrom('attachment; filename="da-lat-photos.zip"')).toBe('da-lat-photos.zip');
  });

  it('falls back for anything with a path separator, a control character or the wrong suffix', () => {
    expect(zipFileNameFrom('attachment; filename="../../etc/passwd.zip"')).toBe('....etcpasswd.zip');
    expect(zipFileNameFrom('attachment; filename="evil.html"')).toBe('trip-photos.zip');
    expect(zipFileNameFrom('attachment; filename="bad name.zip"')).toBe('badname.zip');
    expect(zipFileNameFrom(null)).toBe('trip-photos.zip');
  });
});

describe('hasDiskRoomForArchive', () => {
  it('keeps the reserve free', () => {
    expect(hasDiskRoomForArchive(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 1000, 1000)).toBe(true);
    expect(hasDiskRoomForArchive(PRIVATE_MEDIA_DISK_RESERVE_BYTES + 999, 1000)).toBe(false);
  });

  it('proceeds when the platform cannot report free space, which is a stated residual risk', () => {
    expect(hasDiskRoomForArchive(null, 10 * 1024 * 1024 * 1024)).toBe(true);
  });
});

function zipResponse(chunks = [bytes(1024), bytes(1024)], headers: Record<string, string> = {}) {
  return createFakeResponse({
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="da-lat-photos.zip"',
      ...headers,
    },
    chunks,
  });
}

describe('downloadAndShareTripPhotoArchive', () => {
  it('posts the ordered ids as json and hands the file to the share sheet', async () => {
    const native = nativeActions();
    const transport = createFakeTransport(() => zipResponse().response);

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['c', 'a', 'b'],
      transport,
      native,
    });

    expect(outcome).toEqual({ status: 'shared', fileName: 'da-lat-photos.zip' });
    const call = transport.fetches.calls[0];
    expect(call.url).toBe('http://testserver:8000/api/trips/trip-1/photos/download');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.body).toBe('{"photo_ids":["c","a","b"]}');
    expect(native.share).toHaveBeenCalledWith(
      expect.stringContaining('file:///'),
      expect.objectContaining({ UTI: 'public.zip-archive' }),
    );
  });

  it('streams chunk by chunk and never materialises the whole archive', async () => {
    const handle = zipResponse([bytes(4096), bytes(4096), bytes(4096)]);
    const transport = createFakeTransport(() => handle.response);
    const progress: number[] = [];

    await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
      onProgress: (written) => progress.push(written),
    });

    // Progress advances a chunk at a time, which is only possible if the body
    // was pumped rather than buffered whole.
    expect(progress).toEqual([4096, 8192, 12288]);
    expect(handle.bodyRead()).toBe(true);
  });

  it('deletes the archive once the share sheet has settled', async () => {
    const transport = createFakeTransport(() => zipResponse().response);
    const shareOrder: string[] = [];
    const native = nativeActions({
      share: jest.fn(async (uri: string) => {
        // The sheet reads the file while it is open, so it must still exist.
        shareOrder.push((await transport.files.exists(uri)) ? 'exists-during-share' : 'missing');
      }),
    });

    await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native,
    });

    expect(shareOrder).toEqual(['exists-during-share']);
    expect(transport.files.contents().size).toBe(0);
  });

  it('does not open the share sheet after the session is invalidated at stream commit', async () => {
    const native = nativeActions();
    const transport = createFakeTransport(() => zipResponse().response);
    const createSink = transport.files.createSink.bind(transport.files);
    transport.files.createSink = async (fileName: string) => {
      const sink = await createSink(fileName);
      return {
        ...sink,
        close: async () => {
          await sink.close();
          beginPrivateMediaShutdown();
        },
      };
    };

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(native.share).not.toHaveBeenCalled();
    expect(transport.files.contents().size).toBe(0);
  });

  it('deletes a ZIP sink created after the shutdown purge while createSink was pending', async () => {
    const response = zipResponse();
    const transport = createFakeTransport(() => response.response);
    const createSinkStarted = createDeferred<void>();
    const allowSinkCreation = createDeferred<void>();
    const createSink = transport.files.createSink.bind(transport.files);
    transport.files.createSink = async (fileName: string) => {
      createSinkStarted.resolve();
      await allowSinkCreation.promise;
      return createSink(fileName);
    };

    const pending = downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });
    await createSinkStarted.promise;
    beginPrivateMediaShutdown();
    await flushPrivateMediaPurge();
    await flushMicrotasks();
    expect(response.cancelled()).toBe(true);

    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    allowSinkCreation.resolve();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    await waiting;
    expect(idle).toBe(true);
    expect(transport.files.contents().size).toBe(0);
  });

  it('cancels the ZIP body when creating its sink rejects', async () => {
    const response = zipResponse();
    const transport = createFakeTransport(() => response.response);
    transport.files.createSink = jest.fn(async () => {
      throw new Error('filesystem unavailable');
    });
    const native = nativeActions();

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native,
    });

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(response.cancelled()).toBe(true);
    expect(transport.files.contents().size).toBe(0);
    expect(native.share).not.toHaveBeenCalled();
  });

  it('rejects a 200 that is not actually a zip', async () => {
    const transport = createFakeTransport(
      () =>
        createFakeResponse({
          status: 200,
          headers: { 'content-type': 'text/html' },
          chunks: [bytes(64)],
        }).response,
    );
    const native = nativeActions();

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native,
    });

    expect(outcome).toMatchObject({ status: 'failed', failure: { kind: 'invalidContent' } });
    expect(native.share).not.toHaveBeenCalled();
    expect(transport.files.contents().size).toBe(0);
  });

  it('reports an all-or-nothing stale selection separately from other failures', async () => {
    const transport = createFakeTransport(
      () =>
        jsonErrorResponse(404, {
          detail: 'One or more selected photos were not found.',
          error_code: 'PHOTO_NOT_FOUND',
        }).response,
    );

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a', 'b'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toEqual({ status: 'staleSelection' });
  });

  it('keeps a trip-level 404 distinguishable', async () => {
    const transport = createFakeTransport(
      () => jsonErrorResponse(404, { detail: 'Trip not found.', error_code: 'TRIP_NOT_FOUND' }).response,
    );

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { kind: 'notFound', errorCode: 'TRIP_NOT_FOUND' },
    });
  });

  it('uses bulk-specific wording when throttled', async () => {
    const transport = createFakeTransport(
      () => jsonErrorResponse(429, { detail: 'Too many requests.' }).response,
    );

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { message: 'Download limit reached. Try again later.' },
    });
  });

  it('refuses a selection outside 1..100 before spending a request', async () => {
    const transport = createFakeTransport(() => zipResponse().response);

    await expect(
      downloadAndShareTripPhotoArchive({
        tripId: 'trip-1',
        photoIds: [],
        transport,
        native: nativeActions(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    await expect(
      downloadAndShareTripPhotoArchive({
        tripId: 'trip-1',
        photoIds: Array.from({ length: 101 }, (_unused, index) => `p${index}`),
        transport,
        native: nativeActions(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(transport.fetches.calls).toHaveLength(0);
  });

  it('reports an unavailable share sheet before downloading anything', async () => {
    const transport = createFakeTransport(() => zipResponse().response);

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions({ isSharingAvailable: jest.fn(async () => false) }),
    });

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(transport.fetches.calls).toHaveLength(0);
  });

  it('maps sharing availability and share-sheet native rejections', async () => {
    const unavailableFailure = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport: createFakeTransport(() => zipResponse().response),
      native: nativeActions({
        isSharingAvailable: jest.fn(async () => {
          throw new Error('native bridge unavailable');
        }),
      }),
    });
    expect(unavailableFailure).toMatchObject({
      status: 'failed',
      failure: { kind: 'server' },
    });

    const transport = createFakeTransport(() => zipResponse().response);
    const shareFailure = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions({
        share: jest.fn(async () => {
          throw new Error('share sheet failed');
        }),
      }),
    });
    expect(shareFailure).toMatchObject({ status: 'failed', failure: { kind: 'server' } });
    expect(transport.files.contents().size).toBe(0);
  });

  it('keeps sign-out waiting while a ZIP body read is pending', async () => {
    const deferred = responseWithDeferredFirstRead({
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="trip.zip"',
    });
    const pending = downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport: createFakeTransport(() => deferred.response),
      native: nativeActions(),
    });
    await deferred.started;

    let idle = false;
    const waiting = waitForPrivateNetworkIdle().then(() => {
      idle = true;
    });
    await flushMicrotasks();
    expect(idle).toBe(false);

    beginPrivateMediaShutdown();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    await waiting;
    expect(idle).toBe(true);
    expect(deferred.cancel).toHaveBeenCalled();
    deferred.read.resolve({ done: true });
  });

  it('deletes the partial archive when the download is cancelled', async () => {
    const controller = new AbortController();
    const response = zipResponse();
    const transport = createFakeTransport(() => {
      // Aborted after the response arrives but before the body is drained.
      controller.abort();
      return response.response;
    });

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
      signal: controller.signal,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(response.cancelled()).toBe(true);
    expect(transport.files.contents().size).toBe(0);
  });

  it('refuses to start when free disk is already below the reserve', async () => {
    const transport = createFakeTransport(() => zipResponse().response);
    transport.files.setAvailableBytes(1024);

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { message: 'Not enough storage space to prepare these photos.' },
    });
    expect(transport.fetches.calls).toHaveLength(0);
  });

  it('stops and cleans up when free disk drops mid-stream', async () => {
    const transport = createFakeTransport(() =>
      zipResponse([bytes(9 * 1024 * 1024), bytes(9 * 1024 * 1024)]).response,
    );
    let checks = 0;
    const originalAvailable = transport.files.availableBytes;
    transport.files.availableBytes = () => {
      checks += 1;
      // Plenty of room for the preflight; the volume fills while streaming.
      return checks <= 1 ? originalAvailable() : 1024;
    };

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { message: 'Not enough storage space to prepare these photos.' },
    });
    expect(transport.files.contents().size).toBe(0);
  });

  it('refuses when Content-Length would not fit inside the reserve', async () => {
    const transport = createFakeTransport(
      () => zipResponse([bytes(64)], { 'content-length': String(10 * 1024 * 1024 * 1024) }).response,
    );

    const outcome = await downloadAndShareTripPhotoArchive({
      tripId: 'trip-1',
      photoIds: ['a'],
      transport,
      native: nativeActions(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { message: 'Not enough storage space to prepare these photos.' },
    });
  });
});
