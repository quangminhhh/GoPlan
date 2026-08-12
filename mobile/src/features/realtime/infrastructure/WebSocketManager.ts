import { isAuthTicketCurrent } from '@/shared/api/authSessionLifecycle';
import {
  type RealtimeDiagnosticCategory,
  type RealtimeDiagnosticReason,
  type RealtimeDiagnostics,
  type RealtimeDisconnectReason,
  type RealtimeEnvelope,
  type RealtimeManager,
  type RealtimeMessageListener,
  type RealtimeOwner,
  type RealtimeSnapshot,
  type RealtimeSnapshotListener,
} from '../types';
import { realtimeTicketApi, TicketRequestError, type TicketApi } from './ticket-api';
import { resolveRealtimeWebSocketUrl } from './ws-url';

const WS_SUBPROTOCOL = 'goplan.realtime.v1';
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export const REALTIME_TIMING = {
  openTimeoutMs: 30_000,
  errorCloseGraceMs: 500,
  heartbeatIntervalMs: 25_000,
  heartbeatTimeoutMs: 30_000,
  maxReconnectAttempts: 10,
  maxBackoffMs: 30_000,
  throttleFallbackMs: 30_000,
  throttleMaxMs: 300_000,
  jitterMaxMs: 1_000,
} as const;

interface SocketOpenTimeout {
  handle: TimerHandle | null;
  socket: RealtimeSocket;
}

interface SocketErrorCloseTimeout {
  handle: TimerHandle | null;
  socket: RealtimeSocket;
}

interface ReconnectTimeout {
  handle: TimerHandle | null;
}

interface HeartbeatTimeout {
  handle: TimerHandle | null;
}

interface HeartbeatInterval {
  handle: TimerHandle | null;
}

interface ReconnectCause {
  reason: RealtimeDiagnosticReason;
  category: RealtimeDiagnosticCategory;
  closeCode?: number | null;
}

export interface RealtimeSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketFactory = (
  url: string,
  protocols: string[],
) => RealtimeSocket;

type TimerHandle = ReturnType<typeof setTimeout>;
type TicketRequestKind = 'issue' | 'refresh';

const INITIAL_DIAGNOSTICS: RealtimeDiagnostics = {
  phase: 'idle',
  reason: null,
  category: null,
  terminal: false,
  closeCode: null,
  reconnectAttempt: 0,
  retryDelayMs: null,
  ticketPhase: null,
  heartbeat: 'inactive',
};

export interface RealtimeScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface WebSocketManagerDependencies {
  ticketApi: TicketApi;
  socketFactory: RealtimeSocketFactory;
  resolveUrl: () => string;
  isOwnerCurrent: (owner: RealtimeOwner) => boolean;
  scheduler: RealtimeScheduler;
  random: () => number;
}

class NativeRealtimeSocket implements RealtimeSocket {
  private readonly socket: WebSocket;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.socket = new WebSocket(url, protocols);
    this.socket.onopen = () => this.onopen?.();
    this.socket.onmessage = (event) => this.onmessage?.({ data: event.data });
    this.socket.onclose = (event) => this.onclose?.({ code: event.code });
    this.socket.onerror = () => this.onerror?.();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

const nativeScheduler: RealtimeScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

function sameOwner(left: RealtimeOwner | null, right: RealtimeOwner): boolean {
  return (
    left !== null &&
    left.sessionGeneration === right.sessionGeneration &&
    left.credentialRevision === right.credentialRevision
  );
}

function copyOwner(owner: RealtimeOwner): RealtimeOwner {
  return {
    sessionGeneration: owner.sessionGeneration,
    credentialRevision: owner.credentialRevision,
  };
}

function isRealtimeEnvelope(value: unknown): value is RealtimeEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'type' in value &&
    typeof value.type === 'string' &&
    value.type.length > 0
  );
}

function authErrorCode(message: RealtimeEnvelope): string | null {
  return typeof message.code === 'string' ? message.code : null;
}

