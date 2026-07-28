import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageCodec, UploadImageMimeType } from './types';

const SAVE_FORMAT_BY_MIME: Record<UploadImageMimeType, SaveFormat> = {
  'image/jpeg': SaveFormat.JPEG,
  'image/png': SaveFormat.PNG,
  'image/webp': SaveFormat.WEBP,
};

/**
 * Production encoder. expo-image-manipulator decodes HEIC transparently, so the
 * iPhone camera default needs no separate branch: it comes out as `format`.
 */
export const nativeImageCodec: ImageCodec = {
  async encode({ uri, width, height, quality, format }) {
    const rendered = await ImageManipulator.manipulate(uri)
      .resize({ width, height })
      .renderAsync();

    const saved = await rendered.saveAsync({
      format: SAVE_FORMAT_BY_MIME[format],
      compress: quality,
    });

    return {
      uri: saved.uri,
      width: saved.width,
      height: saved.height,
      // `File implements Blob`, so `size` is a plain number (0 when unreadable).
      bytes: new File(saved.uri).size,
    };
  },
};
