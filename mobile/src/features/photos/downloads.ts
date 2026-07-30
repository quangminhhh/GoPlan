/**
 * Saving one photo to the device library, and (from sub-issue 3.5) streaming a
 * ZIP to the share sheet.
 *
 * Every native call goes through `NativePhotoActions` so the logic here — the
 * permission branches, the extension derivation, the cleanup in `finally` — is
 * testable without loading expo-media-library or expo-sharing.
 */

import { fetchProtectedResponse } from '@/shared/media/fetchProtectedAsset';
import {
  acquirePrivateTransferLease,
  createSessionClosedError,
  getPrivateMediaEpoch,
} from '@/shared/media/privateMediaLifecycle';
import { ProtectedAssetError, type ProtectedTransport } from '@/shared/media/protectedAssetTypes';
import { createOpaqueFileName, nativeProtectedTransport } from '@/shared/media/protectedTransport';
import { buildBulkDownloadBody, tripPhotoAssetPath, tripPhotoBulkDownloadPath } from './api';
import { nativePhotoActions } from './nativePhotoActions';
import {
  MEDIUM_MAX_BYTES,
  PHOTO_BULK_DOWNLOAD_MAX_SELECTION,
  PRIVATE_MEDIA_DISK_RESERVE_BYTES,
} from './constants';
import { PHOTO_ERROR_MESSAGES, toPhotoFailure, type PhotoFailure } from './errors';

export interface NativePhotoActions {
  /**
   * Add-only permission. Saving a photo needs write access, not the ability to
   * read the user's entire library, so `writeOnly` is `true` and the granular
   * list is limited to photos.
   */
  requestAddOnlyPermission: () => Promise<{
    granted: boolean;
    canAskAgain: boolean;
    status: string;
  }>;
  /**
   * SDK 57's non-legacy save. The root `saveToLibraryAsync` is documented as
   * deprecated and as throwing at runtime, so it is never called.
   */
  createAsset: (fileUri: string) => Promise<void>;
  isSharingAvailable: () => Promise<boolean>;
  share: (fileUri: string, options: { UTI?: string; mimeType?: string }) => Promise<void>;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

function transferWasInvalidated(epochAtStart: number, signal?: AbortSignal): boolean {
  return signal?.aborted === true || getPrivateMediaEpoch() !== epochAtStart;
}

/**
 * Derives a file extension from what the server said, never from a path.
 *
 * `Content-Type` first, then the `filename` in `Content-Disposition`. The
 * variant is WebP today (D16), but the response is what decides.
 */
export function extensionForDownload(contentType: string | null, disposition: string | null): string {
  const normalizedType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromType = EXTENSION_BY_CONTENT_TYPE[normalizedType];
  if (fromType) {
    return fromType;
  }

  const match = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  const name = match?.[1] ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    const candidate = name.slice(dot).toLowerCase();
    // Only an extension made of plain letters and digits ever reaches a path.
    if (/^\.[a-z0-9]{1,5}$/.test(candidate)) {
      return candidate;
    }
  }
  return '.img';
}

export type SavePhotoOutcome =
  | { status: 'saved' }
  | { status: 'permissionDenied'; canAskAgain: boolean }
  | { status: 'failed'; failure: PhotoFailure };

export interface SaveTripPhotoOptions {
  tripId: string;
  photoId: string;
  transport?: ProtectedTransport;
  native?: NativePhotoActions;
  onProgress?: (bytesWritten: number) => void;
  signal?: AbortSignal;
}

/**
 * Downloads the `download` variant and adds it to the device photo library.
 *
 * The bytes are the stored `medium` file — max edge 2560 WebP, re-encoded by the
 * server — so the UI copy is the neutral "Save to Photos" and never promises an
 * original. The `download` endpoint is still the one used: it is what the issue
 * specifies, it has its own throttle scope, and its Content-Disposition is where
 * the extension comes from.
 */
