import type {
  AuthLifecycleSnapshot,
  AuthTicket,
} from '@/shared/api/authSessionLifecycle';

export type RealtimeStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface RealtimeEnvelope {
  type: string;
  [key: string]: unknown;
}

export type RealtimeOwner = AuthTicket;

export interface RealtimeSnapshot {
  status: RealtimeStatus;
  connectionEpoch: number;
}

export interface PublishedAuthLifecycleSnapshot extends AuthLifecycleSnapshot {
  publishedCredentialRevision: number | null;
}

export type RealtimeMessageListener = (message: RealtimeEnvelope) => void;
export type RealtimeSnapshotListener = (snapshot: RealtimeSnapshot) => void;

export interface RealtimeTransport {
  send(message: RealtimeEnvelope): boolean;
  subscribe(type: string, listener: RealtimeMessageListener): () => void;
  subscribeAll(listener: RealtimeMessageListener): () => void;
}

export interface RealtimeManager extends RealtimeTransport {
  connect(owner: RealtimeOwner): void;
  restart(owner: RealtimeOwner): void;
  disconnect(reason: RealtimeDisconnectReason): void;
  subscribeSnapshot(listener: RealtimeSnapshotListener): () => void;
  getSnapshot(): RealtimeSnapshot;
  destroy(): void;
}

export type RealtimeDisconnectReason =
  | 'auth'
  | 'background'
  | 'offline'
  | 'unmount';

export type ConnectivityAvailability = 'unknown' | 'offline' | 'online';

export interface ConnectivitySnapshot {
  availability: ConnectivityAvailability;
  type: string | null;
}

export interface NetworkObserver {
  getCurrent(): Promise<ConnectivitySnapshot>;
  subscribe(listener: (snapshot: ConnectivitySnapshot) => void): () => void;
}

export type RealtimeAppState = 'active' | 'inactive';

export interface AppStateObserver {
  getCurrent(): RealtimeAppState;
  subscribe(listener: (state: RealtimeAppState) => void): () => void;
}

export interface AuthLifecycleSource {
  getSnapshot(): PublishedAuthLifecycleSnapshot;
  subscribe(
    listener: (snapshot: PublishedAuthLifecycleSnapshot) => void,
  ): () => void;
}
