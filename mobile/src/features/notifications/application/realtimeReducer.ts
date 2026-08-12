import type { NotificationItem } from '../types';
import type { NotificationRealtimeEvent } from '../realtimeEvents';

type CreatedCountDelta = 0 | 1;
type ReadCountDelta = -1 | 0 | null;

export interface NotificationCreatedOverlay {
  version: number;
  notification: NotificationItem;
  countDelta: CreatedCountDelta;
}

export interface NotificationReadOverlay {
  version: number;
  countDelta: ReadCountDelta;
}

export interface NotificationReadAllOverlay {
  version: number;
}

export interface NotificationRealtimeOverlays {
  createdById: ReadonlyMap<string, NotificationCreatedOverlay>;
  readById: ReadonlyMap<string, NotificationReadOverlay>;
  readAll: NotificationReadAllOverlay | null;
}

export interface NotificationRealtimeState {
  items: NotificationItem[];
  unreadCount: number | null;
  /** The single mutation clock shared by realtime events and local overrides. */
  version: number;
  overlays: NotificationRealtimeOverlays;
}

export type NotificationRealtimeReducerAction =
  | { type: 'REALTIME_EVENT_RECEIVED'; event: NotificationRealtimeEvent }
  /** Advance before stamping a non-realtime local override with the returned version. */
  | { type: 'LOCAL_MUTATION_RECORDED' }
  | {
      type: 'FIRST_PAGE_RESOLVED';
      items: NotificationItem[];
      requestVersion: number;
    }
  | {
      type: 'LOCAL_READ_ALL_CONFIRMED';
      notificationIds: string[];
      updatedCount: number;
      countIsAmbiguous: boolean;
    }
  | {
      type: 'UNREAD_COUNT_RESOLVED';
      unreadCount: number | null;
      requestVersion: number;
      knownItemIdsAtStart: string[];
    };

interface InitialNotificationRealtimeState {
  items?: NotificationItem[];
  unreadCount?: number | null;
}

function normalizeUnreadCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeRequestVersion(state: NotificationRealtimeState, value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(state.version, Math.max(0, Math.floor(value)));
}

function dedupeItems(items: NotificationItem[]): NotificationItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function compactOverlayMap<T extends { version: number }>(
  overlays: ReadonlyMap<string, T>,
  requestVersion: number,
): ReadonlyMap<string, T> {
  return new Map(
    [...overlays].filter(([, overlay]) => overlay.version > requestVersion),
  );
}

function adjustUnreadCount(current: number | null, delta: number): number | null {
  return current === null ? null : Math.max(0, current + delta);
}

function markItemRead(item: NotificationItem): NotificationItem {
  return item.is_read ? item : { ...item, is_read: true };
}

function preserveReadState(
  incoming: NotificationItem,
  existing: NotificationItem | undefined,
  hasReadOverride: boolean,
): NotificationItem {
  if (incoming.is_read || (!existing?.is_read && !hasReadOverride)) {
    return incoming;
  }
  return {
    ...incoming,
    is_read: true,
    read_at: existing?.read_at ?? incoming.read_at,
  };
}

function applyCreatedEvent(
  state: NotificationRealtimeState,
  notification: NotificationItem,
): NotificationRealtimeState {
  const existingOverlay = state.overlays.createdById.get(notification.id);
  if (existingOverlay) {
    const existingItem = state.items.find((item) => item.id === notification.id);
    const effectiveNotification = preserveReadState(
      notification,
      existingItem,
      state.overlays.readById.has(notification.id),
    );
    const createdById = new Map(state.overlays.createdById);
    createdById.set(notification.id, {
      ...existingOverlay,
      notification: effectiveNotification,
    });
    return {
      ...state,
      items: existingItem
        ? state.items.map((item) =>
            item.id === notification.id ? effectiveNotification : item,
          )
        : [effectiveNotification, ...state.items],
      overlays: { ...state.overlays, createdById },
    };
  }

  const version = state.version + 1;
  const existingIndex = state.items.findIndex((item) => item.id === notification.id);
  const existingItem = existingIndex >= 0 ? state.items[existingIndex] : undefined;
  const effectiveNotification = preserveReadState(
    notification,
    existingItem,
    state.overlays.readById.has(notification.id),
  );
  const countDelta: CreatedCountDelta = existingItem !== undefined || effectiveNotification.is_read ? 0 : 1;
  let items = state.items;

  if (!existingItem) {
    items = [effectiveNotification, ...state.items];
  } else {
    items = [...state.items];
    items[existingIndex] = effectiveNotification;
  }

  const createdById = new Map(state.overlays.createdById);
  createdById.set(notification.id, { version, notification: effectiveNotification, countDelta });

  return {
    ...state,
    items,
    unreadCount: adjustUnreadCount(state.unreadCount, countDelta),
    version,
    overlays: { ...state.overlays, createdById },
  };
}

