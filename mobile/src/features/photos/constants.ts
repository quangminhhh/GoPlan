import type { ProtectedAssetVariant } from '@/shared/media/protectedAssetTypes';
import type { TripPhotoAssetVariantName } from './types';

/**
 * The server default. Three pages make exactly the 60-tile fixture the QA script
 * uses for the token-expiry and scroll-reuse checks, without a first load that
 * fires 60 asset requests at once.
 */
export const PHOTO_PAGE_SIZE = 20;

/**
 * Response ceilings per variant, enforced against `Content-Length` and against
 * streamed bytes. Both sit above the raw-RGB size of the variant they guard
 * (480² × 3 and 2560² × 3), so a legitimate asset is never rejected — the point
 * is to stop a proxy error page from being written into the cache directory.
 */
export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;
export const MEDIUM_MAX_BYTES = 32 * 1024 * 1024;

export const TRIP_PHOTO_VARIANTS: Record<TripPhotoAssetVariantName, ProtectedAssetVariant> = {
  thumbnail: { name: 'thumbnail', bucket: 'thumbnail', maxBytes: THUMBNAIL_MAX_BYTES },
  medium: { name: 'medium', bucket: 'medium', maxBytes: MEDIUM_MAX_BYTES },
  // Same bytes as `medium` (D16), so the same ceiling and the same LRU bucket.
  download: { name: 'download', bucket: 'medium', maxBytes: MEDIUM_MAX_BYTES },
};

/** Grid geometry. At 375 pt this yields three columns. */
export const PHOTO_GRID_GAP = 2;
export const PHOTO_GRID_TARGET_TILE_WIDTH = 110;
export const PHOTO_GRID_MIN_COLUMNS = 3;

/** Server cap on a bulk-download request, enforced before the request goes out. */
export const PHOTO_BULK_DOWNLOAD_MAX_SELECTION = 100;

/**
 * Upload batching must satisfy all three ceilings, not two.
 *
 * `maxPixels` mirrors the server's `TRIP_PHOTO_MAX_UPLOAD_SOURCE_PIXELS` of
 * 90 MP with a margin — it is not an arbitrary number. Twenty preprocessed 4:3
 * iPhone photos come to 20 × 4.92 MP = 98.3 MP, so a batcher that only counts
 * files and bytes would build requests the server rejects every single time.
 *
 * The margin exists because a future encoder (or a fast path that skips
 * re-encoding an already-small file) could report dimensions that differ from
 * what Pillow measures, and the server answers per-file and per-request
 * violations with the same `PHOTO_DIMENSIONS_TOO_LARGE` code — so the client
 * could not tell the two apart after the fact. Five megapixels is about one
 * photo; for smaller images the file-count cap binds first anyway.
 */
export const PHOTO_UPLOAD_BATCH_LIMITS = {
  maxFiles: 20,
  maxBytes: 50 * 1024 * 1024,
  maxPixels: 85_000_000,
} as const;

/** Per-file target for preprocessing, matching the web contract. */
export const TRIP_PHOTO_PREPROCESS_TARGET = {
  maxEdgePx: 2560,
  maxBytes: 10 * 1024 * 1024,
} as const;

/**
 * Free-disk floor kept for the OS and the rest of the app while a temp file or a
 * ZIP is being written (D21).
 */
export const PRIVATE_MEDIA_DISK_RESERVE_BYTES = 256 * 1024 * 1024;
