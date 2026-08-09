import {
  captureNotificationRealtimeVersion,
  createNotificationRealtimeState,
  notificationRealtimeReducer,
  type NotificationRealtimeState,
} from '../application/realtimeReducer';
import type { NotificationRealtimeEvent } from '../realtimeEvents';
import type { NotificationItem } from '../types';

function makeNotification(id: string, isRead = false): NotificationItem {
  return {
    id,
    notification_type: 'FRIEND_REQUEST',
    actor: { id: 'user-2', display_name: 'Bob', identify_tag: 'bob#ABC123' },
    payload: {},
    is_read: isRead,
    read_at: isRead ? '2026-08-09T02:00:00Z' : null,
    created_at: `2026-08-09T01:00:0${id.length}Z`,
  };
}

function created(notification: NotificationItem): NotificationRealtimeEvent {
  return { type: 'notification', event: 'created', notification };
}

function read(...notificationIds: string[]): NotificationRealtimeEvent {
  return { type: 'notification', event: 'read', notification_ids: notificationIds };
}

const readAll: NotificationRealtimeEvent = { type: 'notification', event: 'read_all' };

function receive(
  state: NotificationRealtimeState,
  event: NotificationRealtimeEvent,
): NotificationRealtimeState {
  return notificationRealtimeReducer(state, { type: 'REALTIME_EVENT_RECEIVED', event });
}

