import type { AppOwnedPickerSourceUri } from './pickerSourceStore';

/**
 * Shared contract for picking, preprocessing, and uploading images.
 *
 * Consumers: the avatar (issue #62) today; trip cover, trip photos, and memory
 * videos (issues #63-#65) next. Preprocessing shrinks what travels over the wire
 * so an oversized source is not rejected outright — the server re-encodes every
 * accepted image and remains the sole validator.
 */

/** One of the three formats the GoPlan backend accepts. */
export type UploadImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** An image chosen by the user, before any processing. */
export interface PickedImage {
  uri: string;
  width: number;
  height: number;
  /** Picker-reported name. iOS frequently omits it. */
  fileName: string | null;
}

/** Cancelling the system picker is an ordinary outcome, not an exception. */
export type PickImageOutcome =
  | {
      status: 'picked';
      image: PickedImage;
      /** Explicit delete authority; null for Photos originals/non-local URIs. */
      ownedSourceUri: AppOwnedPickerSourceUri | null;
    }
  | { status: 'cancelled' };

/**
 * Multi-select outcome.
 *
 * `unreadable` carries the assets the picker described in a way this app cannot
 * act on — dimensions of zero, most often an iCloud asset that never
 * materialised. They are reported per file so the rest of the selection still
 * uploads, and they are identified by position because a picker-supplied name is
 * frequently absent and never trustworthy.
 */
export type PickedUploadEntry =
  | {
      index: number;
      status: 'readable';
      image: PickedImage;
      ownedSourceUri: AppOwnedPickerSourceUri | null;
    }
  | {
      index: number;
      status: 'unreadable';
      fileName: string | null;
      ownedSourceUri: AppOwnedPickerSourceUri | null;
    };

export type PickImagesOutcome =
  | { status: 'picked'; entries: PickedUploadEntry[] }
  | { status: 'cancelled' };

export interface PreprocessTarget {
  /** Max long edge after processing, in pixels. */
  maxEdgePx: number;
  /** Max encoded size, in bytes. */
  maxBytes: number;
}

/** Exactly the object shape React Native's FormData accepts as a file part. */
export interface UploadableFile {
  uri: string;
  name: string;
  type: UploadImageMimeType;
}

export interface PreprocessedImage extends UploadableFile {
  width: number;
  height: number;
  bytes: number;
}

export type PreprocessErrorCode =
  /** The source could not be decoded or re-encoded at all. */
  | 'UNREADABLE'
  /** Every quality step still overshot target.maxBytes. */
  | 'BUDGET_UNREACHABLE';

export class ImagePreprocessError extends Error {
  readonly code: PreprocessErrorCode;

  constructor(code: PreprocessErrorCode, message: string) {
    super(message);
    this.name = 'ImagePreprocessError';
    this.code = code;
  }
}

/**
 * Encoder seam. The production implementation lives in imageCodec.ts and wraps
 * expo-image-manipulator + expo-file-system; tests inject a fake so the byte
 * budget logic never has to load a native module.
 */
export interface ImageCodec {
  encode(input: {
    uri: string;
    width: number;
    height: number;
    quality: number;
    format: UploadImageMimeType;
  }): Promise<{ uri: string; width: number; height: number; bytes: number }>;

  /**
   * Drop a temporary file this flow no longer needs.
   *
   * Every encode writes to the cache directory, and the quality ladder can write
   * three files for one upload. Best-effort by contract: a file that is already
   * gone, or that the OS refuses to delete, must never fail the surrounding
   * operation, so implementations swallow their own errors.
   *
   * `preprocessImage` discards the intermediates it created. The caller owns the
   * returned file and the picked source, and discards both once the upload is
   * finished.
   */
  discard(uri: string): Promise<void>;
}
