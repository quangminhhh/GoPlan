import * as ImagePicker from 'expo-image-picker';
import { claimAppOwnedPickerSourceUri } from './pickerSourceStore';
import type { PickImageOutcome, PickImagesOutcome } from './types';

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
    ownedSourceUri: claimAppOwnedPickerSourceUri(asset.uri),
    image: {
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      fileName: asset.fileName ?? null,
    },
  };
}

/**
 * Picker dimensions are typed as `number` but documented as possibly `0`, and a
 * resize called with zero is a native crash rather than a rejected file.
 */
export function hasUsableDimensions(asset: { width: number; height: number }): boolean {
  return (
    Number.isFinite(asset.width) &&
    Number.isFinite(asset.height) &&
    Number.isInteger(asset.width) &&
    Number.isInteger(asset.height) &&
    asset.width > 0 &&
    asset.height > 0
  );
}

/**
 * Multi-select for trip photos.
 *
 * Kept separate from `pickImage` rather than folded into it: the avatar and
 * cover flows depend on the single-select behaviour, and iOS cannot combine
 * multi-select with the system editor anyway.
 *
 * Every asset comes back as one ordered entry, including unreadable assets, so
 * cleanup authority cannot be lost when dimensions are unusable.
 */
export async function pickImages(): Promise<PickImagesOutcome> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    // iOS ignores the editor when multi-select is on, and cropping a batch is
    // not something this flow offers.
    allowsEditing: false,
    // Explicit even though it is the default, so the contract is visible in
    // review and in tests: 0 means the system maximum, never a silent truncation
    // of a 60-photo selection.
    selectionLimit: 0,
    // Selection order is only guaranteed on iOS 15+ when this is on; the docs
    // say assets "should" follow it otherwise, which is not a guarantee the
    // upload ledger can be numbered against.
    orderedSelection: true,
    // An iCloud-only photo has to be materialised before it can be read. A
    // failure here stays a per-file problem, not a failed selection.
    shouldDownloadFromNetwork: true,
    quality: 1,
    exif: false,
  });

  if (result.canceled) {
    return { status: 'cancelled' };
  }

  const entries = result.assets.map((asset, index) => {
    const ownedSourceUri = claimAppOwnedPickerSourceUri(asset.uri);
    if (!hasUsableDimensions(asset)) {
      return {
        index,
        status: 'unreadable' as const,
        fileName: asset.fileName ?? null,
        ownedSourceUri,
      };
    }
    return {
      index,
      status: 'readable' as const,
      image: {
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        fileName: asset.fileName ?? null,
      },
      ownedSourceUri,
    };
  });

  if (entries.length === 0) {
    return { status: 'cancelled' };
  }

  return { status: 'picked', entries };
}
