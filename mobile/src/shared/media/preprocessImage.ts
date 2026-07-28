import {
  type ImageCodec,
  ImagePreprocessError,
  type PickedImage,
  type PreprocessedImage,
  type PreprocessTarget,
  type UploadImageMimeType,
} from './types';

/** Same ladder as the web contract in frontend/shared/lib/image-preprocess.ts. */
const QUALITY_STEPS = [0.9, 0.8, 0.7] as const;

/**
 * JPEG is the conservative iOS transport default for issue #62 (decision D1):
 * it is server-accepted, broadly compatible with iOS inputs, and a 512x512
 * output lands far inside the 500 KB avatar budget. Current Expo documentation
 * also lists WebP on iOS, so this is a compatibility/size choice rather than an
 * encoder limitation. The server re-encodes every accepted upload to WebP.
 */
export const DEFAULT_OUTPUT_FORMAT: UploadImageMimeType = 'image/jpeg';

const EXTENSION_BY_FORMAT: Record<UploadImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function scaledDimensions(
  width: number,
  height: number,
  maxEdgePx: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdgePx) {
    return { width, height };
  }
  const scale = maxEdgePx / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function outputFileName(sourceName: string | null, format: UploadImageMimeType): string {
  const base = (sourceName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]/g, '_');
  return `${base || 'photo'}.${EXTENSION_BY_FORMAT[format]}`;
}

/**
 * Always re-encodes, deliberately diverging from the web contract's
 * "keep the file as-is when it already fits" fast path.
 *
 * On iOS the picker hands back the camera's native HEIC, which the backend
 * rejects by magic bytes. A pass-through path would have to trust the picker's
 * reported MIME type to decide whether that is safe; re-encoding unconditionally
 * guarantees a server-accepted format and removes the HEIC special case entirely.
 * The cost is one extra encode of an image that is at most maxEdgePx wide.
 */
export async function preprocessImage(
  source: PickedImage,
  target: PreprocessTarget,
  codec: ImageCodec,
  format: UploadImageMimeType = DEFAULT_OUTPUT_FORMAT,
): Promise<PreprocessedImage> {
  const { width, height } = scaledDimensions(source.width, source.height, target.maxEdgePx);

  for (const quality of QUALITY_STEPS) {
    let encoded: { uri: string; width: number; height: number; bytes: number };
    try {
      encoded = await codec.encode({ uri: source.uri, width, height, quality, format });
    } catch {
      throw new ImagePreprocessError('UNREADABLE', 'That image could not be read.');
    }

    if (encoded.bytes <= target.maxBytes) {
      return {
        uri: encoded.uri,
        name: outputFileName(source.fileName, format),
        type: format,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes,
      };
    }
  }

  throw new ImagePreprocessError(
    'BUDGET_UNREACHABLE',
    'That image could not be compressed enough to upload.',
  );
}
