import { setAccessToken } from '@/shared/api/token-store';
import {
  __resetPrivateMediaLifecycleForTests,
  startPrivateMediaSession,
} from '@/shared/media/privateMediaLifecycle';
import {
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
  createFakeResponse,
  createFakeTransport,
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
