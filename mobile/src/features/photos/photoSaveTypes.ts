import type { AuthTicket } from '@/shared/api/authSessionLifecycle';
import type {
  PhotoSaveRunHandle,
  PhotoSaveStoreTicket,
  PhotoSaveTempCoordinator,
} from '@/shared/media/photoSaveTempStore';
import type { ProtectedTransport } from '@/shared/media/protectedAssetTypes';
import type { TripPhotoScope, TripPhotoScopeTicket } from './hooks/useTripPhotoScope';
import type { PhotoFailure } from './errors';

export type PhotoSaveLedgerStatus =
  | 'committed'
  | 'terminalSkipped'
  | 'retryableFailed'
  | 'unknown'
  | 'unattempted';

export interface PhotoPermissionResult {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}

export interface PhotoLibraryAdapter {
  requestAddOnlyPermission(): Promise<PhotoPermissionResult>;
  createAsset(fileUri: string): Promise<void>;
}

export interface PhotoSaveCapturedTickets {
  readonly auth: AuthTicket;
  readonly trip: TripPhotoScopeTicket;
  readonly store: PhotoSaveStoreTicket;
  /** Unique identity for the explicit action captured before its permission prompt. */
  readonly runId: symbol;
}

export type PhotoSaveInterruption =
  | 'cancelled'
  | 'background'
  | 'signOut'
  | 'tripChanged'
  | 'tripUnavailable';

export type PhotoSaveItemOutcome =
  | { status: 'committed' }
  | { status: 'terminalSkipped'; failure: PhotoFailure }
  | { status: 'retryableFailed'; failure: PhotoFailure }
  | { status: 'unknown'; failure: PhotoFailure }
  | {
      status: 'unattempted';
      interruption: PhotoSaveInterruption;
      failure?: PhotoFailure;
    };

export interface PhotoSaveGate {
  /** Additional runner/user intent guard, checked at every commit boundary. */
  isOpen(): boolean;
  /** Exact authoritative tombstone, never inferred from page-one absence. */
  isTombstoned(photoId: string): boolean;
  interruption(): PhotoSaveInterruption;
}

export type AmbiguousNotFoundResolution = 'photo' | 'trip' | 'unknown';

export interface SaveOneTripPhotoOptions {
  tripId: string;
  photoId: string;
  captured: PhotoSaveCapturedTickets;
  tripScope: TripPhotoScope;
  coordinator: PhotoSaveTempCoordinator;
  run: PhotoSaveRunHandle;
  library: PhotoLibraryAdapter;
  gate: PhotoSaveGate;
  transport?: ProtectedTransport;
  signal?: AbortSignal;
  onStage?: (stage: 'downloading' | 'saving') => void;
  /** Fires only after the irreversible native mutation has been invoked. */
  onCommitStarted?: () => void;
  onProgress?: (bytesWritten: number) => void;
  onTombstone?: (photoId: string) => void;
  onTripUnavailable?: (failure: PhotoFailure) => void;
  resolveAmbiguousNotFound?: (
    photoId: string,
    failure: PhotoFailure,
  ) => Promise<AmbiguousNotFoundResolution>;
}

export interface PhotoSaveActionLock {
  /** Returns an idempotent release, or null when another action already owns it. */
  tryAcquire(): (() => void) | null;
}
