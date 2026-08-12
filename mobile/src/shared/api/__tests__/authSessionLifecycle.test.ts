jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// eslint-disable-next-line import/first
import * as SecureStore from 'expo-secure-store';
// eslint-disable-next-line import/first
import {
  __getClosingAuthPairForTests,
  __resetAuthSessionLifecycleForTests,
  activateAuthSession,
  beginAuthCredentialRotation,
  beginAuthSessionOpening,
  beginCredentialActivity,
  captureAuthTicket,
  getAuthSnapshot,
  isAuthTicketCurrent,
  publishAuthPair,
  requestAuthSessionClose,
  setAuthCloseEffects,
} from '../authSessionLifecycle';
// eslint-disable-next-line import/first
import { getAccessToken, getRefreshToken, setRefreshToken } from '../token-store';

const secureStore = (SecureStore as unknown as { __store: Map<string, string> }).__store;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (value) => resolvePromise(value),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

async function activate(pair = { access: 'access-a', refresh: 'refresh-a' }) {
  const ticket = await beginAuthSessionOpening();
  await setRefreshToken(pair.refresh);
  expect(publishAuthPair(ticket, pair)).toBe(true);
  expect(activateAuthSession(ticket)).toBe(true);
  return ticket;
}

beforeEach(async () => {
  __resetAuthSessionLifecycleForTests();
  secureStore.clear();
  jest.clearAllMocks();
});

