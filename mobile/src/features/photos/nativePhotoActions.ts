/**
 * The production implementation of `NativePhotoActions`.
 *
 * Separated from `downloads.ts` for the same reason `imageCodec.ts` is separate
 * from `preprocessImage.ts`: this is the only module that loads
 * expo-media-library and expo-sharing, so the logic that uses them stays
 * testable. It matters more here than usual — `MediaLibrary.Asset` extends a
 * native class, so merely importing the module outside a device runtime throws.
 */

import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import type { NativePhotoActions } from './downloads';

export const nativePhotoActions: NativePhotoActions = {
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
    // SDK 57's non-legacy save. The root `saveToLibraryAsync` is documented as
    // deprecated and as throwing at runtime, so it is never called.
    await MediaLibrary.Asset.create(fileUri);
  },

  isSharingAvailable: () => Sharing.isAvailableAsync(),

  async share(fileUri, options) {
    await Sharing.shareAsync(fileUri, options);
  },
};
