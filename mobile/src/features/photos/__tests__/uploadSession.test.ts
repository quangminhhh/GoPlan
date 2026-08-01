import { AxiosError } from 'axios';
import type { PickedImage, PreprocessedImage } from '@/shared/media/types';
import { ImagePreprocessError } from '@/shared/media/types';
import { claimAppOwnedPickerSourceUri } from '@/shared/media/pickerSourceStore';
import {
  createUploadSession,
  type UploadSessionController,
  type UploadSessionDeps,
  type UploadSnapshot,
} from '../uploadSession';
import { PHOTO_UPLOAD_BATCH_LIMITS } from '../constants';
import type { TripPhoto } from '../types';
import type { PreparedUpload } from '../uploadTypes';
import { createDeferred } from '@test/fakeProtectedTransport';

const MIB = 1024 * 1024;

function pickedImage(index: number, width = 2560, height = 1920): PickedImage {
  return { uri: `file:///src/${index}.heic`, width, height, fileName: `IMG_${index}.HEIC` };
}

function encoded(image: PickedImage, bytes: number): PreprocessedImage {
  return {
    uri: `file:///encoded/${image.uri.split('/').pop()}.jpg`,
    name: 'photo.jpg',
    type: 'image/jpeg',
    bytes,
    width: image.width,
    height: image.height,
  };
}

function serverPhoto(id: string): TripPhoto {
  return {
    id,
    created_at: '2026-07-31T10:00:00Z',
    uploaded_by: { id: 'u1', display_name: 'Mai', identify_tag: 'mai', avatar_url: null },
    width: 2560,
    height: 1920,
    thumbnail_width: 480,
    thumbnail_height: 360,
    medium_width: 2560,
    medium_height: 1920,
    can_delete: true,
  };
}

function axiosFailure(status: number, body: unknown): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data: body,
  });
}

function networkFailure(): AxiosError {
  const config = { headers: {} } as never;
  return new AxiosError('Network Error', 'ERR_NETWORK', config, {});
}

interface Harness {
  deps: UploadSessionDeps;
  snapshots: UploadSnapshot[];
  last(): UploadSnapshot;
  uploads: PreparedUpload[][];
  tempFiles: Set<string>;
  encoderOutputs: Set<string>;
  /** Highest number of temp files that existed at any single moment. */
  peakTempFiles: number;
  uploaded: TripPhoto[];
  reconciles: number;
  tripNotFound: number;
  leases: number;
  peakLeases: number;
  sourceDiscards: string[];
}

function createHarness(
  overrides: Partial<UploadSessionDeps> & {
    upload?: (files: PreparedUpload[], attempt: number) => Promise<TripPhoto[]>;
    encodedBytes?: number;
    availableBytes?: () => number | null;
  } = {},
): Harness {
  const harness: Partial<Harness> & { snapshots: UploadSnapshot[] } = {
    snapshots: [],
    uploads: [],
    tempFiles: new Set<string>(),
    encoderOutputs: new Set<string>(),
    peakTempFiles: 0,
    uploaded: [],
    reconciles: 0,
    tripNotFound: 0,
    leases: 0,
    peakLeases: 0,
    sourceDiscards: [],
  };
  let attempt = 0;
  let tempCounter = 0;

  const deps: UploadSessionDeps = {
    async preprocess(image) {
      const output = encoded(image, overrides.encodedBytes ?? 1 * MIB);
      harness.encoderOutputs!.add(output.uri);
      return output;
    },
    async adopt({ uri, bytes }) {
      harness.encoderOutputs!.delete(uri);
      tempCounter += 1;
      const adopted = `file:///temp/${tempCounter}.jpg`;
      harness.tempFiles!.add(adopted);
      harness.peakTempFiles = Math.max(harness.peakTempFiles!, harness.tempFiles!.size);
      return { uri: adopted, bytes };
    },
    async discardTemp(uri) {
      harness.tempFiles!.delete(uri);
    },
    async discardEncoderOutput(uri) {
      harness.encoderOutputs!.delete(uri);
    },
    async discardSource(uri) {
      harness.sourceDiscards!.push(uri);
    },
    async uploadBatch(files, onProgress) {
      attempt += 1;
      harness.uploads!.push(files);
      onProgress(files.reduce((sum, file) => sum + file.bytes, 0), null);
      if (overrides.upload) {
        return overrides.upload(files, attempt);
      }
      return files.map((file) => serverPhoto(`server-${file.id}`));
    },
    availableBytes: overrides.availableBytes ?? (() => 100 * 1024 * MIB),
    acquireLease() {
      harness.leases! += 1;
      harness.peakLeases = Math.max(harness.peakLeases!, harness.leases!);
      return () => {
        harness.leases! -= 1;
      };
    },
    onSnapshot(snapshot) {
      harness.snapshots.push(snapshot);
    },
    onUploaded(photos) {
      harness.uploaded!.push(...photos);
    },
    onReconcile() {
      harness.reconciles! += 1;
    },
    onTripNotFound() {
      harness.tripNotFound! += 1;
    },
    ...(overrides.limits ? { limits: overrides.limits } : {}),
    ...(overrides.diskReserveBytes !== undefined
      ? { diskReserveBytes: overrides.diskReserveBytes }
      : {}),
  };

  harness.deps = deps;
  harness.last = () => harness.snapshots[harness.snapshots.length - 1];
  return harness as Harness;
}

