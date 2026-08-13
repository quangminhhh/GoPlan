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
  /**
   * Safe transport diagnostics. The production manager always publishes this
   * object; it remains optional so injected test transports can keep a minimal
   * snapshot contract. It must never contain credentials, ticket values,
   * message payloads, URLs, or user identifiers.
   */
  diagnostics?: RealtimeDiagnostics;
}

export type RealtimeDiagnosticPhase =
  | 'idle'
  | 'requesting_ticket'
  | 'opening_socket'
  | 'open'
  | 'awaiting_close'
  | 'waiting_retry'
  | 'stopped';

export type RealtimeDiagnosticCategory =
  | 'lifecycle'
  | 'configuration'
  | 'authentication'
  | 'ticket'
  | 'transport'
  | 'heartbeat'
  | 'retry';

export type RealtimeDiagnosticReason =
  | 'auth_unavailable'
  | 'background'
  | 'offline'
  | 'unmounted'
  | 'runtime_restart'
  | 'invalid_configuration'
  | 'authentication_failed'
  | 'token_expired'
  | 'ticket_request_failed'
  | 'ticket_throttled'
  | 'socket_factory_failed'
  | 'socket_open_timeout'
  | 'socket_error'
  | 'socket_error_without_close'
  | 'socket_closed'
  | 'heartbeat_send_failed'
  | 'heartbeat_timeout'
  | 'send_failed'
  | 'retry_exhausted';

export interface RealtimeDiagnostics {
  phase: RealtimeDiagnosticPhase;
  reason: RealtimeDiagnosticReason | null;
  category: RealtimeDiagnosticCategory | null;
  /** No automatic recovery work remains for the current lifecycle state. */
  terminal: boolean;
  /** Last native close code only; close reasons are intentionally excluded. */
  closeCode: number | null;
  reconnectAttempt: number;
  retryDelayMs: number | null;
  /** Endpoint kind only. The single-use ticket value is never exposed. */
  ticketPhase: 'issue' | 'refresh' | null;
  heartbeat: 'inactive' | 'scheduled' | 'awaiting_pong';
}

export interface PublishedAuthLifecycleSnapshot extends AuthLifecycleSnapshot {
  publishedCredentialRevision: number | null;
}

export type RealtimeMessageListener = (message: RealtimeEnvelope) => void;
export type RealtimeSnapshotListener = (snapshot: RealtimeSnapshot) => void;

export interface RealtimeTransport {
  send(message: RealtimeEnvelope): boolean;
  /**
   * Restarts a transport that exhausted its automatic retry budget.
   * Returns false when no safe manual retry is currently available (for
   * example, authentication or configuration hard stops).
   */
  retryConnection(): boolean;
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