function applyReadEvent(
  state: NotificationRealtimeState,
  notificationIds: string[],
): NotificationRealtimeState {
  const uniqueIds = [...new Set(notificationIds.filter((id) => id.length > 0))];
  const newIds = uniqueIds.filter((id) => !state.overlays.readById.has(id));

  if (newIds.length === 0) {
    const staleUnreadIds = new Set(
      uniqueIds.filter((id) => state.items.some((item) => item.id === id && !item.is_read)),
    );
    return staleUnreadIds.size === 0
      ? state
      : {
          ...state,
          items: state.items.map((item) =>
            staleUnreadIds.has(item.id) ? markItemRead(item) : item,
          ),
        };
  }

  const version = state.version + 1;
  const itemsById = new Map(state.items.map((item) => [item.id, item]));
  const readById = new Map(state.overlays.readById);
  let countDelta = 0;
  let countBecameUnknown = false;

  for (const id of newIds) {
    const item = itemsById.get(id);
    const itemDelta: ReadCountDelta = item ? (item.is_read ? 0 : -1) : null;
    if (itemDelta === null) {
      countBecameUnknown = true;
    } else {
      countDelta += itemDelta;
    }
    readById.set(id, { version, countDelta: itemDelta });
  }

  const idsToMark = new Set(newIds);
  return {
    ...state,
    items: state.items.map((item) =>
      idsToMark.has(item.id) ? markItemRead(item) : item,
    ),
    unreadCount: countBecameUnknown
      ? null
      : adjustUnreadCount(state.unreadCount, countDelta),
    version,
    overlays: { ...state.overlays, readById },
  };
}

function applyReadAllEvent(state: NotificationRealtimeState): NotificationRealtimeState {
  const version = state.version + 1;
  const readById = new Map(state.overlays.readById);
  const knownIds = new Set([
    ...state.items.map((item) => item.id),
    ...state.overlays.createdById.keys(),
    ...state.overlays.readById.keys(),
  ]);
  for (const id of knownIds) {
    readById.set(id, { version, countDelta: 0 });
  }
  return {
    ...state,
    items: state.items.map(markItemRead),
    unreadCount: 0,
    version,
    overlays: { ...state.overlays, readById, readAll: { version } },
  };
}

function applyRealtimeEvent(
  state: NotificationRealtimeState,
  event: NotificationRealtimeEvent,
): NotificationRealtimeState {
  switch (event.event) {
    case 'created':
      return applyCreatedEvent(state, event.notification);
    case 'read':
      return applyReadEvent(state, event.notification_ids);
    case 'read_all':
      return applyReadAllEvent(state);
  }
}

function mergeFirstPage(
  state: NotificationRealtimeState,
  incomingItems: NotificationItem[],
  rawRequestVersion: number,
): NotificationRealtimeState {
  const requestVersion = normalizeRequestVersion(state, rawRequestVersion);
  let items = dedupeItems(incomingItems);
  const createdAfterRequest = [...state.overlays.createdById.values()]
    .filter((overlay) => overlay.version > requestVersion)
    .sort((left, right) => left.version - right.version);

  for (const overlay of createdAfterRequest) {
    const existingIndex = items.findIndex((item) => item.id === overlay.notification.id);
    if (existingIndex < 0) {
      items = [overlay.notification, ...items];
      continue;
    }

    const existing = items[existingIndex];
    items = [...items];
    items[existingIndex] = preserveReadState(
      overlay.notification,
      existing,
      state.overlays.readById.has(overlay.notification.id),
    );
  }

  if (state.overlays.readById.size > 0) {
    items = items.map((item) =>
      state.overlays.readById.has(item.id) ? markItemRead(item) : item,
    );
  }
  const loadedUnreadCount = items.filter((item) => !item.is_read).length;
  const unreadCount =
    state.unreadCount !== null && state.unreadCount < loadedUnreadCount
      ? null
      : state.unreadCount;

  return {
    ...state,
    items,
    unreadCount,
    overlays: {
      createdById: compactOverlayMap(state.overlays.createdById, requestVersion),
      readById: compactOverlayMap(state.overlays.readById, requestVersion),
      readAll:
        state.overlays.readAll && state.overlays.readAll.version > requestVersion
          ? state.overlays.readAll
          : null,
    },
  };
}

