/**
 * Greedy batching across all three server ceilings (D14).
 *
 * Counting files and bytes is not enough, and the failure is systematic rather
 * than occasional: the server also caps total source pixels per request at
 * 90 MP, and twenty preprocessed 4:3 iPhone photos come to 20 × 4.92 MP =
 * 98.3 MP. A batcher that only knows about the first two ceilings therefore
 * builds a request that is rejected every single time.
 *
 * The client works to a lower 85 MP ceiling — see `PHOTO_UPLOAD_BATCH_LIMITS`
 * for why the margin exists. That is also why the batch sizes here are not the
 * ones the server would strictly allow: at 85 MP a full 4:3 batch is 17 files,
 * where the server would have taken 18.
 *
 * This module is pure. The streaming pipeline in `uploadSession` reuses
 * `wouldExceedBatchLimits` so a batch assembled one file at a time lands on
 * exactly the same boundaries as one planned up front.
 */

import { PHOTO_UPLOAD_BATCH_LIMITS } from './constants';
import type { PreparedUpload } from './uploadTypes';

export interface UploadBatch {
  files: PreparedUpload[];
  totalBytes: number;
  totalPixels: number;
}

export interface UploadBatchLimits {
  /** `_validate_upload_count` */
  maxFiles: number;
  /** `_validate_upload_total_bytes` */
  maxBytes: number;
  /** `_validate_upload_total_source_pixels`, with the client's own margin. */
  maxPixels: number;
  /**
   * `_validate_image_file`. Not a batching dimension — a file over this can
   * never be sent at all, so it is rejected rather than placed in a batch that
   * is guaranteed to fail.
   */
  maxFileBytes: number;
}

export const DEFAULT_UPLOAD_BATCH_LIMITS: UploadBatchLimits = {
  ...PHOTO_UPLOAD_BATCH_LIMITS,
  maxFileBytes: 10 * 1024 * 1024,
};

export function pixelsOf(file: PreparedUpload): number {
  return file.width * file.height;
}

/** True when a file cannot be sent in any conforming request on its own. */
export function isUnsendableAlone(
  file: PreparedUpload,
  limits: UploadBatchLimits = DEFAULT_UPLOAD_BATCH_LIMITS,
): boolean {
  return (
    file.bytes > limits.maxFileBytes ||
    file.bytes > limits.maxBytes ||
    pixelsOf(file) > limits.maxPixels ||
    !Number.isFinite(file.bytes) ||
    !Number.isFinite(pixelsOf(file)) ||
    file.bytes <= 0 ||
    pixelsOf(file) <= 0
  );
}

/**
 * Whether adding `candidate` to `batch` would cross any ceiling.
 *
 * Shared with the runtime pipeline so "plan the batches" and "fill a batch as
 * files arrive" can never disagree about where a boundary falls.
 */
export function wouldExceedBatchLimits(
  batch: UploadBatch,
  candidate: PreparedUpload,
  limits: UploadBatchLimits = DEFAULT_UPLOAD_BATCH_LIMITS,
): boolean {
  return (
    batch.files.length + 1 > limits.maxFiles ||
    batch.totalBytes + candidate.bytes > limits.maxBytes ||
    batch.totalPixels + pixelsOf(candidate) > limits.maxPixels
  );
}

export function emptyBatch(): UploadBatch {
  return { files: [], totalBytes: 0, totalPixels: 0 };
}

export function addToBatch(batch: UploadBatch, file: PreparedUpload): UploadBatch {
  return {
    files: [...batch.files, file],
    totalBytes: batch.totalBytes + file.bytes,
    totalPixels: batch.totalPixels + pixelsOf(file),
  };
}

export interface UploadBatchPlan {
  batches: UploadBatch[];
  /** Files no conforming request could ever carry. Reported per file. */
  rejected: PreparedUpload[];
}

export function planUploadBatches(
  files: PreparedUpload[],
  limits: UploadBatchLimits = DEFAULT_UPLOAD_BATCH_LIMITS,
): UploadBatchPlan {
  const batches: UploadBatch[] = [];
  const rejected: PreparedUpload[] = [];
  let current = emptyBatch();

  for (const file of files) {
    if (isUnsendableAlone(file, limits)) {
      // Per-file rejection: one impossible file must not fail the other 59.
      rejected.push(file);
      continue;
    }
    if (current.files.length > 0 && wouldExceedBatchLimits(current, file, limits)) {
      batches.push(current);
      current = emptyBatch();
    }
    current = addToBatch(current, file);
  }

  if (current.files.length > 0) {
    batches.push(current);
  }

  return { batches, rejected };
}

export function createUploadBatches(
  files: PreparedUpload[],
  limits: UploadBatchLimits = DEFAULT_UPLOAD_BATCH_LIMITS,
): UploadBatch[] {
  return planUploadBatches(files, limits).batches;
}
