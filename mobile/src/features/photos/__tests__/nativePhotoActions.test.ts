/**
 * D6 regression.
 *
 * SDK 57 documents the root `saveToLibraryAsync` as deprecated and as throwing
 * at runtime — a mistake that would only show up on a device, at the moment a
 * user taps Save. This pins the adapter to `Asset.create` and to the add-only
 * permission request, so a revert to the old API fails here instead.
 */

import * as MediaLibrary from 'expo-media-library';
import { nativePhotoActions } from '../nativePhotoActions';

beforeEach(() => {
  jest.clearAllMocks();
});

it('saves through Asset.create and never through the deprecated saveToLibraryAsync', async () => {
  await nativePhotoActions.createAsset('file:///cache/goplan-photo-save/abc.webp');

  expect(MediaLibrary.Asset.create).toHaveBeenCalledWith(
    'file:///cache/goplan-photo-save/abc.webp',
  );
  expect(
    (MediaLibrary as unknown as { saveToLibraryAsync?: unknown }).saveToLibraryAsync,
  ).toBeUndefined();
});

it('requests write-only, photos-only permission rather than full library access', async () => {
  (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValue({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  });

  const result = await nativePhotoActions.requestAddOnlyPermission();

  expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(true, ['photo']);
  expect(result).toEqual({ granted: true, canAskAgain: true, status: 'granted' });
});