function ownedSource(uri: string) {
  const owned = claimAppOwnedPickerSourceUri(uri, {
    imagePickerDirectoryUri: () => 'file:///src',
    discard: async () => undefined,
  });
  if (!owned) throw new Error(`Expected an app-owned test source: ${uri}`);
  return owned;
}

function selection(count: number, width = 2560, height = 1920, owned = false) {
  return {
    entries: Array.from({ length: count }, (_unused, index) => ({
      index,
      status: 'readable' as const,
      image: pickedImage(index, width, height),
      ownedSourceUri: owned ? ownedSource(pickedImage(index).uri) : null,
    })),
  };
}

describe('bounded pipeline', () => {
  it('uploads every batch and reports completion', async () => {
    const harness = createHarness();
    const session = createUploadSession(selection(5), harness.deps);

    await session.start();

    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]).toHaveLength(5);
    expect(harness.last().phase).toBe('complete');
    expect(harness.last().uploadedCount).toBe(5);
    expect(harness.uploaded).toHaveLength(5);
  });

  it('never holds more than the current batch plus one candidate on disk', async () => {
    // Sixty 4:3 photos: the pixel ceiling forces batches of 17, so a naive
    // implementation would spool all sixty encodes before the first request.
    const harness = createHarness();
    const session = createUploadSession(selection(60), harness.deps);

    await session.start();

    const perBatch = Math.floor(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / (2560 * 1920));
    expect(harness.peakTempFiles).toBeLessThanOrEqual(perBatch + 1);
    expect(harness.peakTempFiles).toBeLessThan(60);
    expect(harness.last().uploadedCount).toBe(60);
  });

  it('splits on the pixel ceiling, so no request carries twenty 4:3 photos', async () => {
    const harness = createHarness();
    const session = createUploadSession(selection(60), harness.deps);

    await session.start();

    for (const batch of harness.uploads) {
      expect(batch.length).toBeLessThanOrEqual(17);
      expect(batch.reduce((sum, file) => sum + file.width * file.height, 0)).toBeLessThanOrEqual(
        PHOTO_UPLOAD_BATCH_LIMITS.maxPixels,
      );
    }
  });

  it('preprocesses one file at a time and never encodes while a request is in flight', async () => {
    const events: string[] = [];
    const harness = createHarness({
      async upload(files) {
        events.push(`upload:${files.length}`);
        await Promise.resolve();
        return files.map((file) => serverPhoto(file.id));
      },
    });
    const original = harness.deps.preprocess;
    harness.deps.preprocess = async (image, target) => {
      events.push('encode');
      return original(image, target);
    };

    const session = createUploadSession(selection(3, 2560, 1920, true), harness.deps);
    await session.start();

    expect(events).toEqual(['encode', 'encode', 'encode', 'upload:3']);
  });

  it('cleans up a batch temp files as soon as it lands', async () => {
    const harness = createHarness();
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();

    expect(harness.tempFiles.size).toBe(0);
    expect(harness.encoderOutputs.size).toBe(0);
  });

  it('holds a transfer lease for the whole run so a background purge waits', async () => {
    const harness = createHarness();
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();

    expect(harness.peakLeases).toBe(1);
    expect(harness.leases).toBe(0);
  });
});

