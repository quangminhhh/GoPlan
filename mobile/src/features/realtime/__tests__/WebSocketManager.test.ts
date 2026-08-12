import type { RealtimeEnvelope, RealtimeOwner } from '../types';
import { TicketRequestError } from '../infrastructure/ticket-api';
import {
  REALTIME_TIMING,
  WebSocketManager,
  type WebSocketManagerDependencies,
} from '../infrastructure/WebSocketManager';
import {
  deferred,
  FakeSocketFactory,
  FakeTicketApi,
  flushPromises,
  jestScheduler,
} from '../testing/fakes';

const OWNER_A: RealtimeOwner = {
  sessionGeneration: 1,
  credentialRevision: 0,
};
const OWNER_B: RealtimeOwner = {
  sessionGeneration: 3,
  credentialRevision: 0,
};

interface Harness {
  manager: WebSocketManager;
  tickets: FakeTicketApi;
  sockets: FakeSocketFactory;
  owner: { current: RealtimeOwner | null };
  dependencies: WebSocketManagerDependencies;
}

function sameOwner(left: RealtimeOwner | null, right: RealtimeOwner): boolean {
  return (
    left?.sessionGeneration === right.sessionGeneration &&
    left.credentialRevision === right.credentialRevision
  );
}

function makeHarness(overrides: Partial<WebSocketManagerDependencies> = {}): Harness {
  const tickets = new FakeTicketApi();
  const sockets = new FakeSocketFactory();
  const owner = { current: OWNER_A as RealtimeOwner | null };
  const dependencies: WebSocketManagerDependencies = {
    ticketApi: tickets,
    socketFactory: sockets.create,
    resolveUrl: () => 'ws://localhost:8000/ws/realtime',
    isOwnerCurrent: (candidate) => sameOwner(owner.current, candidate),
    scheduler: jestScheduler,
    random: () => 0,
    ...overrides,
  };
  return {
    manager: new WebSocketManager(dependencies),
    tickets,
    sockets,
    owner,
    dependencies,
  };
}

