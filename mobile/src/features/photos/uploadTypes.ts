import type { UploadImageMimeType } from '@/shared/media/types';

/**
 * One preprocessed file, adopted into the upload temp namespace and ready to be
 * placed in a batch.
 *
 * `width`/`height` are what the encoder reported for the file it wrote, not what
 * the picker guessed and not the result of the client's own scaling arithmetic —
 * so the pixel budget is measured rather than estimated.
 */
export interface PreparedUpload {
  /** Stable id derived from picker order; survives retries and reordering. */
  id: string;
  uri: string;
  name: string;
  type: UploadImageMimeType;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Per-file state in the upload ledger.
 *
 * `unknown` is a distinct terminal state and not a synonym for `failed`: after a
 * network drop, a timeout, or any 5xx, the server may already have committed the
 * rows. Calling that "failed" invites a retry that duplicates photos.
 */
export type UploadItemState =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'rejected'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'unknown';

export interface UploadItem {
  id: string;
  /** 1-based position in the picker selection, for user-facing wording. */
  index: number;
  /** Picker-reported name when there was one. Never trusted for validation. */
  fileName: string | null;
  state: UploadItemState;
  /** Set for `rejected`; safe to display. */
  reason?: string;
}