describe('per-file rejection', () => {
  it('keeps uploading the rest when one file cannot be encoded', async () => {
    const harness = createHarness();
    let calls = 0;
    const original = harness.deps.preprocess;
    harness.deps.preprocess = async (image, target) => {
      calls += 1;
      if (calls === 2) {
        throw new ImagePreprocessError('UNREADABLE', 'Could not read this photo.');
      }
      return original(image, target);
    };

    const session = createUploadSession(selection(3, 2560, 1920, true), harness.deps);
    await session.start();

    expect(harness.last().rejectedCount).toBe(1);
    expect(harness.last().uploadedCount).toBe(2);
    expect(harness.uploads[0]).toHaveLength(2);
    expect(harness.sourceDiscards).toHaveLength(3);
  });

  it('rejects an asset the picker could not describe, keeping its place in the numbering', async () => {
    const harness = createHarness();
    const session = createUploadSession(
      {
        entries: [
          { index: 0, status: 'readable', image: pickedImage(0), ownedSourceUri: null },
          {
            index: 1,
            status: 'unreadable',
            fileName: 'IMG_1.HEIC',
            ownedSourceUri: null,
          },
          { index: 2, status: 'readable', image: pickedImage(2), ownedSourceUri: null },
        ],
      },
      harness.deps,
    );

    await session.start();

    const rejected = harness.last().items.filter((item) => item.state === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].index).toBe(2);
    expect(harness.last().uploadedCount).toBe(2);
  });

  it('reports a storage failure per file instead of failing the selection', async () => {
    const harness = createHarness();
    let adopts = 0;
    const original = harness.deps.adopt;
    harness.deps.adopt = async (input) => {
      adopts += 1;
      if (adopts === 1) {
        throw new Error('no space');
      }
      return original(input);
    };

    const session = createUploadSession(selection(3, 2560, 1920, true), harness.deps);
    await session.start();

    expect(harness.last().rejectedCount).toBe(1);
    expect(harness.last().uploadedCount).toBe(2);
    // The encoder output for the failed adopt is not left behind.
    expect(harness.encoderOutputs.size).toBe(0);
    expect(harness.sourceDiscards).toHaveLength(3);
  });
});