export class WebSocketManager implements RealtimeManager {
  private socket: RealtimeSocket | null = null;
  private snapshot: RealtimeSnapshot = {
    status: 'disconnected',
    connectionEpoch: 0,
    diagnostics: { ...INITIAL_DIAGNOSTICS },
  };
  private currentOwner: RealtimeOwner | null = null;
  private hardStoppedOwner: RealtimeOwner | null = null;
  private connectRequestId = 0;
  private isConnecting = false;
  private reconnectAttempt = 0;
  private reconnectBootstrapUsed = false;
  private reconnectTimer: ReconnectTimeout | null = null;
  private openTimeout: SocketOpenTimeout | null = null;
  private errorCloseTimeout: SocketErrorCloseTimeout | null = null;
  private heartbeatTimer: HeartbeatInterval | null = null;
  private heartbeatTimeoutTimer: HeartbeatTimeout | null = null;
  private awaitingPong = false;
  private destroyed = false;

  private readonly messageListeners = new Map<string, Set<RealtimeMessageListener>>();
  private readonly allMessageListeners = new Set<RealtimeMessageListener>();
  private readonly snapshotListeners = new Set<RealtimeSnapshotListener>();

  constructor(private readonly dependencies: WebSocketManagerDependencies) {}

  connect(owner: RealtimeOwner): void {
    if (!this.canUseOwner(owner)) return;
    if (
      sameOwner(this.currentOwner, owner) &&
      this.snapshot.diagnostics?.terminal === true
    ) {
      return;
    }
    if (!sameOwner(this.currentOwner, owner)) {
      this.invalidateWork(true);
      this.currentOwner = copyOwner(owner);
      this.hardStoppedOwner = null;
    }
    if (
      this.isConnecting ||
      this.reconnectTimer !== null ||
      this.socket?.readyState === SOCKET_OPEN ||
      this.socket?.readyState === SOCKET_CONNECTING
    ) {
      return;
    }

    const status = this.snapshot.connectionEpoch > 0 ? 'reconnecting' : 'connecting';
    if (status === 'connecting') {
      this.updateSnapshot(status, {
        reason: null,
        category: null,
        terminal: false,
        closeCode: null,
        reconnectAttempt: 0,
        retryDelayMs: null,
      });
    }
    this.beginTicketRequest(owner, 'issue', status);
  }