function applyLocalReadAllConfirmation(
  state: NotificationRealtimeState,
  notificationIds: string[],
  rawUpdatedCount: number,
  countIsAmbiguous: boolean,
): NotificationRealtimeState {
  const updatedCount = Number.isFinite(rawUpdatedCount)
    ? Math.max(0, Math.floor(rawUpdatedCount))
    : 0;
  const version = state.version + 1;
  const readById = new Map(state.overlays.readById);
  const idsToMark = new Set(notificationIds);
  for (const notificationId of idsToMark) {
    readById.set(notificationId, { version, countDelta: 0 });
  }
  return {
    ...state,
    items: state.items.map((item) =>
      idsToMark.has(item.id) ? markItemRead(item) : item,
    ),
    unreadCount: countIsAmbiguous
      ? null
      : adjustUnreadCount(state.unreadCount, -updatedCount),
    version,
    overlays: { ...state.overlays, readById },
  };
}

function mergeUnreadCount(
  state: NotificationRealtimeState,
  incomingCount: number | null,
  rawRequestVersion: number,
  knownItemIdsAtStart: string[],
): NotificationRealtimeState {
  const requestVersion = normalizeRequestVersion(state, rawRequestVersion);
  // A DB query can observe an in-flight mutation, so replaying deltas can double-apply it.
  // The caller must schedule a trailing reconciliation when this stale result is discarded.
  if (requestVersion !== state.version) {
    return state;
  }
  const unreadCount = normalizeUnreadCount(incomingCount);
  if (unreadCount !== 0) {
    const loadedUnreadCount = state.items.filter((item) => !item.is_read).length;
    return {
      ...state,
      unreadCount:
        unreadCount !== null && unreadCount < loadedUnreadCount
          ? null
          : unreadCount,
    };
  }

  // Zero is monotonic read authority only for rows known before the count query.
  // A first-page response can add a newer row without advancing this clock.
  const version = state.version + 1;
  const idsToMark = new Set(
    knownItemIdsAtStart.filter((notificationId) => notificationId.length > 0),
  );
  const readById = new Map(state.overlays.readById);
  for (const notificationId of idsToMark) {
    readById.set(notificationId, { version, countDelta: 0 });
  }
  const items = state.items.map((item) =>
    idsToMark.has(item.id) ? markItemRead(item) : item,
  );
  const loadedUnreadCount = items.filter((item) => !item.is_read).length;

  return {
    ...state,
    items,
    unreadCount: loadedUnreadCount > 0 ? null : 0,
    version,
    overlays: { ...state.overlays, readById },
  };
}

export function createNotificationRealtimeState(
  initial: InitialNotificationRealtimeState = {},
): NotificationRealtimeState {
  return {
    items: dedupeItems(initial.items ?? []),
    unreadCount: normalizeUnreadCount(initial.unreadCount),
    version: 0,
    overlays: {
      createdById: new Map(),
      readById: new Map(),
      readAll: null,
    },
  };
}

export function captureNotificationRealtimeVersion(state: NotificationRealtimeState): number {
  return state.version;
}

export function notificationRealtimeReducer(
  state: NotificationRealtimeState,
  action: NotificationRealtimeReducerAction,
): NotificationRealtimeState {
  switch (action.type) {
    case 'REALTIME_EVENT_RECEIVED':
      return applyRealtimeEvent(state, action.event);
    case 'LOCAL_MUTATION_RECORDED':
      return { ...state, version: state.version + 1 };
    case 'FIRST_PAGE_RESOLVED':
      return mergeFirstPage(state, action.items, action.requestVersion);
    case 'LOCAL_READ_ALL_CONFIRMED':
      return applyLocalReadAllConfirmation(
        state,
        action.notificationIds,
        action.updatedCount,
        action.countIsAmbiguous,
      );
    case 'UNREAD_COUNT_RESOLVED':
      return mergeUnreadCount(
        state,
        action.unreadCount,
        action.requestVersion,
        action.knownItemIdsAtStart,
      );
  }
}