describe('server outcomes', () => {
  it('preserves earlier batches and stops on a 429', async () => {
    const harness = createHarness({
      encodedBytes: 10 * MIB,
      async upload(files, attempt) {
        if (attempt === 2) {
          throw axiosFailure(429, { detail: 'Throttled.' });
        }
        return files.map((file) => serverPhoto(file.id));
      },
    });
    // 10 MiB each means five per batch on the byte ceiling.
    const session = createUploadSession(selection(12, 2560, 1920, true), harness.deps);

    await session.start();

    expect(harness.last().phase).toBe('throttled');
    expect(harness.last().error?.message).toBe('Upload limit reached. Try again later.');
    expect(harness.last().uploadedCount).toBe(5);
    expect(harness.uploaded).toHaveLength(5);
    // The throttled batch never landed, so it is pending — not failed.
    expect(harness.last().failedCount).toBe(0);
    expect(harness.last().unknownCount).toBe(0);
    // Only the first committed batch is terminal. The throttled batch and
    // unprocessed tail retain their picker sources for explicit Resume.
    expect(harness.sourceDiscards).toHaveLength(5);

    await session.start();

    expect(harness.last()).toMatchObject({
      phase: 'complete',
      uploadedCount: 12,
      pendingCount: 0,
      error: null,
    });
    expect(harness.uploaded.map((item) => item.id).sort()).toEqual(
      Array.from({ length: 12 }, (_unused, index) => `pick-${index}`).sort(),
    );
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.sourceDiscards).toHaveLength(12);
  });

  it('marks a batch unknown after a 5xx and never offers to retry it', async () => {
    const harness = createHarness({
      encodedBytes: 10 * MIB,
      async upload(files, attempt) {
        if (attempt === 2) {
          throw axiosFailure(500, { detail: 'Storage error.', error_code: 'PHOTO_STORAGE_ERROR' });
        }
        return files.map((file) => serverPhoto(file.id));
      },
    });
    const session = createUploadSession(selection(12, 2560, 1920, true), harness.deps);

    await session.start();

    // The server may already have committed those rows before failing to build
    // the response, so calling them "failed" and retrying would duplicate them.
    expect(harness.last().unknownCount).toBe(5);
    expect(harness.last().failedCount).toBe(0);
    expect(harness.last().uploadedCount).toBe(5);
    expect(harness.reconciles).toBe(1);
    expect(harness.uploads).toHaveLength(2);
  });

  it('treats a network drop exactly like a 5xx', async () => {
    const harness = createHarness({
      async upload() {
        throw networkFailure();
      },
    });
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();

    expect(harness.last().unknownCount).toBe(3);
    expect(harness.last().failedCount).toBe(0);
    expect(harness.reconciles).toBe(1);
  });

  it('stops on a deterministic 4xx and shows the server wording verbatim', async () => {
    const harness = createHarness({
      async upload() {
        throw axiosFailure(400, {
          detail: 'Total image dimensions exceed the limit.',
          error_code: 'PHOTO_DIMENSIONS_TOO_LARGE',
        });
      },
    });
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();

    expect(harness.last().phase).toBe('partial');
    expect(harness.last().failedCount).toBe(3);
    expect(harness.last().unknownCount).toBe(0);
    expect(harness.last().error?.message).toBe('Total image dimensions exceed the limit.');
    // A batching bug is fixed in code, not papered over by re-splitting.
    expect(harness.uploads).toHaveLength(1);
  });

  it('routes TRIP_NOT_FOUND to the trip-level flow rather than to batch copy', async () => {
    const harness = createHarness({
      async upload() {
        throw axiosFailure(404, { detail: 'Trip not found.', error_code: 'TRIP_NOT_FOUND' });
      },
    });
    const session = createUploadSession(selection(2), harness.deps);

    await session.start();

    expect(harness.last().phase).toBe('tripGone');
    expect(harness.tripNotFound).toBe(1);
    expect(harness.reconciles).toBe(0);
  });

  it('keeps prior successes when a later batch fails', async () => {
    const harness = createHarness({
      encodedBytes: 10 * MIB,
      async upload(files, attempt) {
        if (attempt === 3) {
          throw axiosFailure(400, { detail: 'Bad batch.', error_code: 'TOO_MANY_FILES' });
        }
        return files.map((file) => serverPhoto(file.id));
      },
    });
    const session = createUploadSession(selection(15), harness.deps);

    await session.start();

    expect(harness.last().uploadedCount).toBe(10);
    expect(harness.uploaded).toHaveLength(10);
    expect(harness.last().batchesUploaded).toBe(2);
  });
});