export async function saveTripPhotoToLibrary(
  options: SaveTripPhotoOptions,
): Promise<SavePhotoOutcome> {
  const {
    tripId,
    photoId,
    transport = nativeProtectedTransport,
    native = nativePhotoActions,
    onProgress,
    signal,
  } = options;

  // Asked at the moment the user taps Save, never at launch.
  const permission = await native.requestAddOnlyPermission();
  if (!permission.granted) {
    return { status: 'permissionDenied', canAskAgain: permission.canAskAgain };
  }

  let releaseLease: (() => void) | null = null;
  try {
    releaseLease = acquirePrivateTransferLease();
  } catch {
    return { status: 'failed', failure: { kind: 'cancelled', message: 'Cancelled.' } };
  }

  let stagedUri: string | null = null;
  try {
    const epochAtStart = getPrivateMediaEpoch();
    const response = await fetchProtectedResponse({
      path: tripPhotoAssetPath(tripId, photoId, 'download'),
      signal,
      transport,
    });

    const contentType = response.headers.get('content-type');
    const disposition = response.headers.get('content-disposition');
    const normalizedType = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!normalizedType.startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProtectedAssetError('invalidContent', 'This photo could not be downloaded.');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MEDIUM_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProtectedAssetError('invalidContent', 'This photo could not be downloaded.');
    }
    const body = response.body;
    if (!body) {
      throw new ProtectedAssetError('invalidContent', 'This photo could not be downloaded.');
    }

    const sink = await transport.files.createSink(
      createOpaqueFileName(extensionForDownload(contentType, disposition)),
    );
    stagedUri = sink.uri;

    const reader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        if (transferWasInvalidated(epochAtStart, signal)) {
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
        if (received > MEDIUM_MAX_BYTES) {
          throw new ProtectedAssetError('invalidContent', 'This photo could not be downloaded.');
        }
        await sink.write(value);
        onProgress?.(received);
      }
      await sink.close();
      // The final read can resolve at the same moment sign-out invalidates the
      // session. Re-check after the last await so an old user's bytes are never
      // handed to Photos after the session boundary.
      if (transferWasInvalidated(epochAtStart, signal)) {
        throw createSessionClosedError();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await sink.discard();
      stagedUri = null;
      throw error;
    }

    await native.createAsset(sink.uri);
    return { status: 'saved' };
  } catch (caught) {
    return { status: 'failed', failure: toPhotoFailure(caught) };
  } finally {
    // The staged copy exists only to hand to the library; it is never kept.
    if (stagedUri) {
      await transport.files.discard(stagedUri);
    }
    releaseLease?.();
  }
}

const ZIP_CONTENT_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

/**
 * Accepts a ZIP response only on evidence.
 *
 * `application/octet-stream` is allowed only when the disposition also says it
 * is an attachment named `.zip`; without that, an HTML error page served with a
 * 200 would be written to disk and handed to the share sheet.
 */
export function isZipResponse(contentType: string | null, disposition: string | null): boolean {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ZIP_CONTENT_TYPES.has(normalized)) {
    return false;
  }
  if (normalized !== 'application/octet-stream') {
    return true;
  }
  if (!disposition || !/attachment/i.test(disposition)) {
    return false;
  }
  return /filename\*?=(?:UTF-8'')?"?[^";]*\.zip"?/i.test(disposition);
}

/**
 * Turns a server-supplied filename into something safe to display.
 *
 * The raw header never becomes a filesystem path — the file on disk gets an
 * opaque name — so this only has to be safe as a label and as a share sheet
 * hint.
 */
export function zipFileNameFrom(disposition: string | null): string {
  const fallback = 'trip-photos.zip';
  const match = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  if (!match?.[1]) {
    return fallback;
  }
  const stripped = match[1]
    .replace(/[/\\]/g, '')
    // Control characters are dropped by code point: a character class
    // written literally here would be invisible in review.
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim();
  if (!stripped.toLowerCase().endsWith('.zip') || stripped.length > 120) {
    return fallback;
  }
  return stripped;
}

export function hasDiskRoomForArchive(
  availableBytes: number | null,
  requiredBytes: number,
  reserve: number = PRIVATE_MEDIA_DISK_RESERVE_BYTES,
): boolean {
  if (availableBytes === null) {
    // The platform cannot report free space. Proceeding is the only option; the
    // sink error path and the cleanup in `finally` are the fallback, and the
    // residual limitation is recorded rather than hidden.
    return true;
  }
  return availableBytes - requiredBytes >= reserve;
}

export function throttledDownloadFailure(failure: PhotoFailure): PhotoFailure {
  return failure.kind === 'throttled'
    ? { ...failure, message: PHOTO_ERROR_MESSAGES.downloadThrottled }
    : failure;
}

/** Free space is re-checked every this many bytes while a ZIP streams. */
export const ARCHIVE_DISK_CHECK_INTERVAL_BYTES = 8 * 1024 * 1024;

export type ArchiveOutcome =
  | { status: 'shared'; fileName: string }
  | { status: 'unavailable' }
  | { status: 'cancelled' }
  | { status: 'staleSelection' }
  | { status: 'failed'; failure: PhotoFailure };

export interface DownloadArchiveOptions {
  tripId: string;
  photoIds: string[];
  transport?: ProtectedTransport;
  native?: NativePhotoActions;
  signal?: AbortSignal;
  onProgress?: (bytesWritten: number, totalBytes: number | null) => void;
}

/**
 * Streams the bulk-download ZIP to a cache file and hands it to the iOS share
 * sheet (D5).
 *
 * A ZIP is not something the photo library can accept, so the share sheet is the
 * destination — Files, AirDrop, Mail. Chunks are pumped one at a time rather
 * than buffered: `response.bytes()` would hold the whole archive in JavaScript
 * memory, and a hundred photos is not a small archive. Bounded chunks still pass
 * through a JS sink, so the invariant is "never materialise the whole archive",
 * not "zero JS memory".
 *
 * SDK 57's `shareAsync` returns `Promise<void>`. Resolving proves the sheet
 * closed and nothing more — not whether the user shared or cancelled — so the
 * caller shows no success message and keeps the selection.
 */
