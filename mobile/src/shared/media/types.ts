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
  | { status: 'picked'; image: PickedImage }
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
}