describe('background pause and resume', () => {
  it('rewinds a settled throttled batch before background purge and reprocesses fresh paths', async () => {
    let harness!: Harness;
    harness = createHarness({
      async upload(files, attempt) {
        expect(files.every((file) => harness.tempFiles.has(file.uri))).toBe(true);
        if (attempt === 1) {
          throw axiosFailure(429, { detail: 'Throttled.' });
        }
        return files.map((file) => serverPhoto(file.id));
      },
    });
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();
    expect(harness.last().phase).toBe('throttled');
    const staleUris = harness.uploads[0].map((file) => file.uri);

    session.requestPause();
    // `start` is the explicit foreground Resume. It must wait for the idle
    // background cleanup rather than racing it.
    await session.start();

    expect(harness.last()).toMatchObject({
      phase: 'complete',
      uploadedCount: 3,
      pendingCount: 0,
      error: null,
    });
    expect(harness.uploads[1].every((file) => !staleUris.includes(file.uri))).toBe(true);
    expect(harness.tempFiles.size).toBe(0);
  });

  it('lets the current request settle, then pauses without holding prepared files', async () => {
    const harness = createHarness({ encodedBytes: 10 * MIB });
    const session = createUploadSession(selection(12, 2560, 1920, true), harness.deps);

    const original = harness.deps.uploadBatch;
    harness.deps.uploadBatch = async (files, onProgress) => {
      const result = await original(files, onProgress);
      // Backgrounding lands while the first request is in flight.
      session.requestPause();
      return result;
    };

    await session.start();

    expect(harness.last().phase).toBe('paused');
    expect(harness.last().uploadedCount).toBe(5);
    // Nothing prepared but unsent survives the pause: private bytes must not sit
    // in the cache directory for as long as the app stays backgrounded.
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.last().pendingCount).toBe(7);
    expect(harness.sourceDiscards).toHaveLength(5);
  });

  it('reprocesses the stranded file on resume rather than skipping it', async () => {
    const harness = createHarness({ encodedBytes: 10 * MIB });
    const session = createUploadSession(selection(12, 2560, 1920, true), harness.deps);

    const original = harness.deps.uploadBatch;
    let paused = false;
    harness.deps.uploadBatch = async (files, onProgress) => {
      const result = await original(files, onProgress);
      if (!paused) {
        paused = true;
        session.requestPause();
      }
      return result;
    };

    await session.start();
    expect(harness.last().phase).toBe('paused');

    await session.start();

    expect(harness.last().uploadedCount).toBe(12);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.sourceDiscards).toHaveLength(12);
  });

  it('stops after the current batch when the user asks, and stays stopped', async () => {
    const harness = createHarness({ encodedBytes: 10 * MIB });
    const session = createUploadSession(selection(12), harness.deps);

    const original = harness.deps.uploadBatch;
    harness.deps.uploadBatch = async (files, onProgress) => {
      const result = await original(files, onProgress);
      session.requestStop();
      return result;
    };

    await session.start();

    expect(harness.last().phase).toBe('stopped');
    expect(harness.last().uploadedCount).toBe(5);
    expect(harness.uploads).toHaveLength(1);
  });
});

describe('intent boundaries and precedence', () => {
  it.each(['pause', 'stop'] as const)(
    '%s during deferred preprocess starts no upload request',
    async (requested) => {
      const harness = createHarness();
      const preprocessStarted = createDeferred<void>();
      const preprocess = createDeferred<PreprocessedImage>();
      const output = encoded(pickedImage(0), MIB);
      harness.deps.preprocess = async () => {
        preprocessStarted.resolve();
        const result = await preprocess.promise;
        harness.encoderOutputs.add(result.uri);
        return result;
      };
      const session = createUploadSession(selection(1, 2560, 1920, true), harness.deps);

      const running = session.start();
      await preprocessStarted.promise;
      if (requested === 'pause') session.requestPause();
      else session.requestStop();
      preprocess.resolve(output);
      await running;

      expect(harness.uploads).toHaveLength(0);
      expect(harness.encoderOutputs.size).toBe(0);
      expect(harness.last().phase).toBe(requested === 'pause' ? 'paused' : 'stopped');
      expect(harness.sourceDiscards).toHaveLength(requested === 'pause' ? 0 : 1);
    },
  );

  it('pause after preprocess settles prevents adopt and remains resumable', async () => {
    const harness = createHarness();
    let session!: UploadSessionController;
    const basePreprocess = harness.deps.preprocess;
    harness.deps.preprocess = async (image, target) => {
      const result = await basePreprocess(image, target);
      session.requestPause();
      return result;
    };
    const adopt = jest.spyOn(harness.deps, 'adopt');
    session = createUploadSession(selection(1, 2560, 1920, true), harness.deps);

    await session.start();

    expect(session.snapshot().phase).toBe('paused');
    expect(adopt).not.toHaveBeenCalled();
    expect(harness.uploads).toHaveLength(0);
    expect(harness.sourceDiscards).toHaveLength(0);
  });

  it('stop during deferred adopt discards the late temp and starts no request', async () => {
    const harness = createHarness();
    const adoptStarted = createDeferred<void>();
    const adopt = createDeferred<void>();
    harness.deps.adopt = async ({ uri, bytes }) => {
      adoptStarted.resolve();
      await adopt.promise;
      harness.encoderOutputs.delete(uri);
      const lateUri = 'file:///temp/stop-late-adopt.jpg';
      harness.tempFiles.add(lateUri);
      return { uri: lateUri, bytes };
    };
    const session = createUploadSession(selection(1, 2560, 1920, true), harness.deps);

    const running = session.start();
    await adoptStarted.promise;
    session.requestStop();
    adopt.resolve();
    await running;

    expect(session.snapshot().phase).toBe('stopped');
    expect(harness.uploads).toHaveLength(0);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.sourceDiscards).toHaveLength(1);
  });

  it('Stop wins a concurrent 429, retains throttle detail and cannot restart', async () => {
    const harness = createHarness();
    let session!: UploadSessionController;
    harness.deps.uploadBatch = async (files) => {
      harness.uploads.push(files);
      session.requestStop();
      throw axiosFailure(429, { detail: 'Throttled.' });
    };
    session = createUploadSession(selection(3, 2560, 1920, true), harness.deps);

    await session.start();
    await session.start();

    expect(session.snapshot()).toMatchObject({
      phase: 'stopped',
      pendingCount: 3,
      unknownCount: 0,
      error: { kind: 'throttled', message: 'Upload limit reached. Try again later.' },
      activeBatch: null,
    });
    expect(harness.uploads).toHaveLength(1);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.sourceDiscards).toHaveLength(3);
  });

  it('Stop wins an uncertain network outcome without scheduling another batch', async () => {
    const harness = createHarness();
    let session!: UploadSessionController;
    harness.deps.uploadBatch = async (files) => {
      harness.uploads.push(files);
      session.requestStop();
      throw networkFailure();
    };
    session = createUploadSession(selection(3, 2560, 1920, true), harness.deps);

    await session.start();
    await session.start();

    expect(session.snapshot()).toMatchObject({
      phase: 'stopped',
      unknownCount: 3,
      activeBatch: null,
    });
    expect(harness.reconciles).toBe(1);
    expect(harness.uploads).toHaveLength(1);
    expect(harness.sourceDiscards).toHaveLength(3);
  });

  it('Stop is never downgraded by a later background Pause', async () => {
    const harness = createHarness();
    let session!: UploadSessionController;
    const baseUpload = harness.deps.uploadBatch;
    harness.deps.uploadBatch = async (files, onProgress, signal) => {
      const result = await baseUpload(files, onProgress, signal);
      session.requestStop();
      session.requestPause();
      return result;
    };
    session = createUploadSession(selection(2), harness.deps);

    await session.start();

    expect(session.snapshot().phase).toBe('stopped');
    expect(harness.uploads).toHaveLength(1);
  });
});

