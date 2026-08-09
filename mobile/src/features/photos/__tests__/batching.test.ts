import {
  addToBatch,
  createUploadBatches,
  DEFAULT_UPLOAD_BATCH_LIMITS,
  emptyBatch,
  isUnsendableAlone,
  planUploadBatches,
  pixelsOf,
  wouldExceedBatchLimits,
  type UploadBatch,
} from '../batching';
import { PHOTO_UPLOAD_BATCH_LIMITS } from '../constants';
import type { PreparedUpload } from '../uploadTypes';

const MIB = 1024 * 1024;

let nextId = 0;

function file(overrides: Partial<PreparedUpload> = {}): PreparedUpload {
  nextId += 1;
  return {
    id: `f${nextId}`,
    uri: `file:///tmp/${nextId}.jpg`,
    name: `${nextId}.jpg`,
    type: 'image/jpeg',
    bytes: 1024,
    width: 100,
    height: 100,
    ...overrides,
  };
}

/** A preprocessed 4:3 iPhone photo: 2560×1920. */
function photo43(): PreparedUpload {
  return file({ width: 2560, height: 1920, bytes: 1 * MIB });
}

/** A preprocessed square photo: 2560×2560. */
function photo11(): PreparedUpload {
  return file({ width: 2560, height: 2560, bytes: 1 * MIB });
}

/** A preprocessed 16:9 photo: 2560×1440. */
function photo169(): PreparedUpload {
  return file({ width: 2560, height: 1440, bytes: 1 * MIB });
}

function many(count: number, make: () => PreparedUpload): PreparedUpload[] {
  return Array.from({ length: count }, make);
}

function sizes(batches: UploadBatch[]): number[] {
  return batches.map((batch) => batch.files.length);
}

beforeEach(() => {
  nextId = 0;
});

describe('limits', () => {
  it('uses the client ceiling, which sits under the server ceiling on purpose', () => {
    expect(PHOTO_UPLOAD_BATCH_LIMITS.maxFiles).toBe(20);
    expect(PHOTO_UPLOAD_BATCH_LIMITS.maxBytes).toBe(50 * MIB);
    expect(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels).toBe(85_000_000);
    // The server enforces 90 MP; the margin is what keeps a measurement that
    // drifts slightly from turning into an ambiguous rejection.
    expect(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels).toBeLessThan(90_000_000);
  });
});

describe('file counts', () => {
  it('returns nothing for an empty selection', () => {
    expect(createUploadBatches([])).toEqual([]);
  });

  it.each([1, 19, 20])('fits %i small files into a single batch', (count) => {
    expect(sizes(createUploadBatches(many(count, () => file())))).toEqual([count]);
  });

  it('splits at the file-count ceiling', () => {
    expect(sizes(createUploadBatches(many(21, () => file())))).toEqual([20, 1]);
    expect(sizes(createUploadBatches(many(60, () => file())))).toEqual([20, 20, 20]);
  });
});

describe('byte ceiling', () => {
  it('keeps a batch that is exactly at the limit whole', () => {
    const batches = createUploadBatches(many(5, () => file({ bytes: 10 * MIB })));

    expect(sizes(batches)).toEqual([5]);
    expect(batches[0].totalBytes).toBe(50 * MIB);
  });

  it('splits when one more byte would cross it', () => {
    // Five 10 MiB files land exactly on the 50 MiB request cap; a single extra
    // byte has to start a new batch. Each file stays inside the 10 MiB per-file
    // cap, so nothing here is rejected outright.
    const files = [...many(5, () => file({ bytes: 10 * MIB })), file({ bytes: 1 })];

    expect(sizes(createUploadBatches(files))).toEqual([5, 1]);
  });

  it('splits 60 ten-megabyte files into twelve batches of five', () => {
    const batches = createUploadBatches(many(60, () => file({ bytes: 10 * MIB })));

    expect(batches).toHaveLength(12);
    expect(sizes(batches)).toEqual(Array.from({ length: 12 }, () => 5));
  });

  it('lets the byte ceiling bind before the file ceiling', () => {
    // Twenty files would pass the count cap, but not the byte cap.
    expect(sizes(createUploadBatches(many(20, () => file({ bytes: 6 * MIB }))))).toEqual([8, 8, 4]);
  });
});

