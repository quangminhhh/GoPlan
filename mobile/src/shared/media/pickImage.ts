import * as ImagePicker from 'expo-image-picker';
import type { PickImageOutcome } from './types';

export interface PickImageOptions {
  /**
   * Show the OS editor. On iOS that editor is always a square crop, which is why
   * issue #62 needs no custom cropper; `aspect` only has an effect on Android.
   */
  square?: boolean;
}

export async function pickImage({ square = false }: PickImageOptions = {}): Promise<PickImageOutcome> {
  // Modern iOS uses the privacy-preserving system picker and does not require
  // broad photo-library access for selecting a user-chosen image.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    allowsEditing: square,
    aspect: square ? [1, 1] : undefined,
    // Keep the source at full fidelity; preprocessImage owns the quality ladder.
    quality: 1,
    exif: false,
  });

  if (result.canceled) {
    return { status: 'cancelled' };
  }

  const asset = result.assets[0];
  if (!asset) {
    return { status: 'cancelled' };
  }

  return {
    status: 'picked',
    image: {
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      fileName: asset.fileName ?? null,
    },
  };
}
