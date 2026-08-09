import type {
  AppStateObserver,
  AuthLifecycleSource,
  ConnectivitySnapshot,
  NetworkObserver,
  PublishedAuthLifecycleSnapshot,
  RealtimeAppState,
  RealtimeDisconnectReason,
  RealtimeEnvelope,
  RealtimeManager,
  RealtimeMessageListener,
  RealtimeOwner,
  RealtimeSnapshot,
  RealtimeSnapshotListener,
} from '../types';
import type { TicketApi } from '../infrastructure/ticket-api';
import type {
  RealtimeScheduler,
  RealtimeSocket,
  RealtimeSocketFactory,
} from '../infrastructure/WebSocketManager';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type TicketStep = () => Promise<string>;

export class FakeTicketApi implements TicketApi {
  issueCalls = 0;
  refreshCalls = 0;
  issueSteps: TicketStep[] = [];
  refreshSteps: TicketStep[] = [];
  defaultIssue: TicketStep = () => Promise.resolve(`ticket-${this.issueCalls}`);
  defaultRefresh: TicketStep = () => Promise.resolve(`refresh-${this.refreshCalls}`);

  issue(): Promise<string> {
    this.issueCalls += 1;
    return (this.issueSteps.shift() ?? this.defaultIssue)();
  }

  refresh(): Promise<string> {
    this.refreshCalls += 1;
    return (this.refreshSteps.shift() ?? this.defaultRefresh)();
  }
}

export class FakeSocket implements RealtimeSocket {
  private state = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];

  get readyState(): number {
    return this.state;
  }

  open(): void {
    this.state = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006): void {
    this.state = 3;
    this.onclose?.({ code });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.state = 3;
  }
}

export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  readonly calls: { url: string; protocols: string[] }[] = [];

  readonly create: RealtimeSocketFactory = (url, protocols) => {
    this.calls.push({ url, protocols: [...protocols] });
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  };
}

export const jestScheduler: RealtimeScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

export class FakeManager implements RealtimeManager {
  readonly connectCalls: RealtimeOwner[] = [];
  readonly restartCalls: RealtimeOwner[] = [];
  readonly disconnectCalls: RealtimeDisconnectReason[] = [];
  readonly events: string[] = [];
  private snapshot: RealtimeSnapshot = {
    status: 'disconnected',
    connectionEpoch: 0,
  };
  private readonly snapshotListeners = new Set<RealtimeSnapshotListener>();

  connect(owner: RealtimeOwner): void {
    this.connectCalls.push({ ...owner });
    this.events.push('connect');
  }

  restart(owner: RealtimeOwner): void {
    this.restartCalls.push({ ...owner });
    this.events.push('restart');
  }

  disconnect(reason: RealtimeDisconnectReason): void {
    this.disconnectCalls.push(reason);
    this.events.push(`disconnect:${reason}`);
  }

  send(_message: RealtimeEnvelope): boolean {
    return false;
  }

  subscribe(_type: string, _listener: RealtimeMessageListener): () => void {
    return () => undefined;
  }

  subscribeAll(_listener: RealtimeMessageListener): () => void {
    return () => undefined;
  }

  subscribeSnapshot(listener: RealtimeSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    this.events.push('subscribeSnapshot');
    return () => {
      this.snapshotListeners.delete(listener);
      this.events.push('unsubscribeSnapshot');
    };
  }

  getSnapshot(): RealtimeSnapshot {
    return this.snapshot;
  }

  emitSnapshot(snapshot: RealtimeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  destroy(): void {
    this.events.push('destroy');
    this.snapshotListeners.clear();
  }
}

export class FakeAuthSource implements AuthLifecycleSource {
  private readonly listeners = new Set<
    (snapshot: PublishedAuthLifecycleSnapshot) => void
  >();

  constructor(public snapshot: PublishedAuthLifecycleSnapshot) {}

  getSnapshot(): PublishedAuthLifecycleSnapshot {
    return this.snapshot;
  }

  subscribe(
    listener: (snapshot: PublishedAuthLifecycleSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: PublishedAuthLifecycleSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeAppStateObserver implements AppStateObserver {
  private readonly listeners = new Set<(state: RealtimeAppState) => void>();

  constructor(public state: RealtimeAppState) {}

  getCurrent(): RealtimeAppState {
    return this.state;
  }

  subscribe(listener: (state: RealtimeAppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: RealtimeAppState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeNetworkObserver implements NetworkObserver {
  private readonly listeners = new Set<(snapshot: ConnectivitySnapshot) => void>();
  currentResult: Promise<ConnectivitySnapshot>;

  constructor(snapshot: ConnectivitySnapshot) {
    this.currentResult = Promise.resolve(snapshot);
  }

  getCurrent(): Promise<ConnectivitySnapshot> {
    return this.currentResult;
  }

  subscribe(listener: (snapshot: ConnectivitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: ConnectivitySnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
