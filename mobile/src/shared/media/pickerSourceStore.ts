/**
 * Narrow delete authority for files materialised by Expo ImagePicker.
 *
 * A picker URI is primarily a read location. It only becomes deletable after
 * this module proves that it is a local file below Expo SDK 57's fixed
 * `Caches/ImagePicker/` directory. In particular, `ph://`,
 * `assets-library://`, arbitrary cache files and Photos-library originals never
 * receive this capability.
 */

import { Directory, File, Paths } from 'expo-file-system';

declare const appOwnedPickerSourceUriBrand: unique symbol;

export type AppOwnedPickerSourceUri = string & {
  readonly [appOwnedPickerSourceUriBrand]: 'AppOwnedPickerSourceUri';
};

export interface PickerSourceBoundary {
  /** URI for the exact directory owned by Expo ImagePicker. */
  imagePickerDirectoryUri(): string;
  discard(uri: string): Promise<void>;
}

function normalizeFilePath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname !== '' && parsed.hostname !== 'localhost') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }

    const decoded = decodeURIComponent(parsed.pathname);
    if (decoded.includes('\0') || !decoded.startsWith('/')) {
      return null;
    }

    const segments: string[] = [];
    for (const segment of decoded.split('/')) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    return `/${segments.join('/')}`;
  } catch {
    return null;
  }
}

export const nativePickerSourceBoundary: PickerSourceBoundary = {
  imagePickerDirectoryUri(): string {
    return new Directory(Paths.cache, 'ImagePicker').uri;
  },
  async discard(uri: string): Promise<void> {
    try {
      const file = new File(uri);
      if (file.exists) {
        file.delete();
      }
    } catch {
      // Best effort. Cleanup cannot replace the upload/avatar/cover outcome.
    }
  },
};

/**
 * Grants delete authority only for a direct descendant of
 * `Caches/ImagePicker/` (nested picker subdirectories are also allowed).
 */
export function claimAppOwnedPickerSourceUri(
  uri: string,
  boundary: PickerSourceBoundary = nativePickerSourceBoundary,
): AppOwnedPickerSourceUri | null {
  const candidatePath = normalizeFilePath(uri);
  const pickerDirectoryPath = normalizeFilePath(boundary.imagePickerDirectoryUri());
  if (!candidatePath || !pickerDirectoryPath) {
    return null;
  }

  const prefix = `${pickerDirectoryPath.replace(/\/$/, '')}/`;
  if (!candidatePath.startsWith(prefix) || candidatePath.length === prefix.length) {
    return null;
  }

  // Keep the original, already-validated file URI. File accepts encoded paths,
  // while the decoded canonical path above is used only for boundary checking.
  return uri as AppOwnedPickerSourceUri;
}

/** The only production delete seam for picker-owned sources. */
export async function discardAppOwnedPickerSource(
  uri: AppOwnedPickerSourceUri,
  boundary: PickerSourceBoundary = nativePickerSourceBoundary,
): Promise<void> {
  try {
    await boundary.discard(uri);
  } catch {
    // Injected/test boundaries may reject even though the native boundary does
    // not. The same best-effort contract applies to both.
  }
}

/**
 * Cleans an outcome that never reached its next owner (for example, a picker
 * resolving after unmount or a session constructor throwing). Duplicate
 * capabilities are harmless and are deleted once.
 */
export async function discardAppOwnedPickerSources(
  uris: Iterable<AppOwnedPickerSourceUri | null>,
  discard: (uri: AppOwnedPickerSourceUri) => Promise<void> = discardAppOwnedPickerSource,
): Promise<void> {
  const unique = new Set<AppOwnedPickerSourceUri>();
  for (const uri of uris) {
    if (uri) {
      unique.add(uri);
    }
  }
  await Promise.all(Array.from(unique, (uri) => discard(uri).catch(() => undefined)));
}