describe('WebSocketManager', () => {
  const managers: WebSocketManager[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.destroy();
    jest.useRealTimers();
  });

  function harness(overrides: Partial<WebSocketManagerDependencies> = {}): Harness {
    const value = makeHarness(overrides);
    managers.push(value.manager);
    return value;
  }

  async function connectOpen(value: Harness) {
    value.manager.connect(OWNER_A);
    await flushPromises();
    const socket = value.sockets.sockets[0];
    expect(socket).toBeDefined();
    socket.open();
    return socket;
  }

  it('validates URL before consuming a ticket', async () => {
    const value = harness({
      resolveUrl: () => {
        throw new Error('invalid cleartext configuration');
      },
    });

    value.manager.connect(OWNER_A);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(0);
    expect(value.manager.getSnapshot().status).toBe('disconnected');
    expect(value.manager.getSnapshot().diagnostics).toMatchObject({
      phase: 'stopped',
      reason: 'invalid_configuration',
      category: 'configuration',
      terminal: true,
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(value.manager.retryConnection()).toBe(false);
    value.manager.connect(OWNER_A);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('connects single-flight with the required subprotocol and increments epoch only on open', async () => {
    const value = harness();
    const snapshots = jest.fn();
    value.manager.subscribeSnapshot(snapshots);

    value.manager.connect(OWNER_A);
    value.manager.connect(OWNER_A);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.sockets.calls).toEqual([
      {
        url: 'ws://localhost:8000/ws/realtime',
        protocols: ['goplan.realtime.v1', 'ticket-1'],
      },
    ]);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connecting',
      connectionEpoch: 0,
      diagnostics: {
        phase: 'opening_socket',
        ticketPhase: null,
      },
    });

    value.sockets.sockets[0].open();
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      connectionEpoch: 1,
      diagnostics: {
        phase: 'open',
        heartbeat: 'scheduled',
      },
    });
    expect(snapshots).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'connected',
      connectionEpoch: 1,
    }));
  });

  it('bounds a stuck opening socket and enters bootstrap then backoff recovery', async () => {
    const value = harness();

    value.manager.connect(OWNER_A);
    await flushPromises();
    const first = value.sockets.sockets[0];

    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.openTimeoutMs - 1);
    expect(first.closeCalls).toHaveLength(0);
    expect(value.tickets.issueCalls).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(first.closeCalls).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(2);
    expect(value.manager.getSnapshot().status).toBe('reconnecting');

    const bootstrap = value.sockets.sockets[1];
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.openTimeoutMs);
    await flushPromises();
    expect(bootstrap.closeCalls).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(value.tickets.issueCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(3);
  });

  it('does not let a cleared stale timeout kill a replacement or opened socket', async () => {
    const openTimeoutCallbacks: (() => void)[] = [];
    const value = harness({
      scheduler: {
        ...jestScheduler,
        setTimeout: (callback, delayMs) => {
          if (delayMs === REALTIME_TIMING.openTimeoutMs) {
            openTimeoutCallbacks.push(callback);
          }
          return jestScheduler.setTimeout(callback, delayMs);
        },
      },
    });

    value.manager.connect(OWNER_A);
    await flushPromises();
    const stale = value.sockets.sockets[0];
    expect(openTimeoutCallbacks).toHaveLength(1);

    value.manager.restart(OWNER_A);
    await flushPromises();
    const replacement = value.sockets.sockets[1];
    expect(openTimeoutCallbacks).toHaveLength(2);

    openTimeoutCallbacks[0]?.();
    expect(replacement.closeCalls).toHaveLength(0);
    expect(value.tickets.issueCalls).toBe(2);

    replacement.open();
    openTimeoutCallbacks[1]?.();
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      connectionEpoch: 1,
    });
    expect(replacement.closeCalls).toHaveLength(0);
    expect(value.tickets.issueCalls).toBe(2);
    expect(stale.closeCalls).toHaveLength(1);
  });

  it('does not let a cleared stale reconnect callback replace the active retry', async () => {
    const reconnectCallbacks: (() => void)[] = [];
    const value = harness({
      scheduler: {
        ...jestScheduler,
        setTimeout: (callback, delayMs) => {
          if (delayMs === 1_000) {
            reconnectCallbacks.push(callback);
          }
          return jestScheduler.setTimeout(callback, delayMs);
        },
      },
    });
    value.tickets.defaultIssue = () =>
      Promise.reject(new TicketRequestError('transient'));

    value.manager.connect(OWNER_A);
    await flushPromises();
    expect(reconnectCallbacks).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(1);

    value.manager.restart(OWNER_A);
    await flushPromises();
    expect(reconnectCallbacks).toHaveLength(2);
    expect(value.tickets.issueCalls).toBe(2);

    reconnectCallbacks[0]?.();
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(value.tickets.issueCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(3);
  });

  it.each(['disconnect', 'destroy'] as const)(
    'clears a pending open timeout on %s',
    async (action) => {
      const value = harness();
      value.manager.connect(OWNER_A);
      await flushPromises();
      const socket = value.sockets.sockets[0];
      expect(jest.getTimerCount()).toBe(1);

      if (action === 'disconnect') {
        value.manager.disconnect('background');
      } else {
        value.manager.destroy();
      }

      expect(socket.closeCalls).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(REALTIME_TIMING.openTimeoutMs);
      await flushPromises();
      expect(value.tickets.issueCalls).toBe(1);
      expect(value.manager.getSnapshot().status).toBe('disconnected');
    },
  );

  it.each(['auth message', 'close'] as const)(
    'clears a pending open timeout on a terminal pre-open %s',
    async (eventKind) => {
      const value = harness();
      value.manager.connect(OWNER_A);
      await flushPromises();
      const socket = value.sockets.sockets[0];
      expect(jest.getTimerCount()).toBe(1);

      if (eventKind === 'auth message') {
        socket.message(JSON.stringify({ type: 'auth_error', code: 'auth_failed' }));
      } else {
        socket.serverClose(4001);
      }
      await flushPromises();

      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(REALTIME_TIMING.openTimeoutMs);
      expect(value.tickets.issueCalls).toBe(1);
      expect(value.manager.getSnapshot().status).toBe('disconnected');
    },
  );

  it('fences a deferred ticket from an older auth generation', async () => {
    const value = harness();
    const ticketA = deferred<string>();
    const ticketB = deferred<string>();
    value.tickets.issueSteps.push(() => ticketA.promise, () => ticketB.promise);

    value.manager.connect(OWNER_A);
    value.owner.current = OWNER_B;
    value.manager.disconnect('auth');
    value.manager.connect(OWNER_B);

    ticketA.resolve('stale-a');
    await flushPromises();
    expect(value.sockets.sockets).toHaveLength(0);

    ticketB.resolve('current-b');
    await flushPromises();
    expect(value.sockets.calls[0]?.protocols).toEqual([
      'goplan.realtime.v1',
      'current-b',
    ]);
  });

  it('ignores callbacks from a socket invalidated by restart', async () => {
    const value = harness();
    value.manager.connect(OWNER_A);
    await flushPromises();
    const stale = value.sockets.sockets[0];

    value.manager.restart(OWNER_A);
    await flushPromises();
    const current = value.sockets.sockets[1];
    stale.open();
    stale.message(JSON.stringify({ type: 'notification', event: 'read_all' }));
    expect(value.manager.getSnapshot().connectionEpoch).toBe(0);

    current.open();
    expect(value.manager.getSnapshot().connectionEpoch).toBe(1);
    expect(stale.closeCalls).toHaveLength(1);
  });

  it('routes envelopes losslessly to multiple exact and wildcard listeners', async () => {
    const value = harness();
    const socket = await connectOpen(value);
    const first = jest.fn();
    const second = jest.fn();
    const all = jest.fn();
    const unsubscribeFirst = value.manager.subscribe('chat.ai_typing_started', first);
    value.manager.subscribe('chat.ai_typing_started', second);
    value.manager.subscribeAll(all);
    const message = {
      type: 'chat.ai_typing_started',
      trip_id: 'trip-1',
      interaction_id: 'interaction-1',
      requested_by_user_id: null,
      future_field: { untouched: true },
    };

    socket.message(JSON.stringify(message));
    expect(first).toHaveBeenCalledWith(message);
    expect(second).toHaveBeenCalledWith(message);
    expect(all).toHaveBeenCalledWith(message);

    unsubscribeFirst();
    socket.message(JSON.stringify(message));
    socket.message('{bad json');
    socket.message(JSON.stringify({ event: 'missing-type' }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('sends only on an open socket', async () => {
    const value = harness();
    expect(value.manager.send({ type: 'chat.subscribe', trip_id: 'trip-1' })).toBe(false);
    const socket = await connectOpen(value);

    expect(value.manager.send({ type: 'chat.subscribe', trip_id: 'trip-1' })).toBe(true);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'chat.subscribe', trip_id: 'trip-1' }),
    ]);
  });

  it('rejects an unserializable payload without recycling a healthy socket', async () => {
    const value = harness();
    const socket = await connectOpen(value);
    const cyclic: RealtimeEnvelope = { type: 'notification.read_all' };
    cyclic.self = cyclic;

    expect(value.manager.send(cyclic)).toBe(false);

    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(0);
    expect(value.tickets.issueCalls).toBe(1);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      connectionEpoch: 1,
      diagnostics: { phase: 'open' },
    });
  });

  it('recovers when an open socket throws while sending', async () => {
    const sockets = new FakeSocketFactory();
    const value = harness({
      socketFactory: (url, protocols) => {
        const socket = sockets.create(url, protocols);
        socket.send = () => {
          throw new Error('native send failure');
        };
        return socket;
      },
    });
    value.manager.connect(OWNER_A);
    await flushPromises();
    const socket = sockets.sockets[0];
    socket.open();

    expect(value.manager.send({ type: 'notification.read_all' })).toBe(false);
    await flushPromises();

    expect(socket.closeCalls).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(2);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        reason: 'send_failed',
        category: 'transport',
        terminal: false,
      },
    });
  });

  it('waits for pong without resetting the timeout on the next heartbeat tick', async () => {
    const value = harness();
    const socket = await connectOpen(value);

    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    expect(socket.sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(
      REALTIME_TIMING.heartbeatTimeoutMs - REALTIME_TIMING.heartbeatIntervalMs,
    );
    await flushPromises();

    expect(socket.closeCalls).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(2);
  });

  it('clears the heartbeat timeout on pong and sends the next heartbeat', async () => {
    const value = harness();
    const socket = await connectOpen(value);

    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    socket.message(JSON.stringify({ type: 'pong' }));
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);

    expect(socket.sent).toHaveLength(2);
  });

  it('does not let a cleared stale heartbeat timeout invalidate a new socket timeout', async () => {
    const timeoutCallbacks: (() => void)[] = [];
    const value = harness({
      scheduler: {
        ...jestScheduler,
        setTimeout: (callback, delayMs) => {
          if (delayMs === REALTIME_TIMING.heartbeatTimeoutMs) {
            timeoutCallbacks.push(callback);
          }
          return jestScheduler.setTimeout(callback, delayMs);
        },
      },
    });
    const first = await connectOpen(value);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    expect(timeoutCallbacks).toHaveLength(2);

    first.serverClose();
    await flushPromises();
    const replacement = value.sockets.sockets[1];
    replacement.open();
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    expect(timeoutCallbacks).toHaveLength(4);

    timeoutCallbacks[1]?.();
    replacement.message(JSON.stringify({ type: 'pong' }));
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatTimeoutMs);
    await flushPromises();

    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      connectionEpoch: 2,
    });
    expect(replacement.closeCalls).toHaveLength(0);
  });

  it('uses one immediate network-close bootstrap before exponential backoff', async () => {
    const value = harness();
    const first = await connectOpen(value);

    first.serverClose();
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(2);
    const bootstrapSocket = value.sockets.sockets[1];
    bootstrapSocket.serverClose();

    await jest.advanceTimersByTimeAsync(999);
    expect(value.tickets.issueCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(value.tickets.issueCalls).toBe(3);
  });

  it('keeps backoff state across sockets that open then close before a valid pong', async () => {
    const value = harness();
    const first = await connectOpen(value);

    first.serverClose();
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(2);

    let unstableSocket = value.sockets.sockets[1];
    for (
      let attemptIndex = 0;
      attemptIndex < REALTIME_TIMING.maxReconnectAttempts;
      attemptIndex += 1
    ) {
      unstableSocket.open();
      unstableSocket.serverClose();

      const delay = Math.min(
        1_000 * 2 ** attemptIndex,
        REALTIME_TIMING.maxBackoffMs,
      );
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(value.tickets.issueCalls).toBe(attemptIndex + 2);
      await jest.advanceTimersByTimeAsync(1);
      await flushPromises();
      expect(value.tickets.issueCalls).toBe(attemptIndex + 3);
      unstableSocket = value.sockets.sockets[attemptIndex + 2];
    }

    unstableSocket.open();
    unstableSocket.serverClose();

    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'disconnected',
      diagnostics: {
        phase: 'stopped',
        reason: 'retry_exhausted',
        category: 'retry',
        terminal: true,
        reconnectAttempt: REALTIME_TIMING.maxReconnectAttempts,
      },
    });
    expect(jest.getTimerCount()).toBe(0);

    const issueCallsBeforeManualRetry = value.tickets.issueCalls;
    value.manager.connect(OWNER_A);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(issueCallsBeforeManualRetry);
    expect(jest.getTimerCount()).toBe(0);

    value.tickets.defaultIssue = () => Promise.resolve('manual-retry-ticket');
    expect(value.manager.retryConnection()).toBe(true);
    expect(value.manager.retryConnection()).toBe(false);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(issueCallsBeforeManualRetry + 1);
    expect(value.sockets.calls.at(-1)?.protocols[1]).toBe(
      'manual-retry-ticket',
    );
    value.sockets.sockets.at(-1)?.open();
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      diagnostics: { terminal: false, phase: 'open' },
    });
  });

  it('restores a fresh immediate bootstrap only after the socket answers a heartbeat', async () => {
    const value = harness();
    const first = await connectOpen(value);

    first.serverClose();
    await flushPromises();
    const bootstrapSocket = value.sockets.sockets[1];
    bootstrapSocket.open();
    bootstrapSocket.serverClose();
    await jest.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    const recoveredSocket = value.sockets.sockets[2];
    recoveredSocket.open();
    recoveredSocket.message(JSON.stringify({ type: 'pong' }));
    expect(value.manager.getSnapshot().diagnostics?.reconnectAttempt).toBe(1);

    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);
    expect(recoveredSocket.sent).toContain(JSON.stringify({ type: 'ping' }));
    recoveredSocket.message(JSON.stringify({ type: 'pong' }));
    expect(value.manager.getSnapshot().diagnostics?.reconnectAttempt).toBe(0);

    recoveredSocket.serverClose();
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(4);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        phase: 'opening_socket',
        reconnectAttempt: 0,
        retryDelayMs: null,
      },
    });
  });

  it('leaves connected immediately on socket error and recovers if native close never arrives', async () => {
    const value = harness();
    const socket = await connectOpen(value);

    socket.error();

    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        phase: 'awaiting_close',
        reason: 'socket_error',
        category: 'transport',
        terminal: false,
      },
    });
    expect(value.manager.send({ type: 'notification.read_all' })).toBe(false);
    expect(value.tickets.issueCalls).toBe(1);

    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.errorCloseGraceMs - 1);
    expect(value.tickets.issueCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(socket.closeCalls).toHaveLength(1);
    expect(value.tickets.issueCalls).toBe(2);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        reason: 'socket_error_without_close',
        category: 'transport',
      },
    });
  });

  it('ignores a late pong after socket error without corrupting diagnostics', async () => {
    const value = harness();
    const socket = await connectOpen(value);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);

    socket.error();
    socket.message(JSON.stringify({ type: 'pong' }));

    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        phase: 'awaiting_close',
        reason: 'socket_error',
        category: 'transport',
        heartbeat: 'inactive',
      },
    });
  });

  it('does not let a cleared stale heartbeat interval steal an authoritative close', async () => {
    const intervalCallbacks: (() => void)[] = [];
    const value = harness({
      scheduler: {
        ...jestScheduler,
        setInterval: (callback, delayMs) => {
          if (delayMs === REALTIME_TIMING.heartbeatIntervalMs) {
            intervalCallbacks.push(callback);
          }
          return jestScheduler.setInterval(callback, delayMs);
        },
      },
    });
    const socket = await connectOpen(value);
    expect(intervalCallbacks).toHaveLength(1);

    socket.error();
    const sendAfterError = jest.fn(() => {
      throw new Error('socket is already failing');
    });
    socket.send = sendAfterError;
    intervalCallbacks[0]?.();

    expect(sendAfterError).not.toHaveBeenCalled();
    expect(value.tickets.issueCalls).toBe(1);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      diagnostics: {
        phase: 'awaiting_close',
        reason: 'socket_error',
        heartbeat: 'inactive',
      },
    });

    socket.serverClose(4001);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.errorCloseGraceMs);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'disconnected',
      diagnostics: {
        phase: 'stopped',
        reason: 'authentication_failed',
        category: 'authentication',
        terminal: true,
        closeCode: 4001,
      },
    });
  });

  it('cancels the socket-error fallback if the same opening socket succeeds', async () => {
    const value = harness();
    value.manager.connect(OWNER_A);
    await flushPromises();
    const socket = value.sockets.sockets[0];

    socket.error();
    socket.open();
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.errorCloseGraceMs);
    await flushPromises();

    expect(socket.closeCalls).toHaveLength(0);
    expect(value.tickets.issueCalls).toBe(1);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'connected',
      connectionEpoch: 1,
      diagnostics: {
        phase: 'open',
        reason: null,
        heartbeat: 'scheduled',
      },
    });
  });

  it('lets a close code win over the socket-error fallback and cancels its timer', async () => {
    const value = harness();
    const socket = await connectOpen(value);

    socket.error();
    socket.serverClose(4001);
    value.manager.connect(OWNER_A);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.errorCloseGraceMs);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.manager.getSnapshot()).toMatchObject({
      status: 'disconnected',
      diagnostics: {
        phase: 'stopped',
        reason: 'authentication_failed',
        category: 'authentication',
        terminal: true,
        closeCode: 4001,
      },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['disconnect', 'restart', 'destroy'] as const)(
    'cancels a socket-error fallback on %s',
    async (action) => {
      const value = harness();
      const socket = await connectOpen(value);
      socket.error();
      expect(jest.getTimerCount()).toBe(1);

      if (action === 'disconnect') {
        value.manager.disconnect('background');
      } else if (action === 'restart') {
        value.manager.restart(OWNER_A);
      } else {
        value.manager.destroy();
      }
      await flushPromises();

      const expectedTicketCalls = action === 'restart' ? 2 : 1;
      expect(value.tickets.issueCalls).toBe(expectedTicketCalls);
      await jest.advanceTimersByTimeAsync(REALTIME_TIMING.errorCloseGraceMs);
      await flushPromises();
      expect(value.tickets.issueCalls).toBe(expectedTicketCalls);
    },
  );

  it('caps exponential backoff and stops after ten attempts', async () => {
    const value = harness();
    value.tickets.defaultIssue = () =>
      Promise.reject(new TicketRequestError('transient'));
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000];

    value.manager.connect(OWNER_A);
    await flushPromises();
    for (const [index, delay] of delays.entries()) {
      await jest.advanceTimersByTimeAsync(delay);
      await flushPromises();
      expect(value.tickets.issueCalls).toBe(index + 2);
    }

    expect(value.manager.getSnapshot().status).toBe('disconnected');
    expect(value.manager.getSnapshot().diagnostics).toMatchObject({
      phase: 'stopped',
      reason: 'retry_exhausted',
      category: 'retry',
      terminal: true,
      reconnectAttempt: REALTIME_TIMING.maxReconnectAttempts,
      retryDelayMs: null,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('honours throttling without burning a reconnect attempt', async () => {
    const value = harness();
    value.tickets.issueSteps.push(
      () => Promise.reject(new TicketRequestError('throttled', 42_000)),
      () => Promise.reject(new TicketRequestError('transient')),
      () => Promise.resolve('after-backoff'),
    );

    value.manager.connect(OWNER_A);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(41_999);
    expect(value.tickets.issueCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(value.tickets.issueCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(value.tickets.issueCalls).toBe(3);
  });

  it('caps the final throttled delay including jitter at 300 seconds', async () => {
    const value = harness({ random: () => 1 });
    value.tickets.issueSteps.push(
      () => Promise.reject(new TicketRequestError('throttled', 300_000)),
      () => Promise.resolve('capped'),
    );

    value.manager.connect(OWNER_A);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(299_999);
    expect(value.tickets.issueCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(value.tickets.issueCalls).toBe(2);
  });

  it.each([
    ['envelope', (socket: { message(data: unknown): void }) => socket.message(JSON.stringify({ type: 'auth_error', code: 'token_expired' }))],
    ['close code', (socket: { serverClose(code: number): void }) => socket.serverClose(4002)],
  ])('uses refreshed-ticket recovery for token expiry via %s', async (_label, expire) => {
    const value = harness();
    const socket = await connectOpen(value);

    expire(socket);
    await flushPromises();

    expect(value.tickets.refreshCalls).toBe(1);
    expect(value.sockets.calls[1]?.protocols[1]).toBe('refresh-1');
  });

  it.each([
    ['envelope', (socket: { message(data: unknown): void }) => socket.message(JSON.stringify({ type: 'auth_error', code: 'token_expired' })), null],
    ['close code', (socket: { serverClose(code: number): void }) => socket.serverClose(4002), 4002],
  ])(
    'backs off and stops repeated pre-pong token expiry via %s',
    async (_label, expire, expectedCloseCode) => {
      const value = harness();
      const first = await connectOpen(value);

      expire(first);
      await flushPromises();
      expect(value.tickets.issueCalls).toBe(1);
      expect(value.tickets.refreshCalls).toBe(1);

      let unstableSocket = value.sockets.sockets[1];
      for (
        let attemptIndex = 0;
        attemptIndex < REALTIME_TIMING.maxReconnectAttempts;
        attemptIndex += 1
      ) {
        unstableSocket.open();
        expire(unstableSocket);

        const delay = Math.min(
          1_000 * 2 ** attemptIndex,
          REALTIME_TIMING.maxBackoffMs,
        );
        await jest.advanceTimersByTimeAsync(delay - 1);
        expect(value.tickets.refreshCalls).toBe(attemptIndex + 1);
        await jest.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(value.tickets.refreshCalls).toBe(attemptIndex + 2);
        unstableSocket = value.sockets.sockets[attemptIndex + 2];
      }

      unstableSocket.open();
      expire(unstableSocket);

      expect(value.tickets.issueCalls).toBe(1);
      expect(value.tickets.refreshCalls).toBe(
        REALTIME_TIMING.maxReconnectAttempts + 1,
      );
      expect(value.manager.getSnapshot()).toMatchObject({
        status: 'disconnected',
        diagnostics: {
          phase: 'stopped',
          reason: 'retry_exhausted',
          category: 'retry',
          terminal: true,
          closeCode: expectedCloseCode,
          reconnectAttempt: REALTIME_TIMING.maxReconnectAttempts,
        },
      });
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('retries a throttled refreshed-ticket request through the refresh endpoint', async () => {
    const value = harness();
    value.tickets.refreshSteps.push(
      () => Promise.reject(new TicketRequestError('throttled', 42_000)),
      () => Promise.resolve('refreshed-after-throttle'),
    );
    const socket = await connectOpen(value);

    socket.message(JSON.stringify({ type: 'auth_error', code: 'token_expired' }));
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.tickets.refreshCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(41_999);
    expect(value.tickets.refreshCalls).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.tickets.refreshCalls).toBe(2);
    expect(value.sockets.calls[1]?.protocols[1]).toBe('refreshed-after-throttle');
  });

  it('retries a transient refreshed-ticket failure through the refresh endpoint', async () => {
    const value = harness();
    value.tickets.refreshSteps.push(
      () => Promise.reject(new TicketRequestError('transient')),
      () => Promise.resolve('refreshed-after-backoff'),
    );
    const socket = await connectOpen(value);

    socket.serverClose(4002);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.tickets.refreshCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(value.tickets.refreshCalls).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.tickets.refreshCalls).toBe(2);
    expect(value.sockets.calls[1]?.protocols[1]).toBe('refreshed-after-backoff');
  });

  it('hard-stops when refreshed-ticket recovery receives a hard auth failure', async () => {
    const value = harness();
    value.tickets.refreshSteps.push(
      () => Promise.reject(new TicketRequestError('hardAuth')),
    );
    const socket = await connectOpen(value);

    socket.serverClose(4002);
    await flushPromises();
    value.manager.connect(OWNER_A);

    expect(value.tickets.issueCalls).toBe(1);
    expect(value.tickets.refreshCalls).toBe(1);
    expect(value.manager.getSnapshot().status).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['envelope', (socket: { message(data: unknown): void }) => socket.message(JSON.stringify({ type: 'auth_error', code: 'auth_failed' }))],
    ['close code', (socket: { serverClose(code: number): void }) => socket.serverClose(4001)],
  ])('hard-stops auth failure via %s', async (_label, fail) => {
    const value = harness();
    const socket = await connectOpen(value);

    fail(socket);
    value.manager.connect(OWNER_A);
    await flushPromises();

    expect(value.manager.getSnapshot().status).toBe('disconnected');
    expect(value.manager.getSnapshot().diagnostics).toMatchObject({
      reason: 'authentication_failed',
      category: 'authentication',
      terminal: true,
    });
    expect(value.tickets.issueCalls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(value.manager.retryConnection()).toBe(false);
  });

  it.each(['background', 'offline'] as const)(
    'preserves authentication hard-stop diagnostics across %s lifecycle transitions',
    async (reason) => {
      const value = harness();
      const socket = await connectOpen(value);

      socket.serverClose(4001);
      value.manager.disconnect(reason);
      value.manager.connect(OWNER_A);
      await flushPromises();

      expect(value.tickets.issueCalls).toBe(1);
      expect(value.manager.getSnapshot()).toMatchObject({
        status: 'disconnected',
        diagnostics: {
          phase: 'stopped',
          reason: 'authentication_failed',
          category: 'authentication',
          terminal: true,
          closeCode: 4001,
          heartbeat: 'inactive',
        },
      });
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('disconnect cancels timers and destroy clears listeners', async () => {
    const value = harness();
    const listener = jest.fn();
    value.manager.subscribe('notification', listener);
    const socket = await connectOpen(value);
    await jest.advanceTimersByTimeAsync(REALTIME_TIMING.heartbeatIntervalMs);

    value.manager.disconnect('background');
    socket.message(JSON.stringify({ type: 'notification', event: 'created' }));
    expect(jest.getTimerCount()).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    value.manager.destroy();
    value.manager.connect(OWNER_A);
    await flushPromises();
    expect(value.tickets.issueCalls).toBe(1);
  });
});