describe('auth session lifecycle', () => {
  it('moves generation monotonically through restore, close, and session B', async () => {
    const openingA = await beginAuthSessionOpening();
    expect(openingA).toEqual({ sessionGeneration: 1, credentialRevision: 0 });
    await setRefreshToken('refresh-a');
    publishAuthPair(openingA, { access: 'access-a', refresh: 'refresh-a' });
    expect(getAuthSnapshot()).toMatchObject({
      access: 'access-a',
      publishedCredentialRevision: 0,
    });
    activateAuthSession(openingA);

    const closing = requestAuthSessionClose('user');
    expect(getAuthSnapshot()).toMatchObject({
      phase: 'closing',
      sessionGeneration: 2,
      publishedCredentialRevision: null,
    });
    await closing;
    expect(getAuthSnapshot()).toMatchObject({
      phase: 'signedOut',
      sessionGeneration: 2,
      publishedCredentialRevision: null,
    });

    const openingB = await beginAuthSessionOpening();
    expect(openingB).toEqual({ sessionGeneration: 3, credentialRevision: 0 });
  });

  it('closes the acquisition gate synchronously but waits raw credential activity', async () => {
    const ticket = await activate();
    const activity = beginCredentialActivity(ticket);
    expect(activity).not.toBeNull();

    let settled = false;
    const closing = requestAuthSessionClose('user').then(() => {
      settled = true;
    });

    expect(captureAuthTicket()).toBeNull();
    expect(beginCredentialActivity(ticket)).toBeNull();
    await Promise.resolve();
    expect(settled).toBe(false);

    activity?.finish();
    await closing;
    expect(settled).toBe(true);
  });

  it('moves a closing refresh response into handoff without publishing access', async () => {
    const ticket = await activate();
    const activity = beginCredentialActivity(ticket);
    const revoke = jest.fn(async () => undefined);
    setAuthCloseEffects({ revoke });

    const closing = requestAuthSessionClose('user');
    const rotated = { access: 'access-a2', refresh: 'refresh-a2' };
    expect(activity?.recordCandidate(rotated)).toBe(true);
    expect(__getClosingAuthPairForTests()).toEqual(rotated);
    expect(getAccessToken()).toBeNull();

    activity?.finish();
    await closing;
    expect(revoke).toHaveBeenCalledWith(rotated, expect.any(Object));
    expect(getAccessToken()).toBeNull();
  });

  it('joins concurrent close calls and runs side effects once', async () => {
    await activate();
    const revokeGate = deferred<void>();
    const onClosing = jest.fn();
    const revoke = jest.fn(() => revokeGate.promise);
    setAuthCloseEffects({ onClosing, revoke });

    const first = requestAuthSessionClose('user');
    const second = requestAuthSessionClose('refreshFailure');
    expect(first).toBe(second);
    expect(onClosing).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(revoke).toHaveBeenCalledTimes(1);
    revokeGate.resolve();
    await Promise.all([first, second]);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent closes joined while a failed durable deletion retries', async () => {
    jest.useFakeTimers();
    try {
      await activate();
      const onClosing = jest.fn();
      setAuthCloseEffects({ onClosing });
      (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(
        new Error('keychain unavailable'),
      );

      const first = requestAuthSessionClose('user');
      const second = requestAuthSessionClose('refreshFailure');
      await flushMicrotasks();
      const third = requestAuthSessionClose('credentialFailure');

      expect(first).toBe(second);
      expect(second).toBe(third);
      expect(onClosing).toHaveBeenCalledTimes(1);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
      expect(getAuthSnapshot().phase).toBe('closing');

      await jest.runOnlyPendingTimersAsync();
      await Promise.all([first, second, third]);

      expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
      expect(getAuthSnapshot().phase).toBe('signedOut');
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks session B and cold restore until durable deletion succeeds', async () => {
    jest.useFakeTimers();
    try {
      await activate();
      (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(
        new Error('keychain unavailable'),
      );

      const closing = requestAuthSessionClose('user');
      let closeSettled = false;
      void closing.then(() => {
        closeSettled = true;
      });
      const openingB = beginAuthSessionOpening();
      let openingBSettled = false;
      void openingB.then(() => {
        openingBSettled = true;
      });

      await flushMicrotasks();

      expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
      expect(closeSettled).toBe(false);
      expect(openingBSettled).toBe(false);
      expect(getAuthSnapshot()).toMatchObject({ phase: 'closing', access: null });
      expect(captureAuthTicket()).toBeNull();
      expect(
        publishAuthPair(
          { sessionGeneration: 3, credentialRevision: 0 },
          { access: 'access-b', refresh: 'refresh-b' },
        ),
      ).toBe(false);
      await expect(getRefreshToken()).resolves.toBe('refresh-a');

      await jest.runOnlyPendingTimersAsync();
      await closing;
      const ticketB = await openingB;

      expect(closeSettled).toBe(true);
      expect(ticketB).toEqual({ sessionGeneration: 3, credentialRevision: 0 });
      expect(getAuthSnapshot()).toMatchObject({ phase: 'opening', access: null });
      await expect(getRefreshToken()).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs the pre-revoke drain even when no credential pair exists', async () => {
    await beginAuthSessionOpening();
    const beforeRevoke = jest.fn(async () => undefined);
    const revoke = jest.fn(async () => undefined);
    setAuthCloseEffects({ beforeRevoke, revoke });

    await requestAuthSessionClose('restoreFailure');

    expect(beforeRevoke).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('drains protected work before revoking the closing pair', async () => {
    await activate();
    const calls: string[] = [];
    setAuthCloseEffects({
      beforeRevoke: async () => {
        calls.push('beforeRevoke');
      },
      revoke: async () => {
        calls.push('revoke');
      },
    });

    await requestAuthSessionClose('user');

    expect(calls).toEqual(['beforeRevoke', 'revoke']);
  });

  it('lets a newer credential revision beat an old refresh result', async () => {
    const ticket = await activate();
    const oldRefresh = beginCredentialActivity(ticket);
    const rotatedPair = { access: 'rotated-access', refresh: 'rotated-refresh' };
    const rotatedTicket = beginAuthCredentialRotation(ticket, rotatedPair);

    expect(rotatedTicket).toEqual({ sessionGeneration: 1, credentialRevision: 1 });
    expect(getAuthSnapshot()).toMatchObject({
      credentialRevision: 1,
      access: 'access-a',
      publishedCredentialRevision: 0,
    });
    expect(oldRefresh?.recordCandidate({ access: 'stale-access', refresh: 'stale-refresh' })).toBe(false);
    expect(rotatedTicket && publishAuthPair(rotatedTicket, rotatedPair)).toBe(true);
    expect(getAuthSnapshot()).toMatchObject({
      credentialRevision: 1,
      access: 'rotated-access',
      publishedCredentialRevision: 1,
    });
    oldRefresh?.finish();
  });

  it('waits an opening SecureStore write then queues deletion after it', async () => {
    const ticket = await beginAuthSessionOpening();
    const activity = beginCredentialActivity(ticket);
    const writeGate = deferred<void>();
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(
      (key: string, value: string) => writeGate.promise.then(() => {
        secureStore.set(key, value);
      }),
    );

    const write = setRefreshToken('late-refresh');
    let closeSettled = false;
    const closing = requestAuthSessionClose('user').then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    writeGate.resolve();
    await write;
    activity?.finish();
    await closing;
    expect(await getRefreshToken()).toBeNull();
    const setMock = SecureStore.setItemAsync as jest.Mock;
    const deleteMock = SecureStore.deleteItemAsync as jest.Mock;
    expect(setMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMock.mock.invocationCallOrder[0],
    );
  });

  it('clears active and handoff state after close', async () => {
    const ticket = await activate();
    expect(isAuthTicketCurrent(ticket)).toBe(true);
    await requestAuthSessionClose('user');

    expect(getAuthSnapshot()).toMatchObject({ phase: 'signedOut', access: null });
    expect(captureAuthTicket()).toBeNull();
    expect(__getClosingAuthPairForTests()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
  });
});
