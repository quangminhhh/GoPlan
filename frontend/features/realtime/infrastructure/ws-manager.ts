import axios from "axios";

import type { WsConnectionStatus, WsMessage } from "@/features/realtime/domain/types";
import {
  bffRefreshWsTicket,
  bffWsTicket,
} from "@/features/realtime/infrastructure/realtime-api";

const DEFAULT_WS_BASE_URL = "ws://localhost:8000";
const WS_SUBPROTOCOL = "goplan.realtime.v1";
const HEARTBEAT_INTERVAL_MS = 25_000;
// Generous on purpose: a momentarily busy backend (or a proxied hop) must not
// kill a healthy socket — every reconnect costs a one-time throttled ticket.
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 30_000;
const THROTTLE_FALLBACK_DELAY_MS = 30_000;
const MAX_THROTTLE_DELAY_MS = 300_000;
const SOFT_AUTH_ERROR_CODE = "refresh_auth_soft_failed";

type MessageListener = (data: WsMessage) => void;
type StatusListener = (status: WsConnectionStatus) => void;

function isLocalWebSocketHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

export function resolveWebSocketBaseUrl(
  rawUrl = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_BASE_URL,
  pageProtocol =
    typeof window === "undefined" ? undefined : window.location.protocol,
): string {
  const url = new URL(rawUrl);
  if (
    url.protocol === "ws:" &&
    !isLocalWebSocketHost(url.hostname) &&
    (pageProtocol === "https:" || process.env.NODE_ENV === "production")
  ) {
    url.protocol = "wss:";
  }
  return url.toString().replace(/\/$/, "");
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private status: WsConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectRequestId = 0;
  private isConnecting = false;

  /** Try one immediate ticket re-issue before falling back to backoff reconnect. */
  private reconnectBootstrapUsed = false;

  /** Prevents reconnect work during page unload/navigation. */
  private pageUnloading = false;

  private messageListeners = new Map<string, Set<MessageListener>>();
  private statusListeners = new Set<StatusListener>();

  private readonly onBeforeUnload = () => {
    this.pageUnloading = true;
    this.closeSocketForUnload();
  };

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onBeforeUnload);
    }
  }

  // -------- Public API --------

  connect(): void {
    if (this.isConnecting) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.clearReconnectTimer();
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const requestId = ++this.connectRequestId;
    this.isConnecting = true;
    void this.openSocket(requestId);
  }

  disconnect(): void {
    this.connectRequestId += 1;
    this.isConnecting = false;
    this.cancelReconnect();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    this.setStatus("disconnected");
  }

  /**
   * Send a JSON message to the server.
   * Returns true if the socket was OPEN and the message was queued by the
   * underlying WebSocket; false otherwise. Callers are expected to re-send
   * stateful messages (e.g. room subscriptions) on `onStatusChange("connected")`.
   */
  send(message: WsMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  on(type: string, callback: MessageListener): () => void {
    let listeners = this.messageListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.messageListeners.set(type, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.messageListeners.delete(type);
      }
    };
  }

  onStatusChange(callback: StatusListener): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  // -------- Auth Error Handling --------

  private handleAuthError(code: string): void {
    if (code === "token_expired") {
      this.handleExpiredTicket();
      return;
    }

    // "auth_failed" (revoked, invalid, etc.) — do not retry
    this.transitionToDisconnected();
  }

  private handleNetworkClose(): void {
    if (!this.reconnectBootstrapUsed) {
      this.reconnectBootstrapUsed = true;
      this.connect();
      return;
    }

    this.scheduleReconnect();
  }

  private async openSocket(requestId: number): Promise<void> {
    try {
      // The ticket endpoint goes through BFF, so it can reuse access-token forwarding
      // and refresh-cookie fallback without exposing bearer tokens in the WS URL.
      const { ticket } = await bffWsTicket();
      this.openSocketWithTicket(ticket, requestId);
    } catch (error) {
      if (!this.isCurrentConnectRequest(requestId) || this.pageUnloading) {
        this.isConnecting = false;
        return;
      }

      this.isConnecting = false;
      this.ws = null;

      if (this.isHardAuthFailure(error)) {
        this.transitionToDisconnected();
        return;
      }

      if (this.isThrottleError(error)) {
        this.scheduleThrottledReconnect(error);
        return;
      }

      this.scheduleReconnect();
    }
  }

  private openSocketWithTicket(ticket: string, requestId: number): void {
    if (!this.isCurrentConnectRequest(requestId) || this.pageUnloading) {
      this.isConnecting = false;
      return;
    }

    let socketAuthHandled = false;
    const ws = new WebSocket(`${resolveWebSocketBaseUrl()}/ws/realtime`, [
      WS_SUBPROTOCOL,
      ticket,
    ]);
    this.ws = ws;

    ws.onopen = () => {
      if (!this.isActiveSocket(ws, requestId)) {
        ws.close();
        return;
      }

      this.clearReconnectTimer();
      this.isConnecting = false;
      this.setStatus("connected");
      this.reconnectAttempt = 0;
      this.reconnectBootstrapUsed = false;
      this.startHeartbeat();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!this.isActiveSocket(ws, requestId)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string) as unknown;
      } catch {
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        return;
      }
      const data = parsed as WsMessage;

      if (data.type === "auth_error") {
        socketAuthHandled = true;
        this.releaseSocketReference(ws);
        this.stopHeartbeat();
        this.handleAuthError(data.code as string);
        return;
      }

      if (data.type === "pong") {
        this.clearHeartbeatTimeout();
        return;
      }

      this.emit(data.type, data);
    };

    ws.onclose = (event: CloseEvent) => {
      if (socketAuthHandled) return;
      if (!this.isActiveSocket(ws, requestId)) return;

      this.isConnecting = false;
      this.releaseSocketReference(ws);
      this.stopHeartbeat();

      if (this.pageUnloading) return;

      if (event.code === 4002) {
        this.handleExpiredTicket();
        return;
      }
      if (event.code === 4001) {
        this.handleAuthError("auth_failed");
        return;
      }

      this.handleNetworkClose();
    };

    ws.onerror = () => {
      // Errors always precede close events; actual handling happens in onclose
    };
  }

  private handleExpiredTicket(): void {
    const requestId = ++this.connectRequestId;
    this.isConnecting = true;
    this.setStatus("reconnecting");
    void this.openSocketWithRefreshedTicket(requestId);
  }

  private async openSocketWithRefreshedTicket(requestId: number): Promise<void> {
    try {
      const { ticket } = await bffRefreshWsTicket();
      this.openSocketWithTicket(ticket, requestId);
    } catch (error) {
      this.isConnecting = false;
      this.ws = null;

      if (this.isHardAuthFailure(error)) {
        this.transitionToDisconnected();
        return;
      }

      if (this.isThrottleError(error)) {
        this.scheduleThrottledReconnect(error);
        return;
      }

      this.scheduleReconnect();
    }
  }

  // -------- Reconnect --------

  /**
   * 429 on a ticket endpoint is not a network failure: retrying early can
   * never succeed and keeps the bucket full. Wait out Retry-After without
   * consuming reconnect attempts so a throttled client always recovers.
   */
  private scheduleThrottledReconnect(error: unknown): void {
    this.clearReconnectTimer();
    this.setStatus("reconnecting");

    const jitter = Math.random() * 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.throttleRetryDelayMs(error) + jitter);
  }

  private isThrottleError(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 429;
  }

  private throttleRetryDelayMs(error: unknown): number {
    if (!axios.isAxiosError(error)) return THROTTLE_FALLBACK_DELAY_MS;

    const rawHeader = (
      error.response?.headers as Record<string, unknown> | undefined
    )?.["retry-after"];
    const seconds = Number.parseInt(String(rawHeader), 10);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return THROTTLE_FALLBACK_DELAY_MS;
    }

    return Math.min(seconds * 1000, MAX_THROTTLE_DELAY_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.transitionToDisconnected();
      return;
    }

    this.clearReconnectTimer();
    this.setStatus("reconnecting");

    const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cancelReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.reconnectBootstrapUsed = false;
  }

  // -------- Heartbeat --------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        this.setHeartbeatTimeout();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private setHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
    this.heartbeatTimeoutTimer = setTimeout(() => {
      // No pong received — assume dead connection
      this.ws?.close();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  // -------- Internal --------

  private isCurrentConnectRequest(requestId: number): boolean {
    return requestId === this.connectRequestId;
  }

  private isActiveSocket(ws: WebSocket, requestId: number): boolean {
    return this.ws === ws && this.isCurrentConnectRequest(requestId);
  }

  private releaseSocketReference(ws: WebSocket): void {
    if (this.ws === ws) {
      this.ws = null;
    }
  }

  private closeSocketForUnload(): void {
    this.connectRequestId += 1;
    this.isConnecting = false;
    this.cancelReconnect();
    this.stopHeartbeat();

    if (!this.ws) return;

    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;

    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1000, "Page unloading");
    }

    this.ws = null;
  }

  private transitionToDisconnected(): void {
    this.cancelReconnect();
    this.isConnecting = false;
    this.setStatus("disconnected");
  }

  private isHardAuthFailure(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    if (status === 403) return true;
    if (status !== 401) return false;

    const code = this.extractErrorCode(error.response?.data);
    return code !== SOFT_AUTH_ERROR_CODE;
  }

  private extractErrorCode(data: unknown): string | null {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }

    const code = (data as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  private setStatus(newStatus: WsConnectionStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      listener(newStatus);
    }
  }

  private emit(type: string, data: WsMessage): void {
    const listeners = this.messageListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }
}

export const wsManager = new WebSocketManager();