export async function downloadAndShareTripPhotoArchive(
  options: DownloadArchiveOptions,
): Promise<ArchiveOutcome> {
  const {
    tripId,
    photoIds,
    transport = nativeProtectedTransport,
    native = nativePhotoActions,
    signal,
    onProgress,
  } = options;

  if (photoIds.length === 0 || photoIds.length > PHOTO_BULK_DOWNLOAD_MAX_SELECTION) {
    // An empty list is rejected by the serializer before the service layer sees
    // it, and the server caps a request at 100. Neither should be reachable.
    return {
      status: 'failed',
      failure: { kind: 'request', message: PHOTO_ERROR_MESSAGES.selectionCap },
    };
  }

  if (!(await native.isSharingAvailable())) {
    return { status: 'unavailable' };
  }

  let releaseLease: (() => void) | null = null;
  try {
    releaseLease = acquirePrivateTransferLease();
  } catch {
    return { status: 'cancelled' };
  }

  let stagedUri: string | null = null;
  try {
    if (!hasDiskRoomForArchive(transport.files.availableBytes(), 0)) {
      return {
        status: 'failed',
        failure: { kind: 'request', message: PHOTO_ERROR_MESSAGES.lowStorage },
      };
    }

    const epochAtStart = getPrivateMediaEpoch();
    const response = await fetchProtectedResponse({
      path: tripPhotoBulkDownloadPath(tripId),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildBulkDownloadBody(photoIds),
      signal,
      transport,
    });

    const contentType = response.headers.get('content-type');
    const disposition = response.headers.get('content-disposition');
    if (!isZipResponse(contentType, disposition)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: 'failed',
        failure: { kind: 'invalidContent', message: 'The download could not be prepared.' },
      };
    }

    // A streaming response usually has no Content-Length, so an absent one is
    // normal rather than evidence that the archive is small.
    const declared = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
    if (totalBytes !== null && !hasDiskRoomForArchive(transport.files.availableBytes(), totalBytes)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: 'failed',
        failure: { kind: 'request', message: PHOTO_ERROR_MESSAGES.lowStorage },
      };
    }

    const body = response.body;
    if (!body) {
      return {
        status: 'failed',
        failure: { kind: 'invalidContent', message: 'The download could not be prepared.' },
      };
    }

    const fileName = zipFileNameFrom(disposition);
    // The file on disk gets an opaque name; the server's filename is only ever
    // a label and a share-sheet hint.
    const sink = await transport.files.createSink(createOpaqueFileName('.zip'));
    stagedUri = sink.uri;

    const reader = body.getReader();
    let received = 0;
    let nextDiskCheck = ARCHIVE_DISK_CHECK_INTERVAL_BYTES;
    try {
      for (;;) {
        if (transferWasInvalidated(epochAtStart, signal)) {
          throw createSessionClosedError();
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        await sink.write(value);
        received += value.byteLength;
        onProgress?.(received, totalBytes);

        if (received >= nextDiskCheck) {
          nextDiskCheck = received + ARCHIVE_DISK_CHECK_INTERVAL_BYTES;
          if (!hasDiskRoomForArchive(transport.files.availableBytes(), 0)) {
            throw new ProtectedAssetError('request', PHOTO_ERROR_MESSAGES.lowStorage);
          }
        }
      }
      await sink.close();
      // Same commit barrier as the single-photo path: a sign-out that lands
      // after the stream's final chunk must stop the share sheet from opening.
      if (transferWasInvalidated(epochAtStart, signal)) {
        throw createSessionClosedError();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await sink.discard();
      stagedUri = null;
      throw error;
    }

    await native.share(sink.uri, { UTI: 'public.zip-archive', mimeType: 'application/zip' });
    return { status: 'shared', fileName };
  } catch (caught) {
    const failure = toPhotoFailure(caught);
    if (failure.kind === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (failure.kind === 'notFound' && failure.errorCode === 'PHOTO_NOT_FOUND') {
      // All-or-nothing: the server refuses the whole archive when any id is
      // gone, and deliberately does not say which. The caller reconciles and
      // asks for a fresh selection rather than retrying blind against a 30/hour
      // budget.
      return { status: 'staleSelection' };
    }
    return {
      status: 'failed',
      failure:
        failure.kind === 'throttled'
          ? { ...failure, message: PHOTO_ERROR_MESSAGES.bulkThrottled }
          : failure,
    };
  } finally {
    // Deleted only after the share sheet has settled: on iOS the sheet reads the
    // file while it is open.
    if (stagedUri) {
      await transport.files.discard(stagedUri);
    }
    releaseLease?.();
  }
}
