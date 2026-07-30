/**
 * The single production implementation behind the protected-media seam (D15).
 *
 * This is the only module in the flow allowed to import a native module, which
 * is what lets every test build the whole pipeline — 60 concurrent 401s, a purge
 * racing a commit, a cache directory the OS reclaimed — out of plain objects.
 * The same rule `imageCodec.ts` follows for the encoder in issue #62.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import type {
  ProtectedFetchInit,
  ProtectedFileSink,
  ProtectedFileStore,
  ProtectedTransport,
} from './protectedAssetTypes';

/**
 * Stable directory names. They have to survive a process restart so a new
 * session can find and delete files an old one left behind after a crash; only
 * the file names inside are opaque.
 */
export const PROTECTED_MEDIA_NAMESPACE = 'goplan-protected-media';
export const UPLOAD_TEMP_NAMESPACE = 'goplan-photo-upload';

let fileNameCounter = 0;

/**
 * Opaque name for a staged file. It carries no trip id, no photo id and no
 * variant — a cache directory listing must not describe what the user looked at.
 */
export function createOpaqueFileName(extension: string): string {
  fileNameCounter += 1;
  const random = Math.random().toString(36).slice(2, 12);
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  return `${Date.now().toString(36)}-${fileNameCounter.toString(36)}-${random}${suffix}`;
}

class NativeFileSink implements ProtectedFileSink {
  readonly uri: string;

  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private written = 0;
  private closed = false;

  constructor(file: File) {
    this.uri = file.uri;
    // `getWriter()` is an instance method of the stream expo-file-system returns,
    // so this needs no global WritableStream constructor in the RN runtime.
    this.writer = file.writableStream().getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writer.write(chunk);
    this.written += chunk.byteLength;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writer.close();
  }

  bytesWritten(): number {
    return this.written;
  }

  async discard(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        await this.writer.abort();
      } catch {
        // An already-errored writer rejects here. The file deletion below is the
        // part that matters, and it must still run.
      }
    }
    await deleteQuietly(this.uri);
  }
}

async function deleteQuietly(uri: string): Promise<void> {
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Best effort by contract. The cache directory is reclaimable by the OS, so
    // a file that refuses to delete is a leak the system cleans up on its own —
    // never a reason to fail the operation that asked for the cleanup.
  }
}

/**
 * Builds a file store scoped to one stable cache namespace.
 *
 * `purgeAll()` takes no argument and `discard()` refuses anything outside the
 * namespace, so no caller can turn either into an arbitrary-path delete.
 */
export function createNativeFileStore(namespace: string): ProtectedFileStore {
  function directory(): Directory {
    const dir = new Directory(Paths.cache, namespace);
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
    return dir;
  }

  function isOwned(uri: string): boolean {
    return uri.includes(`/${namespace}/`);
  }

  return {
    async createSink(fileName: string): Promise<ProtectedFileSink> {
      const file = new File(directory(), fileName);
      if (file.exists) {
        file.delete();
      }
      file.create();
      return new NativeFileSink(file);
    },

    async exists(uri: string): Promise<boolean> {
      try {
        return new File(uri).exists;
      } catch {
        return false;
      }
    },

    async stat(uri: string): Promise<{ bytes: number } | null> {
      try {
        const file = new File(uri);
        return file.exists ? { bytes: file.size } : null;
      } catch {
        return null;
      }
    },

    async discard(uri: string): Promise<void> {
      if (!isOwned(uri)) {
        return;
      }
      await deleteQuietly(uri);
    },

    async purgeAll(): Promise<void> {
      try {
        const dir = new Directory(Paths.cache, namespace);
        if (dir.exists) {
          dir.delete();
        }
      } catch {
        // Same best-effort contract: a directory the OS holds open must not stop
        // sign-out. The next session purges again before it stages anything.
      }
    },

    availableBytes(): number | null {
      try {
        const available = Paths.availableDiskSpace;
        return typeof available === 'number' && Number.isFinite(available) ? available : null;
      } catch {
        return null;
      }
    },
  };
}

export const nativeProtectedFileStore = createNativeFileStore(PROTECTED_MEDIA_NAMESPACE);
export const nativeUploadTempFileStore = createNativeFileStore(UPLOAD_TEMP_NAMESPACE);

export const nativeProtectedTransport: ProtectedTransport = {
  fetch(url: string, init: ProtectedFetchInit): Promise<Response> {
    // expo/fetch rather than the global: it reports a real HTTP status and hands
    // back a ReadableStream body, and D1 turns on being able to tell 401 from
    // 404 from a transport failure. `expo-image` only exposes an error string.
    return expoFetch(url, init) as unknown as Promise<Response>;
  },
  files: nativeProtectedFileStore,
};
