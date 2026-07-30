/**
 * Trip photo API.
 *
 * JSON and multipart go through the shared Axios client so they keep the 401
 * interceptor; asset bytes and the bulk ZIP go through `fetchProtectedResponse`,
 * which is the only path that can tell a 401 from a 404 (D1).
 *
 * Every call here is registered as private-network activity for its whole
 * lifetime, interceptor retry included, so sign-out can abort it and wait for it
 * before revoking the refresh token (D20).
 */

import { apiClient } from '@/shared/api/client';
import { toCursorPage, type CursorPage, type CursorPaginatedResponse } from '@/shared/api/pagination';
import { trackPrivateRequest } from '@/shared/media/privateMediaLifecycle';
import { PHOTO_PAGE_SIZE } from './constants';
import type { TripPhoto, TripPhotoAssetVariantName, TripPhotoUploadResponse } from './types';

/**
 * Path segments are encoded even though they are server-issued UUIDs: the rule
 * that a response value never becomes an unescaped part of a request URL should
 * not depend on the current shape of an id.
 */
function tripPhotosPath(tripId: string): string {
  return `/trips/${encodeURIComponent(tripId)}/photos`;
}

export function tripPhotoDetailPath(tripId: string, photoId: string): string {
  return `${tripPhotosPath(tripId)}/${encodeURIComponent(photoId)}`;
}

export function tripPhotoAssetPath(
  tripId: string,
  photoId: string,
  variant: TripPhotoAssetVariantName,
): string {
  return `${tripPhotoDetailPath(tripId, photoId)}/${variant}`;
}

export function tripPhotoBulkDownloadPath(tripId: string): string {
  return `${tripPhotosPath(tripId)}/download`;
}

/** Logical cache identity. Also the prefix used to invalidate a whole trip. */
export function tripPhotoAssetKey(
  tripId: string,
  photoId: string,
  variant: TripPhotoAssetVariantName,
): string {
  return `${tripPhotoAssetKeyPrefix(tripId)}${photoId}:${variant}`;
}

export function tripPhotoAssetKeyPrefix(tripId: string): string {
  return `trip-photo:${tripId}:`;
}

export function listTripPhotos(
  tripId: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<CursorPage<TripPhoto>> {
  return trackPrivateRequest(signal, async (linkedSignal) => {
    const { data } = await apiClient.get<CursorPaginatedResponse<TripPhoto>>(tripPhotosPath(tripId), {
      params: {
        page_size: PHOTO_PAGE_SIZE,
        // Only the cursor value is round-tripped, never the whole `next` URL.
        ...(cursor ? { cursor } : {}),
      },
      signal: linkedSignal,
    });
    return toCursorPage(data);
  });
}

export function deleteTripPhoto(tripId: string, photoId: string, signal?: AbortSignal): Promise<void> {
  return trackPrivateRequest(signal, async (linkedSignal) => {
    await apiClient.delete(tripPhotoDetailPath(tripId, photoId), { signal: linkedSignal });
  });
}

export interface UploadTripPhotoBatchOptions {
  signal?: AbortSignal;
  onUploadProgress?: (event: { loaded: number; total?: number }) => void;
}

/**
 * Uploads one conforming batch.
 *
 * The field is repeated `files` — plural, and different from the cover
 * endpoint's `file` and the avatar's `avatar`. Content-Type is left unset so
 * React Native's XHR generates the multipart boundary; setting it by hand drops
 * the boundary and the body becomes unparseable server-side.
 *
 * The 120 s timeout replaces the client's 15 s default, which a 50 MiB batch on
 * a mobile connection cannot meet.
 */
export const PHOTO_UPLOAD_TIMEOUT_MS = 120_000;

export function uploadTripPhotoBatch(
  tripId: string,
  files: { uri: string; name: string; type: string }[],
  options: UploadTripPhotoBatchOptions = {},
): Promise<TripPhoto[]> {
  return trackPrivateRequest(options.signal, async (linkedSignal) => {
    const form = new FormData();
    for (const file of files) {
      // React Native's FormData streams a `{uri, name, type}` part off disk. The
      // DOM lib this tsconfig pulls in only models `string | Blob`, which is why
      // the cast exists — the runtime shape is correct, the ambient type is not.
      form.append('files', file as unknown as Blob);
    }

    const { data } = await apiClient.post<TripPhotoUploadResponse>(tripPhotosPath(tripId), form, {
      signal: linkedSignal,
      timeout: PHOTO_UPLOAD_TIMEOUT_MS,
      ...(options.onUploadProgress
        ? {
            onUploadProgress: (event: { loaded: number; total?: number }) =>
              options.onUploadProgress?.({ loaded: event.loaded, total: event.total }),
          }
        : {}),
    });
    return data.photos;
  });
}

/** Body for the bulk ZIP endpoint. Order is the user's selection order. */
export function buildBulkDownloadBody(photoIds: string[]): string {
  return JSON.stringify({ photo_ids: photoIds });
}