  restart(owner: RealtimeOwner): void {
    if (!this.canUseOwner(owner)) return;
    this.invalidateWork(true);
    this.currentOwner = copyOwner(owner);
    this.hardStoppedOwner = null;
    this.updateSnapshot('reconnecting', {
      phase: 'idle',
      reason: 'runtime_restart',
      category: 'lifecycle',
      terminal: false,
      closeCode: null,
      reconnectAttempt: 0,
      retryDelayMs: null,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
    this.beginTicketRequest(owner, 'issue', 'reconnecting');
  }

  disconnect(reason: RealtimeDisconnectReason): void {
    if (this.destroyed) return;
    const preserveAuthenticationFailure =
      (reason === 'background' || reason === 'offline') &&
      this.snapshot.diagnostics?.reason === 'authentication_failed' &&
      this.snapshot.diagnostics.terminal === true &&
      this.currentOwner !== null &&
      sameOwner(this.hardStoppedOwner, this.currentOwner);
    this.invalidateWork(true);
    this.currentOwner = null;
    if (preserveAuthenticationFailure) return;
    this.updateSnapshot('disconnected', {
      phase: 'stopped',
      reason: this.disconnectDiagnosticReason(reason),
      category: 'lifecycle',
      terminal: reason === 'unmount',
      closeCode: null,
      reconnectAttempt: 0,
      retryDelayMs: null,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
  }

  send(message: RealtimeEnvelope): boolean {
    const socket = this.socket;
    const owner = this.currentOwner;
    const requestId = this.connectRequestId;
    if (
      this.snapshot.status !== 'connected' ||
      socket?.readyState !== SOCKET_OPEN ||
      owner === null
    ) {
      return false;
    }

    let serialized: string;
    try {
      const encoded = JSON.stringify(message);
      if (encoded === undefined) return false;
      serialized = encoded;
    } catch {
      return false;
    }

    try {
      socket.send(serialized);
      return true;
    } catch {
      this.failActiveSocket(socket, owner, requestId, {
        reason: 'send_failed',
        category: 'transport',
      });
      return false;
    }
  }

  retryConnection(): boolean {
    const owner = this.currentOwner;
    if (
      this.destroyed ||
      owner === null ||
      this.snapshot.diagnostics?.terminal !== true ||
      this.snapshot.diagnostics.reason !== 'retry_exhausted'
    ) {
      return false;
    }

    this.restart(owner);
    return this.snapshot.status === 'reconnecting';
  }

  subscribe(type: string, listener: RealtimeMessageListener): () => void {
    let listeners = this.messageListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.messageListeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.messageListeners.delete(type);
      }
    };
  }

  subscribeAll(listener: RealtimeMessageListener): () => void {
    this.allMessageListeners.add(listener);
    return () => this.allMessageListeners.delete(listener);
  }

  subscribeSnapshot(listener: RealtimeSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  getSnapshot(): RealtimeSnapshot {
    return this.snapshot;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.disconnect('unmount');
    this.destroyed = true;
    this.messageListeners.clear();
    this.allMessageListeners.clear();
    this.snapshotListeners.clear();
  }

  private canUseOwner(owner: RealtimeOwner): boolean {
    return (
      !this.destroyed &&
      this.dependencies.isOwnerCurrent(owner) &&
      !sameOwner(this.hardStoppedOwner, owner)
    );
  }

  private beginTicketRequest(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    status: 'connecting' | 'reconnecting',
  ): void {
    if (!this.canUseOwner(owner) || !sameOwner(this.currentOwner, owner)) return;

    let url: string;
    try {
      // Configuration is deterministic and must be validated before consuming a
      // single-use, throttled ticket.
      url = this.dependencies.resolveUrl();
    } catch {
      this.invalidateWork(true);
      this.currentOwner = copyOwner(owner);
      this.updateSnapshot('disconnected', {
        phase: 'stopped',
        reason: 'invalid_configuration',
        category: 'configuration',
        terminal: true,
        closeCode: null,
        reconnectAttempt: 0,
        retryDelayMs: null,
        ticketPhase: null,
        heartbeat: 'inactive',
      });
      return;
    }

    this.clearReconnectTimer();
    const requestId = ++this.connectRequestId;
    this.isConnecting = true;
    this.updateSnapshot(status, {
      phase: 'requesting_ticket',
      terminal: false,
      reconnectAttempt: this.reconnectAttempt,
      retryDelayMs: null,
      ticketPhase: requestKind,
      heartbeat: 'inactive',
    });
    void this.fetchTicket(url, owner, requestId, requestKind);
  }

  private async fetchTicket(
    url: string,
    owner: RealtimeOwner,
    requestId: number,
    requestKind: TicketRequestKind,
  ): Promise<void> {
    try {
      const ticket =
        requestKind === 'refresh'
          ? await this.dependencies.ticketApi.refresh()
          : await this.dependencies.ticketApi.issue();
      if (!this.isAttemptCurrent(owner, requestId)) return;
      this.openSocket(url, ticket, owner, requestId);
    } catch (error) {
      if (!this.isAttemptCurrent(owner, requestId)) return;
      this.isConnecting = false;
      this.handleTicketFailure(owner, requestKind, error);
    }
  }

  private openSocket(
    url: string,
    ticket: string,
    owner: RealtimeOwner,
    requestId: number,
  ): void {
    if (!this.isAttemptCurrent(owner, requestId)) return;

    let socket: RealtimeSocket;
    try {
      socket = this.dependencies.socketFactory(url, [WS_SUBPROTOCOL, ticket]);
    } catch {
      this.isConnecting = false;
      this.scheduleReconnect(owner, 'issue', {
        reason: 'socket_factory_failed',
        category: 'transport',
      });
      return;
    }

    this.socket = socket;
    let authHandled = false;
    // An open handshake alone is not evidence of a healthy connection. Keep
    // the retry budget across short-lived sockets until this socket answers a
    // heartbeat that the client actually sent.
    let stabilityConfirmed = false;
    this.updateSnapshot(this.snapshot.status, {
      phase: 'opening_socket',
      ticketPhase: null,
    });
    this.startOpenTimeout(socket, owner, requestId);

    socket.onopen = () => {
      this.clearOpenTimeout(socket);
      this.clearErrorCloseTimeout(socket);
      if (!this.isActiveSocket(socket, owner, requestId)) {
        this.detachSocket(socket, true);
        return;
      }
      this.isConnecting = false;
      this.clearReconnectTimer();
      this.startHeartbeat(socket, owner, requestId);
      this.markConnected();
    };

    socket.onmessage = (event) => {
      if (!this.isActiveSocket(socket, owner, requestId)) return;
      const message = this.parseMessage(event.data);
      if (!message) return;

      if (message.type === 'auth_error') {
        this.clearOpenTimeout(socket);
        authHandled = true;
        this.detachSocket(socket, true);
        this.stopHeartbeat();
        if (authErrorCode(message) === 'token_expired') {
          this.handleTokenExpiry(owner);
        } else {
          this.hardStop(owner);
        }
        return;
      }

      if (message.type === 'pong') {
        if (this.snapshot.status !== 'connected') return;
        const answeredHeartbeat = this.awaitingPong;
        this.clearHeartbeatTimeout();
        if (!stabilityConfirmed && answeredHeartbeat) {
          stabilityConfirmed = true;
          this.reconnectAttempt = 0;
          this.reconnectBootstrapUsed = false;
          this.updateDiagnostics({
            reconnectAttempt: 0,
            retryDelayMs: null,
            heartbeat: 'scheduled',
          });
        } else {
          this.updateDiagnostics({ heartbeat: 'scheduled' });
        }
        return;
      }

      this.emit(message);
    };

    socket.onclose = (event) => {
      this.clearOpenTimeout(socket);
      this.clearErrorCloseTimeout(socket);
      if (authHandled || !this.isActiveSocket(socket, owner, requestId)) return;
      this.detachSocket(socket, false);
      this.isConnecting = false;
      this.stopHeartbeat();

      if (event.code === 4002) {
        this.handleTokenExpiry(owner, event.code);
      } else if (event.code === 4001) {
        this.hardStop(owner, event.code);
      } else {
        this.handleNetworkClose(owner, {
          reason: 'socket_closed',
          category: 'transport',
          closeCode: event.code,
        });
      }
    };

    socket.onerror = () => {
      if (!this.isActiveSocket(socket, owner, requestId)) return;

      // Native implementations normally publish a close after an error, but
      // React Native does not guarantee it. Leave the handlers attached briefly
      // so an authoritative close code can win, while immediately leaving the
      // falsely-connected UI state and bounding the no-close path.
      this.clearOpenTimeout(socket);
      this.stopHeartbeat();
      this.updateSnapshot(
        this.snapshot.connectionEpoch > 0 ? 'reconnecting' : 'connecting',
        {
          phase: 'awaiting_close',
          reason: 'socket_error',
          category: 'transport',
          terminal: false,
          retryDelayMs: null,
          ticketPhase: null,
          heartbeat: 'inactive',
        },
      );
      this.startErrorCloseTimeout(socket, owner, requestId);
    };
  }

  private startOpenTimeout(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
  ): void {
    this.clearOpenTimeout();
    const timeout: SocketOpenTimeout = { handle: null, socket };
    this.openTimeout = timeout;
    timeout.handle = this.dependencies.scheduler.setTimeout(() => {
      if (this.openTimeout !== timeout) return;
      this.openTimeout = null;
      if (
        !this.isConnecting ||
        socket.readyState !== SOCKET_CONNECTING ||
        !this.isActiveSocket(socket, owner, requestId)
      ) {
        return;
      }
      this.detachSocket(socket, true);
      this.isConnecting = false;
      this.stopHeartbeat();
      this.handleNetworkClose(owner, {
        reason: 'socket_open_timeout',
        category: 'transport',
      });
    }, REALTIME_TIMING.openTimeoutMs);
  }

  private clearOpenTimeout(socket?: RealtimeSocket): void {
    const timeout = this.openTimeout;
    if (timeout === null || (socket && timeout.socket !== socket)) return;
    this.openTimeout = null;
    if (timeout.handle !== null) {
      this.dependencies.scheduler.clearTimeout(timeout.handle);
    }
  }

  private startErrorCloseTimeout(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
  ): void {
    if (this.errorCloseTimeout?.socket === socket) return;
    this.clearErrorCloseTimeout();
    const timeout: SocketErrorCloseTimeout = { handle: null, socket };
    this.errorCloseTimeout = timeout;
    timeout.handle = this.dependencies.scheduler.setTimeout(() => {
      if (this.errorCloseTimeout !== timeout) return;
      this.errorCloseTimeout = null;
      if (!this.isActiveSocket(socket, owner, requestId)) return;

      this.detachSocket(socket, true);
      this.isConnecting = false;
      this.stopHeartbeat();
      this.handleNetworkClose(owner, {
        reason: 'socket_error_without_close',
        category: 'transport',
      });
    }, REALTIME_TIMING.errorCloseGraceMs);
  }

  private clearErrorCloseTimeout(socket?: RealtimeSocket): void {
    const timeout = this.errorCloseTimeout;
    if (timeout === null || (socket && timeout.socket !== socket)) return;
    this.errorCloseTimeout = null;
    if (timeout.handle !== null) {
      this.dependencies.scheduler.clearTimeout(timeout.handle);
    }
  }

  private parseMessage(raw: unknown): RealtimeEnvelope | null {
    if (typeof raw !== 'string') return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isRealtimeEnvelope(value) ? value : null;
    } catch {
      return null;
    }
  }

  private handleTicketFailure(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    error: unknown,
  ): void {
    if (error instanceof TicketRequestError) {
      if (error.kind === 'hardAuth') {
        this.hardStop(owner);
        return;
      }
      if (error.kind === 'throttled') {
        this.scheduleThrottledReconnect(owner, requestKind, error.retryAfterMs);
        return;
      }
    }
    this.scheduleReconnect(owner, requestKind, {
      reason: 'ticket_request_failed',
      category: 'ticket',
    });
  }

  private handleTokenExpiry(
    owner: RealtimeOwner,
    closeCode: number | null = null,
  ): void {
    const cause: ReconnectCause = {
      reason: 'token_expired',
      category: 'authentication',
      closeCode,
    };
    this.updateSnapshot('reconnecting', {
      reason: cause.reason,
      category: cause.category,
      terminal: false,
      closeCode,
      retryDelayMs: null,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
    if (!this.reconnectBootstrapUsed) {
      this.reconnectBootstrapUsed = true;
      this.beginTicketRequest(owner, 'refresh', 'reconnecting');
      return;
    }
    this.scheduleReconnect(owner, 'refresh', cause);
  }

  private handleNetworkClose(owner: RealtimeOwner, cause: ReconnectCause): void {
    this.updateSnapshot('reconnecting', {
      reason: cause.reason,
      category: cause.category,
      terminal: false,
      closeCode: cause.closeCode ?? null,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
    if (!this.reconnectBootstrapUsed) {
      this.reconnectBootstrapUsed = true;
      this.beginTicketRequest(owner, 'issue', 'reconnecting');
      return;
    }
    this.scheduleReconnect(owner, 'issue', cause);
  }

  private scheduleReconnect(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    cause: ReconnectCause,
  ): void {
    if (!this.canUseOwner(owner) || !sameOwner(this.currentOwner, owner)) return;
    if (this.reconnectAttempt >= REALTIME_TIMING.maxReconnectAttempts) {
      this.isConnecting = false;
      this.updateSnapshot('disconnected', {
        phase: 'stopped',
        reason: 'retry_exhausted',
        category: 'retry',
        terminal: true,
        reconnectAttempt: this.reconnectAttempt,
        retryDelayMs: null,
        ticketPhase: null,
        heartbeat: 'inactive',
      });
      return;
    }

    const baseDelay = Math.min(
      1_000 * 2 ** this.reconnectAttempt,
      REALTIME_TIMING.maxBackoffMs,
    );
    this.reconnectAttempt += 1;
    this.scheduleRetry(
      owner,
      requestKind,
      baseDelay + this.jitterMs(),
      cause,
    );
  }

  private scheduleThrottledReconnect(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    retryAfterMs: number | null,
  ): void {
    const requestedDelay = retryAfterMs ?? REALTIME_TIMING.throttleFallbackMs;
    const delay = Math.min(
      requestedDelay + this.jitterMs(),
      REALTIME_TIMING.throttleMaxMs,
    );
    this.scheduleRetry(owner, requestKind, delay, {
      reason: 'ticket_throttled',
      category: 'ticket',
    });
  }

  private scheduleRetry(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    delayMs: number,
    cause: ReconnectCause,
  ): void {
    if (!this.canUseOwner(owner) || !sameOwner(this.currentOwner, owner)) return;
    this.clearReconnectTimer();
    this.isConnecting = false;
    this.updateSnapshot('reconnecting', {
      phase: 'waiting_retry',
      reason: cause.reason,
      category: cause.category,
      terminal: false,
      closeCode:
        cause.closeCode === undefined
          ? this.snapshot.diagnostics?.closeCode ?? null
          : cause.closeCode,
      reconnectAttempt: this.reconnectAttempt,
      retryDelayMs: delayMs,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
    const timeout: ReconnectTimeout = { handle: null };
    this.reconnectTimer = timeout;
    timeout.handle = this.dependencies.scheduler.setTimeout(() => {
      if (this.reconnectTimer !== timeout) return;
      this.reconnectTimer = null;
      this.beginTicketRequest(owner, requestKind, 'reconnecting');
    }, delayMs);
  }

  private jitterMs(): number {
    return Math.max(0, Math.min(1, this.dependencies.random())) * REALTIME_TIMING.jitterMaxMs;
  }

  private startHeartbeat(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
  ): void {
    this.stopHeartbeat();
    const interval: HeartbeatInterval = { handle: null };
    this.heartbeatTimer = interval;
    interval.handle = this.dependencies.scheduler.setInterval(() => {
      if (
        this.heartbeatTimer !== interval ||
        this.snapshot.status !== 'connected' ||
        this.awaitingPong ||
        !this.isActiveSocket(socket, owner, requestId) ||
        socket.readyState !== SOCKET_OPEN
      ) {
        return;
      }
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.failActiveSocket(socket, owner, requestId, {
          reason: 'heartbeat_send_failed',
          category: 'heartbeat',
        });
        return;
      }
      this.awaitingPong = true;
      this.updateDiagnostics({ heartbeat: 'awaiting_pong' });
      const timeout: HeartbeatTimeout = { handle: null };
      this.heartbeatTimeoutTimer = timeout;
      timeout.handle = this.dependencies.scheduler.setTimeout(() => {
        if (this.heartbeatTimeoutTimer !== timeout) return;
        this.heartbeatTimeoutTimer = null;
        this.failActiveSocket(socket, owner, requestId, {
          reason: 'heartbeat_timeout',
          category: 'heartbeat',
        });
      }, REALTIME_TIMING.heartbeatTimeoutMs);
    }, REALTIME_TIMING.heartbeatIntervalMs);
  }

  private failActiveSocket(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
    cause: ReconnectCause,
  ): void {
    if (!this.isActiveSocket(socket, owner, requestId)) return;
    this.detachSocket(socket, true);
    this.isConnecting = false;
    this.stopHeartbeat();
    this.handleNetworkClose(owner, cause);
  }

  private stopHeartbeat(): void {
    const interval = this.heartbeatTimer;
    this.heartbeatTimer = null;
    if (interval !== null && interval.handle !== null) {
      this.dependencies.scheduler.clearInterval(interval.handle);
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    const timeout = this.heartbeatTimeoutTimer;
    this.heartbeatTimeoutTimer = null;
    if (timeout !== null && timeout.handle !== null) {
      this.dependencies.scheduler.clearTimeout(timeout.handle);
    }
    this.awaitingPong = false;
  }

  private hardStop(owner: RealtimeOwner, closeCode: number | null = null): void {
    this.hardStoppedOwner = copyOwner(owner);
    this.invalidateWork(true);
    this.currentOwner = copyOwner(owner);
    this.updateSnapshot('disconnected', {
      phase: 'stopped',
      reason: 'authentication_failed',
      category: 'authentication',
      terminal: true,
      closeCode,
      reconnectAttempt: 0,
      retryDelayMs: null,
      ticketPhase: null,
      heartbeat: 'inactive',
    });
  }

  private invalidateWork(resetAttempts: boolean): void {
    this.connectRequestId += 1;
    this.isConnecting = false;
    this.clearReconnectTimer();
    this.clearOpenTimeout();
    this.clearErrorCloseTimeout();
    this.stopHeartbeat();
    if (this.socket !== null) {
      this.detachSocket(this.socket, true);
    }
    if (resetAttempts) {
      this.reconnectAttempt = 0;
      this.reconnectBootstrapUsed = false;
    }
  }

  private clearReconnectTimer(): void {
    const timeout = this.reconnectTimer;
    this.reconnectTimer = null;
    if (timeout !== null && timeout.handle !== null) {
      this.dependencies.scheduler.clearTimeout(timeout.handle);
    }
  }

  private detachSocket(socket: RealtimeSocket, shouldClose: boolean): void {
    this.clearOpenTimeout(socket);
    this.clearErrorCloseTimeout(socket);
    if (this.socket === socket) {
      this.socket = null;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (
      shouldClose &&
      (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING)
    ) {
      try {
        socket.close(1000, 'Realtime connection replaced');
      } catch {
        // The reference is already invalidated; native close failure is non-fatal.
      }
    }
  }

  private isAttemptCurrent(owner: RealtimeOwner, requestId: number): boolean {
    return (
      requestId === this.connectRequestId &&
      sameOwner(this.currentOwner, owner) &&
      this.canUseOwner(owner)
    );
  }

  private isActiveSocket(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
  ): boolean {
    return this.socket === socket && this.isAttemptCurrent(owner, requestId);
  }

  private markConnected(): void {
    this.snapshot = {
      status: 'connected',
      connectionEpoch: this.snapshot.connectionEpoch + 1,
      diagnostics: {
        ...INITIAL_DIAGNOSTICS,
        phase: 'open',
        reconnectAttempt: this.reconnectAttempt,
        heartbeat: 'scheduled',
      },
    };
    this.emitSnapshot();
  }

  private updateSnapshot(
    status: RealtimeSnapshot['status'],
    diagnosticsPatch: Partial<RealtimeDiagnostics>,
  ): void {
    const currentDiagnostics = this.snapshot.diagnostics ?? INITIAL_DIAGNOSTICS;
    const diagnostics = { ...currentDiagnostics, ...diagnosticsPatch };
    const diagnosticsChanged = (
      Object.keys(diagnosticsPatch) as (keyof RealtimeDiagnostics)[]
    ).some((key) => currentDiagnostics[key] !== diagnostics[key]);
    if (this.snapshot.status === status && !diagnosticsChanged) return;
    this.snapshot = { ...this.snapshot, status, diagnostics };
    this.emitSnapshot();
  }

  private updateDiagnostics(
    diagnosticsPatch: Partial<RealtimeDiagnostics>,
  ): void {
    this.updateSnapshot(this.snapshot.status, diagnosticsPatch);
  }

  private disconnectDiagnosticReason(
    reason: RealtimeDisconnectReason,
  ): RealtimeDiagnosticReason {
    if (reason === 'auth') return 'auth_unavailable';
    if (reason === 'unmount') return 'unmounted';
    return reason;
  }

  private emitSnapshot(): void {
    for (const listener of Array.from(this.snapshotListeners)) {
      try {
        listener(this.snapshot);
      } catch {
        // One UI observer must not prevent the remaining observers from updating.
      }
    }
  }

  private emit(message: RealtimeEnvelope): void {
    const listeners = this.messageListeners.get(message.type);
    const targets = [
      ...(listeners ? Array.from(listeners) : []),
      ...Array.from(this.allMessageListeners),
    ];
    for (const listener of targets) {
      try {
        listener(message);
      } catch {
        // Domain listeners are isolated from the transport and from each other.
      }
    }
  }
}

export function createDefaultWebSocketManager(): WebSocketManager {
  return new WebSocketManager({
    ticketApi: realtimeTicketApi,
    socketFactory: (url, protocols) => new NativeRealtimeSocket(url, protocols),
    resolveUrl: resolveRealtimeWebSocketUrl,
    isOwnerCurrent: isAuthTicketCurrent,
    scheduler: nativeScheduler,
    random: Math.random,
  });
}
