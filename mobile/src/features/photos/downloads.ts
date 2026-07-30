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
import { tripPhotoAssetPath } from './api';
import { nativePhotoActions } from './nativePhotoActions';
import { MEDIUM_MAX_BYTES, PRIVATE_MEDIA_DISK_RESERVE_BYTES } from './constants';
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
        if (signal?.aborted || getPrivateMediaEpoch() !== epochAtStart) {
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
