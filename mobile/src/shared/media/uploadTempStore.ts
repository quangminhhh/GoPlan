/**
 * Owned, purgeable home for preprocessed files waiting to be uploaded (D19).
 *
 * Preprocessing sixty photos before uploading any of them would put roughly
 * 600 MiB of private JPEGs in the cache directory at once. The pipeline instead
 * keeps one batch plus one candidate, and everything it writes lands here: a
 * stable namespace that a later session — or the next process after a crash —
 * can find and delete.
 *
 * `ImageCodec` writes wherever the manipulator puts its output. `adopt` moves
 * that file into this namespace so its lifetime stops being the encoder's
 * business and starts being the session's.
 */

import { registerPrivateMediaPurger } from './privateMediaLifecycle';
import type { ProtectedFileStore } from './protectedAssetTypes';
import {
  createOpaqueFileName,
  nativeMoveIntoNamespace,
  nativeUploadTempFileStore,
  UPLOAD_TEMP_NAMESPACE,
  type MoveIntoNamespace,
} from './protectedTransport';

export interface UploadTempFile {
  uri: string;
  bytes: number;
}

export interface AdoptOptions {
  /** Source file produced by the encoder. */
  uri: string;
  bytes: number;
  /** Drives the adopted file's extension; never taken from the source path. */
  mimeType: string;
  store?: ProtectedFileStore;
  /** Injected so tests need no native module. */
  move?: MoveIntoNamespace;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const adoptedUris = new Set<string>();
const knownStores = new Set<ProtectedFileStore>([nativeUploadTempFileStore]);

export class UploadTempStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTempStorageError';
  }
}

/**
 * Moves an encoder output into this namespace and returns its new location.
 *
 * A file only counts as `ready` once this succeeds. A failed move is a per-file
 * storage rejection — the encoder's original is left alone for its own owner to
 * clean up, and the rest of the selection keeps going.
 */
export async function adoptUploadTempFile(options: AdoptOptions): Promise<UploadTempFile> {
  const store = options.store ?? nativeUploadTempFileStore;
  const move = options.move ?? nativeMoveIntoNamespace;
  // The extension comes from the MIME type the encoder reported, never from the
  // source path — a picker-supplied name is not something to build a filename
  // out of.
  const extension = EXTENSION_BY_MIME[options.mimeType] ?? '.img';
  const fileName = createOpaqueFileName(extension);

  let adoptedUri: string;
  try {
    adoptedUri = await move(options.uri, UPLOAD_TEMP_NAMESPACE, fileName);
  } catch (error) {
    throw new UploadTempStorageError(
      error instanceof Error ? error.message : 'Could not prepare this photo.',
    );
  }

  knownStores.add(store);
  adoptedUris.add(adoptedUri);
  return { uri: adoptedUri, bytes: options.bytes };
}

export async function discardUploadTempFile(uri: string, store?: ProtectedFileStore): Promise<void> {
  adoptedUris.delete(uri);
  await (store ?? nativeUploadTempFileStore).discard(uri);
}

/** How much free space the volume reports, or `null` when it cannot say. */
export function uploadTempAvailableBytes(store?: ProtectedFileStore): number | null {
  return (store ?? nativeUploadTempFileStore).availableBytes();
}

/**
 * Deletes the whole namespace, including anything a killed process left behind.
 * Registered with the lifecycle so sign-in, sign-out and background all reach it
 * through its independently serialized, transfer-lease-fenced queue. Protected
 * cache cleanup is separate and never waits for an upload request body.
 */
export async function purgeUploadTempFiles(): Promise<void> {
  adoptedUris.clear();
  for (const store of Array.from(knownStores)) {
    await store.purgeAll();
  }
}

registerPrivateMediaPurger('upload-temp', purgeUploadTempFiles);

export function __resetUploadTempStoreForTests(): void {
  adoptedUris.clear();
  knownStores.clear();
  knownStores.add(nativeUploadTempFileStore);
}

export function __getAdoptedUploadTempUrisForTests(): string[] {
  return Array.from(adoptedUris);
}
