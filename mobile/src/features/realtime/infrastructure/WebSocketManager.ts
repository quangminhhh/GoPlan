import { isAuthTicketCurrent } from '@/shared/api/authSessionLifecycle';
import {
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
  };
  private currentOwner: RealtimeOwner | null = null;
  private hardStoppedOwner: RealtimeOwner | null = null;
  private connectRequestId = 0;
  private isConnecting = false;
  private reconnectAttempt = 0;
  private reconnectBootstrapUsed = false;
  private reconnectTimer: TimerHandle | null = null;
  private openTimeout: SocketOpenTimeout | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private heartbeatTimeoutTimer: TimerHandle | null = null;
  private awaitingPong = false;
  private destroyed = false;

  private readonly messageListeners = new Map<string, Set<RealtimeMessageListener>>();
  private readonly allMessageListeners = new Set<RealtimeMessageListener>();
  private readonly snapshotListeners = new Set<RealtimeSnapshotListener>();

  constructor(private readonly dependencies: WebSocketManagerDependencies) {}

  connect(owner: RealtimeOwner): void {
    if (!this.canUseOwner(owner)) return;
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
    this.beginTicketRequest(owner, 'issue', status);
  }

  restart(owner: RealtimeOwner): void {
    if (!this.canUseOwner(owner)) return;
    this.invalidateWork(true);
    this.currentOwner = copyOwner(owner);
    this.hardStoppedOwner = null;
    this.beginTicketRequest(owner, 'issue', 'reconnecting');
  }

  disconnect(_reason: 'auth' | 'background' | 'offline' | 'unmount'): void {
    if (this.destroyed) return;
    this.invalidateWork(true);
    this.currentOwner = null;
    this.setStatus('disconnected');
  }

  send(message: RealtimeEnvelope): boolean {
    if (this.socket?.readyState !== SOCKET_OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
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
      this.setStatus('disconnected');
      return;
    }

    this.clearReconnectTimer();
    const requestId = ++this.connectRequestId;
    this.isConnecting = true;
    this.setStatus(status);
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
      this.scheduleReconnect(owner, 'issue');
      return;
    }

    this.socket = socket;
    let authHandled = false;
    this.startOpenTimeout(socket, owner, requestId);

    socket.onopen = () => {
      this.clearOpenTimeout(socket);
      if (!this.isActiveSocket(socket, owner, requestId)) {
        this.detachSocket(socket, true);
        return;
      }
      this.isConnecting = false;
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.reconnectBootstrapUsed = false;
      this.markConnected();
      this.startHeartbeat(socket, owner, requestId);
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
          this.beginTicketRequest(owner, 'refresh', 'reconnecting');
        } else {
          this.hardStop(owner);
        }
        return;
      }

      if (message.type === 'pong') {
        this.clearHeartbeatTimeout();
        return;
      }

      this.emit(message);
    };

    socket.onclose = (event) => {
      this.clearOpenTimeout(socket);
      if (authHandled || !this.isActiveSocket(socket, owner, requestId)) return;
      this.detachSocket(socket, false);
      this.isConnecting = false;
      this.stopHeartbeat();

      if (event.code === 4002) {
        this.beginTicketRequest(owner, 'refresh', 'reconnecting');
      } else if (event.code === 4001) {
        this.hardStop(owner);
      } else {
        this.handleNetworkClose(owner);
      }
    };

    socket.onerror = () => {
      // React Native reports a close after an error. The close code owns recovery.
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
      this.handleNetworkClose(owner);
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
    this.scheduleReconnect(owner, requestKind);
  }

  private handleNetworkClose(owner: RealtimeOwner): void {
    if (!this.reconnectBootstrapUsed) {
      this.reconnectBootstrapUsed = true;
      this.beginTicketRequest(owner, 'issue', 'reconnecting');
      return;
    }
    this.scheduleReconnect(owner, 'issue');
  }

  private scheduleReconnect(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
  ): void {
    if (!this.canUseOwner(owner) || !sameOwner(this.currentOwner, owner)) return;
    if (this.reconnectAttempt >= REALTIME_TIMING.maxReconnectAttempts) {
      this.isConnecting = false;
      this.setStatus('disconnected');
      return;
    }

    const baseDelay = Math.min(
      1_000 * 2 ** this.reconnectAttempt,
      REALTIME_TIMING.maxBackoffMs,
    );
    this.reconnectAttempt += 1;
    this.scheduleRetry(owner, requestKind, baseDelay + this.jitterMs());
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
    this.scheduleRetry(owner, requestKind, delay);
  }

  private scheduleRetry(
    owner: RealtimeOwner,
    requestKind: TicketRequestKind,
    delayMs: number,
  ): void {
    if (!this.canUseOwner(owner) || !sameOwner(this.currentOwner, owner)) return;
    this.clearReconnectTimer();
    this.isConnecting = false;
    this.setStatus('reconnecting');
    this.reconnectTimer = this.dependencies.scheduler.setTimeout(() => {
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
    this.heartbeatTimer = this.dependencies.scheduler.setInterval(() => {
      if (
        this.awaitingPong ||
        !this.isActiveSocket(socket, owner, requestId) ||
        socket.readyState !== SOCKET_OPEN
      ) {
        return;
      }
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.failActiveSocket(socket, owner, requestId);
        return;
      }
      this.awaitingPong = true;
      this.heartbeatTimeoutTimer = this.dependencies.scheduler.setTimeout(() => {
        this.heartbeatTimeoutTimer = null;
        this.failActiveSocket(socket, owner, requestId);
      }, REALTIME_TIMING.heartbeatTimeoutMs);
    }, REALTIME_TIMING.heartbeatIntervalMs);
  }

  private failActiveSocket(
    socket: RealtimeSocket,
    owner: RealtimeOwner,
    requestId: number,
  ): void {
    if (!this.isActiveSocket(socket, owner, requestId)) return;
    this.detachSocket(socket, true);
    this.isConnecting = false;
    this.stopHeartbeat();
    this.handleNetworkClose(owner);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.dependencies.scheduler.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer !== null) {
      this.dependencies.scheduler.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    this.awaitingPong = false;
  }

  private hardStop(owner: RealtimeOwner): void {
    this.hardStoppedOwner = copyOwner(owner);
    this.invalidateWork(true);
    this.currentOwner = copyOwner(owner);
    this.setStatus('disconnected');
  }

  private invalidateWork(resetAttempts: boolean): void {
    this.connectRequestId += 1;
    this.isConnecting = false;
    this.clearReconnectTimer();
    this.clearOpenTimeout();
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
    if (this.reconnectTimer !== null) {
      this.dependencies.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detachSocket(socket: RealtimeSocket, shouldClose: boolean): void {
    this.clearOpenTimeout(socket);
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
    };
    this.emitSnapshot();
  }

  private setStatus(status: RealtimeSnapshot['status']): void {
    if (this.snapshot.status === status) return;
    this.snapshot = { ...this.snapshot, status };
    this.emitSnapshot();
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