describe('picker source ownership and active batch progress', () => {
  it('awaits cleanup already started for an unreadable source before cancel resolves', async () => {
    const harness = createHarness();
    const cleanup = createDeferred<void>();
    harness.deps.discardSource = async (uri) => {
      harness.sourceDiscards.push(uri);
      await cleanup.promise;
    };
    const uri = ownedSource('file:///src/unreadable.heic');
    const session = createUploadSession(
      {
        entries: [
          {
            index: 0,
            status: 'unreadable',
            fileName: 'unreadable.heic',
            ownedSourceUri: uri,
          },
        ],
      },
      harness.deps,
    );

    let settled = false;
    const cancelling = session.cancel().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.sourceDiscards).toEqual([uri]);

    cleanup.resolve();
    await cancelling;
    expect(settled).toBe(true);
  });

  it('absorbs source cleanup rejection without changing upload success', async () => {
    const harness = createHarness();
    harness.deps.discardSource = async (uri) => {
      harness.sourceDiscards.push(uri);
      throw new Error('file busy');
    };
    const session = createUploadSession(selection(2, 2560, 1920, true), harness.deps);

    await session.start();

    expect(session.snapshot()).toMatchObject({ phase: 'complete', uploadedCount: 2 });
    expect(harness.sourceDiscards).toHaveLength(2);
  });

  it('reports only native multipart totals and ignores invalid or stale progress', async () => {
    const harness = createHarness();
    const uploadStarted = createDeferred<void>();
    const upload = createDeferred<TripPhoto[]>();
    let progress: ((loaded: number, total: number | null) => void) | null = null;
    const emitProgress = (loaded: number, total: number | null): void => {
      if (!progress) throw new Error('Upload progress callback was not captured.');
      progress(loaded, total);
    };
    harness.deps.uploadBatch = async (files, onProgress) => {
      harness.uploads.push(files);
      progress = onProgress;
      uploadStarted.resolve();
      return upload.promise;
    };
    const session = createUploadSession(selection(2), harness.deps);
    const running = session.start();
    await uploadStarted.promise;

    expect(session.snapshot().activeBatch).toEqual({
      number: 1,
      itemCount: 2,
      loadedBytes: 0,
      totalBytes: null,
    });
    emitProgress(10, null);
    expect(session.snapshot().activeBatch).toMatchObject({ loadedBytes: 10, totalBytes: null });
    const beforeInvalid = harness.snapshots.length;
    emitProgress(Number.NaN, 100);
    emitProgress(-1, 100);
    expect(harness.snapshots).toHaveLength(beforeInvalid);
    emitProgress(60, 100);
    expect(session.snapshot().activeBatch).toMatchObject({ loadedBytes: 60, totalBytes: 100 });

    upload.resolve(harness.uploads[0].map((file) => serverPhoto(file.id)));
    await running;
    const afterSettle = harness.snapshots.length;
    emitProgress(90, 100);
    expect(harness.snapshots).toHaveLength(afterSettle);
    expect(session.snapshot().activeBatch).toBeNull();
  });
});

