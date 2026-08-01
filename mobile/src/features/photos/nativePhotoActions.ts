/**
 * The production implementation of `PhotoLibraryAdapter`.
 *
 * Separated from `photoSave.ts` for the same reason `imageCodec.ts` is separate
 * from `preprocessImage.ts`: this is the only module that loads
 * expo-media-library, so the logic that uses it stays
 * testable. It matters more here than usual — `MediaLibrary.Asset` extends a
 * native class, so merely importing the module outside a device runtime throws.
 */

import * as MediaLibrary from 'expo-media-library';
import type { PhotoLibraryAdapter } from './photoSaveTypes';

export const nativePhotoActions: PhotoLibraryAdapter = {
  async requestAddOnlyPermission() {
    // `writeOnly: true` with photos-only granularity: saving needs to add an
    // asset, never to read the user's library.
    const response = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    return {
      granted: response.granted,
      canAskAgain: response.canAskAgain,
      status: response.status,
    };
  },

  async createAsset(fileUri: string) {
    // SDK 57's supported Asset API avoids the deprecated root-level helper,
    // which throws at runtime on this version.
    await MediaLibrary.Asset.create(fileUri);
  },
};