describe('notificationRealtimeReducer', () => {
  it('prepends a created notification, increments a hydrated badge once, and records its version', () => {
    const existing = makeNotification('existing');
    const incoming = makeNotification('incoming');
    const initial = createNotificationRealtimeState({ items: [existing], unreadCount: 2 });

    const next = receive(initial, created(incoming));

    expect(next.items).toEqual([incoming, existing]);
    expect(next.unreadCount).toBe(3);
    expect(next.version).toBe(1);
    expect(next.overlays.createdById.get(incoming.id)).toEqual({
      version: 1,
      notification: incoming,
      countDelta: 1,
    });
    const duplicate = receive(next, created({ ...incoming, payload: { duplicate: true } }));
    expect(duplicate.items[0]?.payload).toEqual({ duplicate: true });
    expect(duplicate.unreadCount).toBe(3);
    expect(duplicate.version).toBe(1);
  });

  it('upserts a created event over a REST row, preserves read state, and does not increment the badge', () => {
    const existing = makeNotification('existing', true);
    const initial = createNotificationRealtimeState({ items: [existing], unreadCount: 1 });
    const incoming = {
      ...makeNotification('existing'),
      actor: { id: 'user-3', display_name: 'Updated actor', identify_tag: null },
      payload: { websocket: true },
    };

    const next = receive(initial, created(incoming));

    expect(next.items).toEqual([
      {
        ...incoming,
        is_read: true,
        read_at: existing.read_at,
      },
    ]);
    expect(next.unreadCount).toBe(1);
    expect(next.overlays.createdById.get(existing.id)?.countDelta).toBe(0);
  });

  it('applies each loaded read id once and invalidates the badge for an unloaded id', () => {
    const unread = makeNotification('unread');
    const alreadyRead = makeNotification('already-read', true);
    const initial = createNotificationRealtimeState({
      items: [unread, alreadyRead],
      unreadCount: 3,
    });

    const next = receive(initial, read(unread.id, unread.id, alreadyRead.id, 'not-loaded'));

    expect(next.items.every((item) => item.is_read)).toBe(true);
    expect(next.unreadCount).toBeNull();
    expect(next.overlays.readById.get(unread.id)?.countDelta).toBe(-1);
    expect(next.overlays.readById.get(alreadyRead.id)?.countDelta).toBe(0);
    expect(next.overlays.readById.get('not-loaded')?.countDelta).toBeNull();
    expect(receive(next, read(unread.id, alreadyRead.id, 'not-loaded'))).toBe(next);

    const zero = createNotificationRealtimeState({ unreadCount: 0 });
    expect(receive(zero, read('another-unloaded')).unreadCount).toBeNull();
  });

  it('restores an invalidated badge only from a count request started after the unknown-id read', () => {
    let state = createNotificationRealtimeState({ unreadCount: 4 });
    const staleRequestVersion = captureNotificationRealtimeVersion(state);
    state = receive(state, read('not-loaded'));

    state = notificationRealtimeReducer(state, {
      type: 'UNREAD_COUNT_RESOLVED',
      unreadCount: 3,
      requestVersion: staleRequestVersion,
    });
    expect(state.unreadCount).toBeNull();

    const reconcileRequestVersion = captureNotificationRealtimeVersion(state);
    state = notificationRealtimeReducer(state, {
      type: 'UNREAD_COUNT_RESOLVED',
      unreadCount: 3,
      requestVersion: reconcileRequestVersion,
    });
    expect(state.unreadCount).toBe(3);
  });

  it('keeps an unknown badge unknown until read_all establishes zero', () => {
    const initial = createNotificationRealtimeState();
    const afterCreated = receive(initial, created(makeNotification('first')));
    const afterRead = receive(afterCreated, read('first'));

    expect(afterCreated.unreadCount).toBeNull();
    expect(afterRead.unreadCount).toBeNull();

    const afterReadAll = receive(afterRead, readAll);
    const futureCreated = receive(afterReadAll, created(makeNotification('future')));

    expect(afterReadAll.unreadCount).toBe(0);
    expect(afterReadAll.items.every((item) => item.is_read)).toBe(true);
    expect(futureCreated.unreadCount).toBe(1);
    expect(futureCreated.items.find((item) => item.id === 'future')?.is_read).toBe(false);
  });

  it('does not resurrect a known item when read_all happens during an in-flight request', () => {
    const item = makeNotification('item');
    let state = createNotificationRealtimeState({ items: [item], unreadCount: 1 });
    state = receive(state, read(item.id));
    const requestVersion = captureNotificationRealtimeVersion(state);
    state = receive(state, readAll);
    expect(state.overlays.readById.get(item.id)?.version).toBe(2);
    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [],
      requestVersion,
    });

    state = receive(state, created({ ...item, payload: { duplicate: true } }));

    expect(state.items).toEqual([
      { ...item, payload: { duplicate: true }, is_read: true },
    ]);
    expect(state.unreadCount).toBe(0);
  });

  it('only applies read_all to ids known when the event arrived', () => {
    const known = makeNotification('known');
    const unknown = makeNotification('unknown');
    let state = createNotificationRealtimeState({ items: [known], unreadCount: 2 });
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = receive(state, readAll);
    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [unknown, known],
      requestVersion,
    });

    expect(state.items.find((item) => item.id === known.id)?.is_read).toBe(true);
    expect(state.items.find((item) => item.id === unknown.id)?.is_read).toBe(false);

    state = receive(
      state,
      created({ ...unknown, payload: { source: 'delayed-created' } }),
    );

    expect(state.items.find((item) => item.id === known.id)?.is_read).toBe(true);
    expect(state.items.find((item) => item.id === unknown.id)?.is_read).toBe(false);
  });

  it('merges created, read, and read_all overlays over a stale first page', () => {
    const first = makeNotification('first');
    const second = makeNotification('second');
    let state = createNotificationRealtimeState({ items: [first, second], unreadCount: 2 });
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = receive(state, read(first.id));
    state = receive(state, created(makeNotification('before-read-all')));
    state = receive(state, readAll);
    state = receive(state, created(makeNotification('after-read-all')));

    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      requestVersion,
      items: [
        makeNotification('after-read-all'),
        makeNotification('before-read-all'),
        second,
        first,
        first,
      ],
    });

    expect(state.items.map((item) => item.id)).toEqual([
      'after-read-all',
      'before-read-all',
      'second',
      'first',
    ]);
    expect(state.items.find((item) => item.id === 'after-read-all')?.is_read).toBe(false);
    expect(
      state.items
        .filter((item) => item.id !== 'after-read-all')
        .every((item) => item.is_read),
    ).toBe(true);
  });

  it('does not let a stale first page drop a created push that arrived in flight', () => {
    const existing = makeNotification('existing');
    const pushed = { ...makeNotification('pushed'), payload: { source: 'websocket' } };
    let state = createNotificationRealtimeState({ items: [existing], unreadCount: 1 });
    const requestVersion = captureNotificationRealtimeVersion(state);
    state = receive(state, created(pushed));

    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [{ ...pushed, payload: { source: 'stale-rest' } }, existing],
      requestVersion,
    });

    expect(state.items).toEqual([pushed, existing]);
  });

  it('discards a stale count instead of double-applying realtime badge changes', () => {
    let state = createNotificationRealtimeState({ unreadCount: 2 });
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = receive(state, created(makeNotification('created')));
    expect(state.unreadCount).toBe(3);

    state = notificationRealtimeReducer(state, {
      type: 'UNREAD_COUNT_RESOLVED',
      unreadCount: 3,
      requestVersion,
    });

    expect(state.unreadCount).toBe(3);
  });

  it('uses the same version clock for local overrides and async response guards', () => {
    let state = createNotificationRealtimeState({ unreadCount: 2 });
    const staleRequestVersion = captureNotificationRealtimeVersion(state);

    state = notificationRealtimeReducer(state, { type: 'LOCAL_MUTATION_RECORDED' });
    expect(state.version).toBe(1);
    state = notificationRealtimeReducer(state, {
      type: 'UNREAD_COUNT_RESOLVED',
      unreadCount: 1,
      requestVersion: staleRequestVersion,
    });

    expect(state.unreadCount).toBe(2);
  });

  it('accepts a response started after earlier overlays as authoritative and normalizes counts', () => {
    let state = createNotificationRealtimeState({ unreadCount: -4 });
    expect(state.unreadCount).toBe(0);
    state = receive(state, created(makeNotification('created')));
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = notificationRealtimeReducer(state, {
      type: 'UNREAD_COUNT_RESOLVED',
      unreadCount: 7.9,
      requestVersion,
    });

    expect(state.unreadCount).toBe(7);
  });

  it('preserves a known per-id read across later list merges', () => {
    const item = makeNotification('item');
    let state = createNotificationRealtimeState({ items: [item], unreadCount: 1 });
    state = receive(state, read(item.id));
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [item],
      requestVersion,
    });

    expect(state.items[0]?.is_read).toBe(true);
    expect(state.overlays.readById.size).toBe(0);
  });

  it('compacts all overlays covered by a current first-page request', () => {
    const item = makeNotification('item');
    let state = createNotificationRealtimeState({ unreadCount: 1 });
    state = receive(state, created(item));
    state = receive(state, read(item.id));
    state = receive(state, readAll);
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [makeNotification(item.id, true)],
      requestVersion,
    });

    expect(state.overlays.createdById.size).toBe(0);
    expect(state.overlays.readById.size).toBe(0);
    expect(state.overlays.readAll).toBeNull();
  });

  it('compacts covered overlays but retains mutations newer than the request', () => {
    const covered = makeNotification('covered');
    const inFlight = makeNotification('in-flight');
    const afterReadAll = makeNotification('after-read-all');
    let state = createNotificationRealtimeState({ unreadCount: 0 });
    state = receive(state, created(covered));
    state = receive(state, read(covered.id));
    const requestVersion = captureNotificationRealtimeVersion(state);

    state = receive(state, created(inFlight));
    state = receive(state, read(inFlight.id));
    state = receive(state, readAll);
    state = receive(state, created(afterReadAll));
    state = notificationRealtimeReducer(state, {
      type: 'FIRST_PAGE_RESOLVED',
      items: [covered],
      requestVersion,
    });

    expect([...state.overlays.createdById.keys()]).toEqual([
      inFlight.id,
      afterReadAll.id,
    ]);
    expect([...state.overlays.readById.keys()]).toEqual([
      covered.id,
      inFlight.id,
    ]);
    expect(
      [...state.overlays.readById.values()].every((overlay) => overlay.version === 5),
    ).toBe(true);
    expect(state.overlays.readAll?.version).toBe(5);
  });
});