describe('private-session cancellation', () => {
  it('discards a preprocess completion that settles after the lifecycle signal aborts', async () => {
    const harness = createHarness();
    const preprocess = createDeferred<PreprocessedImage>();
    const output = encoded(pickedImage(0), MIB);
    harness.encoderOutputs.add(output.uri);
    harness.deps.preprocess = async () => preprocess.promise;
    const session = createUploadSession(selection(1), harness.deps);
    const controller = new AbortController();

    const running = session.start(controller.signal);
    controller.abort();
    preprocess.resolve(output);
    await running;

    expect(harness.last().phase).toBe('cancelled');
    expect(harness.encoderOutputs.size).toBe(0);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.last().uploadedCount).toBe(0);
  });

  it('discards an adopted file that appears after the lifecycle signal aborts', async () => {
    const harness = createHarness();
    const adopt = createDeferred<void>();
    harness.deps.adopt = async ({ uri, bytes }) => {
      await adopt.promise;
      harness.encoderOutputs.delete(uri);
      const adoptedUri = 'file:///temp/late-adopt.jpg';
      harness.tempFiles.add(adoptedUri);
      return { uri: adoptedUri, bytes };
    };
    const session = createUploadSession(selection(1), harness.deps);
    const controller = new AbortController();

    const running = session.start(controller.signal);
    await Promise.resolve();
    controller.abort();
    adopt.resolve();
    await running;

    expect(harness.last().phase).toBe('cancelled');
    expect(harness.encoderOutputs.size).toBe(0);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.last().uploadedCount).toBe(0);
  });

  it('aborts and awaits a preprocess that is still settling before cancel completes', async () => {
    const harness = createHarness();
    const preprocessStarted = createDeferred<void>();
    const preprocess = createDeferred<PreprocessedImage>();
    const output = encoded(pickedImage(0), MIB);
    harness.deps.preprocess = async () => {
      preprocessStarted.resolve();
      return preprocess.promise;
    };
    const session = createUploadSession(selection(1), harness.deps);

    const running = session.start();
    await preprocessStarted.promise;
    let cancelSettled = false;
    const cancelling = session.cancel().then(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    harness.encoderOutputs.add(output.uri);
    preprocess.resolve(output);
    await Promise.all([running, cancelling]);

    expect(cancelSettled).toBe(true);
    expect(harness.encoderOutputs.size).toBe(0);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.uploads).toHaveLength(0);
    expect(harness.last().phase).toBe('cancelled');
  });

  it('awaits adopt and discards a temp file returned after cancel', async () => {
    const harness = createHarness();
    const adoptStarted = createDeferred<void>();
    const adopt = createDeferred<void>();
    const lateUri = 'file:///temp/late-cancel-adopt.jpg';
    harness.deps.adopt = async ({ uri, bytes }) => {
      adoptStarted.resolve();
      await adopt.promise;
      harness.encoderOutputs.delete(uri);
      harness.tempFiles.add(lateUri);
      return { uri: lateUri, bytes };
    };
    const session = createUploadSession(selection(1), harness.deps);

    const running = session.start();
    await adoptStarted.promise;
    let cancelSettled = false;
    const cancelling = session.cancel().then(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    adopt.resolve();
    await Promise.all([running, cancelling]);

    expect(harness.encoderOutputs.size).toBe(0);
    expect(harness.tempFiles.size).toBe(0);
    expect(harness.uploads).toHaveLength(0);
    expect(harness.uploaded).toHaveLength(0);
    expect(harness.last().phase).toBe('cancelled');
  });

  it('aborts an active upload but keeps its files until the request settles', async () => {
    const harness = createHarness();
    const uploadStarted = createDeferred<void>();
    const uploadResult = createDeferred<TripPhoto[]>();
    let uploadSignal: AbortSignal | undefined;
    let requestFiles: PreparedUpload[] = [];
    harness.deps.uploadBatch = async (files, _onProgress, signal) => {
      requestFiles = files;
      uploadSignal = signal;
      harness.uploads.push(files);
      uploadStarted.resolve();
      // Deliberately ignore abort. Native networking may take time to settle,
      // and cancel must not unlink files while it can still be reading them.
      return uploadResult.promise;
    };
    const session = createUploadSession(selection(2), harness.deps);

    const running = session.start();
    await uploadStarted.promise;
    let cancelSettled = false;
    const cancelling = session.cancel().then(() => {
      cancelSettled = true;
    });

    expect(uploadSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    expect(requestFiles.every((file) => harness.tempFiles.has(file.uri))).toBe(true);

    uploadResult.resolve(requestFiles.map((file) => serverPhoto(file.id)));
    await Promise.all([running, cancelling]);

    expect(harness.tempFiles.size).toBe(0);
    // A resolved 201 is authoritative even if close was requested while the
    // native client was settling. The hook's stale owner guard suppresses this
    // callback from Trip/Session B, while the internal ledger keeps the truth.
    expect(harness.uploaded).toHaveLength(2);
    expect(harness.last()).toMatchObject({
      phase: 'cancelled',
      uploadedCount: 2,
      unknownCount: 0,
    });
  });

  it('is terminal after cancel and does not restart preprocessing', async () => {
    const harness = createHarness();
    const preprocess = jest.spyOn(harness.deps, 'preprocess');
    const session = createUploadSession(selection(1), harness.deps);

    await session.cancel();
    await session.start();
    session.requestPause();
    session.requestStop();

    expect(preprocess).not.toHaveBeenCalled();
    expect(harness.uploads).toHaveLength(0);
    expect(harness.last().phase).toBe('cancelled');
  });
});