describe('pixel ceiling — the constraint that makes 20-file batches impossible', () => {
  const perBatch43 = Math.floor(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / (2560 * 1920));
  const perBatch11 = Math.floor(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / (2560 * 2560));

  it('allows 17 preprocessed 4:3 photos per request, not 20', () => {
    // 20 × 4.92 MP = 98.3 MP, so a count-and-bytes batcher would build a request
    // the server rejects every time.
    expect(perBatch43).toBe(17);
    expect(sizes(createUploadBatches(many(19, photo43)))).toEqual([perBatch43, 19 - perBatch43]);
  });

  it('allows 12 preprocessed square photos per request', () => {
    expect(perBatch11).toBe(12);
    expect(sizes(createUploadBatches(many(14, photo11)))).toEqual([perBatch11, 14 - perBatch11]);
  });

  it('lets the file-count ceiling bind first for 16:9, which is less pixel-hungry', () => {
    // 23 would fit on pixels, so the count cap of 20 is what decides.
    expect(Math.floor(PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / (2560 * 1440))).toBe(23);
    expect(sizes(createUploadBatches(many(21, photo169)))).toEqual([20, 1]);
  });

  it('keeps a batch that lands exactly on the pixel ceiling whole, and splits one pixel later', () => {
    const exact = file({ width: PHOTO_UPLOAD_BATCH_LIMITS.maxPixels, height: 1, bytes: 1024 });
    expect(sizes(createUploadBatches([exact]))).toEqual([1]);

    const half = file({ width: PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / 2, height: 1, bytes: 1024 });
    const halfPlusOne = file({ width: PHOTO_UPLOAD_BATCH_LIMITS.maxPixels / 2 + 1, height: 1, bytes: 1024 });
    expect(sizes(createUploadBatches([half, half]))).toEqual([2]);
    expect(sizes(createUploadBatches([half, halfPlusOne]))).toEqual([1, 1]);
  });
});

describe('per-file rejection', () => {
  it('rejects a file larger than the per-file ceiling without failing the rest', () => {
    const oversized = file({ bytes: 11 * MIB });
    const plan = planUploadBatches([file(), oversized, file()]);

    expect(plan.rejected).toEqual([oversized]);
    expect(sizes(plan.batches)).toEqual([2]);
  });

  it('rejects a single file over the pixel ceiling rather than batching a certain failure', () => {
    // Impossible after preprocessing — 2560² is 6.55 MP — but reachable if the
    // preprocess step is ever bypassed.
    const huge = file({ width: 20_000, height: 20_000 });
    const plan = planUploadBatches([huge, file()]);

    expect(plan.rejected).toEqual([huge]);
    expect(sizes(plan.batches)).toEqual([1]);
  });

  it.each([
    ['zero bytes', { bytes: 0 }],
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
  ])('rejects a file with %s', (_label, overrides) => {
    expect(isUnsendableAlone(file(overrides))).toBe(true);
  });
});

describe('ordering', () => {
  it('preserves picker order across batch boundaries', () => {
    const files = many(25, () => file());

    const flattened = createUploadBatches(files).flatMap((batch) => batch.files.map((item) => item.id));

    expect(flattened).toEqual(files.map((item) => item.id));
  });
});

describe('regression guard', () => {
  it('never emits a batch that violates any ceiling, on a mixed fixture', () => {
    // Every aspect ratio and size class at once, so a change that fixes one
    // ceiling by breaking another cannot pass.
    const fixture = [
      ...many(9, photo43),
      ...many(7, photo11),
      ...many(11, photo169),
      ...many(4, () => file({ bytes: 9 * MIB, width: 2560, height: 1920 })),
      ...many(6, () => file({ bytes: 512 * 1024, width: 1024, height: 768 })),
    ];

    const { batches, rejected } = planUploadBatches(fixture);

    expect(rejected).toEqual([]);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.files.length).toBeGreaterThan(0);
      expect(batch.files.length).toBeLessThanOrEqual(DEFAULT_UPLOAD_BATCH_LIMITS.maxFiles);
      expect(batch.totalBytes).toBeLessThanOrEqual(DEFAULT_UPLOAD_BATCH_LIMITS.maxBytes);
      expect(batch.totalPixels).toBeLessThanOrEqual(DEFAULT_UPLOAD_BATCH_LIMITS.maxPixels);
      // Totals must describe the files actually in the batch.
      expect(batch.totalBytes).toBe(batch.files.reduce((sum, item) => sum + item.bytes, 0));
      expect(batch.totalPixels).toBe(batch.files.reduce((sum, item) => sum + pixelsOf(item), 0));
    }
    expect(batches.flatMap((batch) => batch.files)).toHaveLength(fixture.length);
  });

  it('uses integer arithmetic throughout', () => {
    const { batches } = planUploadBatches(many(30, photo43));

    for (const batch of batches) {
      expect(Number.isInteger(batch.totalBytes)).toBe(true);
      expect(Number.isInteger(batch.totalPixels)).toBe(true);
    }
  });
});

describe('shared boundary predicate', () => {
  it('makes the streaming pipeline agree with the planned batches', () => {
    const fixture = [...many(9, photo43), ...many(7, photo11), ...many(11, photo169)];

    // Assemble one file at a time, the way the runtime pipeline does.
    const streamed: UploadBatch[] = [];
    let current = emptyBatch();
    for (const candidate of fixture) {
      if (current.files.length > 0 && wouldExceedBatchLimits(current, candidate)) {
        streamed.push(current);
        current = emptyBatch();
      }
      current = addToBatch(current, candidate);
    }
    if (current.files.length > 0) {
      streamed.push(current);
    }

    expect(sizes(streamed)).toEqual(sizes(createUploadBatches(fixture)));
  });
});