describe('low disk', () => {
  it('stops scheduling and keeps prior successes when the reserve cannot be held', async () => {
    let free = 5000 * MIB;
    const harness = createHarness({
      encodedBytes: 10 * MIB,
      availableBytes: () => free,
    });
    const session = createUploadSession(selection(12), harness.deps);

    const original = harness.deps.uploadBatch;
    harness.deps.uploadBatch = async (files, onProgress) => {
      const result = await original(files, onProgress);
      free = 10 * MIB;
      return result;
    };

    await session.start();

    expect(harness.last().error?.message).toBe('Not enough storage space to prepare these photos.');
    expect(harness.last().uploadedCount).toBe(5);
    expect(harness.tempFiles.size).toBe(0);
  });

  it('fails closed when the platform cannot prove the disk reserve', async () => {
    const harness = createHarness({ availableBytes: () => null });
    const session = createUploadSession(selection(3), harness.deps);

    await session.start();

    expect(harness.last()).toMatchObject({
      phase: 'partial',
      uploadedCount: 0,
      error: { message: 'Not enough storage space to prepare these photos.' },
    });
    expect(harness.uploads).toHaveLength(0);
  });
});

describe('cancel', () => {
  it('discards every owned temp file', async () => {
    const harness = createHarness({ encodedBytes: 10 * MIB });
    const session = createUploadSession(selection(12), harness.deps);

    const original = harness.deps.uploadBatch;
    harness.deps.uploadBatch = async (files, onProgress) => {
      const result = await original(files, onProgress);
      session.requestStop();
      return result;
    };
    await session.start();

    await session.cancel();

    expect(harness.tempFiles.size).toBe(0);
    expect(harness.last().phase).toBe('cancelled');
  });
});
