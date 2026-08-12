import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { normalizeApiError, type ApiError } from '@/shared/api/errors';
import { useRealtimeTransport } from '@/features/realtime/application/RealtimeProvider';
import { publishTripEvent } from '@/features/trips/tripEvents';
import {
  acceptTripInvitation,
  declineTripInvitation,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api';
import {
  captureNotificationRealtimeVersion,
  createNotificationRealtimeState,
  notificationRealtimeReducer,
  type NotificationRealtimeState,
} from './realtimeReducer';
import {
  parseNotificationRealtimeEvent,
  type NotificationRealtimeEvent,
} from '../realtimeEvents';
import type {
  InvitationAction,
  InvitationStatus,
  NotificationErrorSource,
  NotificationItem,
  NotificationLoadMode,
  NotificationOverride,
  NotificationListStatus,
  NotificationsContextValue,
} from '../types';

interface NotificationsProviderProps extends PropsWithChildren {
  ownerUserId: string | null;
}

interface OwnerGeneration {
  ownerUserId: string;
  generation: number;
}

type RowErrorSource = 'read' | 'invitation';

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyOverride(item: NotificationItem, override: NotificationOverride | undefined): NotificationItem {
  if (!override) {
    return item;
  }
  let next = override.isRead === undefined ? item : { ...item, is_read: override.isRead };
  if (override.invitationStatus !== undefined && item.notification_type === 'TRIP_INVITATION') {
    const payload = isRecord(item.payload) ? item.payload : {};
    next = {
      ...next,
      payload: { ...payload, invitation_status: override.invitationStatus },
    };
  }
  return next;
}

function applyResponseOverrides(
  items: NotificationItem[],
  overrides: Map<string, NotificationOverride>,
  requestMutationVersion: number,
): NotificationItem[] {
  return items.map((item) => {
    const override = overrides.get(item.id);
    return applyOverride(
      item,
      override && override.version > requestMutationVersion ? override : undefined,
    );
  });
}

function OwnedNotificationsProvider({ children, ownerUserId }: NotificationsProviderProps) {
  const { subscribe } = useRealtimeTransport();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [status, setStatus] = useState<NotificationListStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [errorSource, setErrorSource] = useState<NotificationErrorSource>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [lastKnownUnreadCount, setLastKnownUnreadCount] = useState<number | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [pendingReadIds, setPendingReadIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingInvitationActions, setPendingInvitationActions] = useState<ReadonlyMap<string, InvitationAction>>(
    new Map(),
  );
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, ApiError>>(new Map());
  const [globalMutationError, setGlobalMutationError] = useState<ApiError | null>(null);

  const itemsRef = useRef<NotificationItem[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const firstPageRequestRef = useRef(0);
  const firstPageInFlightRef = useRef<number | null>(null);
  const listGenerationRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const hasUsablePageRef = useRef(false);
  const hasRequestedListRef = useRef(false);
  const overridesRef = useRef(new Map<string, NotificationOverride>());
  const realtimeStateRef = useRef(createNotificationRealtimeState());
  const lastKnownUnreadCountRef = useRef<number | null>(null);
  const countRequestRef = useRef(0);
  const realtimeCountRequestedRef = useRef(false);
  const realtimeCountRunningRef = useRef(false);
  const readLocksRef = useRef(new Set<string>());
  const markAllLockRef = useRef(false);
  const invitationLocksRef = useRef(new Map<string, InvitationAction>());
  const rowErrorSourcesRef = useRef(new Map<string, RowErrorSource>());
  const readOutcomeSequenceRef = useRef(0);
  const readOutcomeByIdRef = useRef(new Map<string, number>());
  const readAllOutcomeSequenceRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const providerActiveRef = useRef(true);
  const activeOwnerUserIdRef = useRef(ownerUserId);
  const ownerGenerationRef = useRef(1);

  const captureOwnerGeneration = useCallback((): OwnerGeneration | null => {
    if (
      !ownerUserId ||
      !providerActiveRef.current ||
      activeOwnerUserIdRef.current !== ownerUserId
    ) {
      return null;
    }
    return { ownerUserId, generation: ownerGenerationRef.current };
  }, [ownerUserId]);

  const isOwnerGenerationCurrent = useCallback(
    (ownerGeneration: OwnerGeneration | null): ownerGeneration is OwnerGeneration => {
      return Boolean(
        ownerGeneration &&
          providerActiveRef.current &&
          activeOwnerUserIdRef.current === ownerGeneration.ownerUserId &&
          ownerGenerationRef.current === ownerGeneration.generation,
      );
    },
    [],
  );

  useLayoutEffect(() => {
    providerActiveRef.current = true;
    activeOwnerUserIdRef.current = ownerUserId;
    const readLocks = readLocksRef.current;
    const invitationLocks = invitationLocksRef.current;
    const rowErrorSources = rowErrorSourcesRef.current;
    const readOutcomesById = readOutcomeByIdRef.current;
    return () => {
      providerActiveRef.current = false;
      ownerGenerationRef.current += 1;
      firstPageRequestRef.current += 1;
      listGenerationRef.current += 1;
      countRequestRef.current += 1;
      realtimeCountRequestedRef.current = false;
      firstPageInFlightRef.current = null;
      loadMoreInFlightRef.current = false;
      readLocks.clear();
      markAllLockRef.current = false;
      invitationLocks.clear();
      rowErrorSources.clear();
      readOutcomesById.clear();
      readOutcomeSequenceRef.current = 0;
      readAllOutcomeSequenceRef.current = 0;
    };
  }, [ownerUserId]);

  const commitRealtimeState = useCallback(
    (next: NotificationRealtimeState, ownerGeneration: OwnerGeneration) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const loadedUnreadCount = next.items.filter((item) => !item.is_read).length;
      const effectiveNext =
        next.unreadCount !== null && next.unreadCount < loadedUnreadCount
          ? { ...next, unreadCount: null }
          : next;
      const previous = realtimeStateRef.current;
      realtimeStateRef.current = effectiveNext;
      if (previous.items !== effectiveNext.items) {
        itemsRef.current = effectiveNext.items;
        setItems(effectiveNext.items);
      }
      if (previous.unreadCount !== effectiveNext.unreadCount) {
        setUnreadCount(effectiveNext.unreadCount);
      }
      if (
        effectiveNext.unreadCount !== null &&
        lastKnownUnreadCountRef.current !== effectiveNext.unreadCount
      ) {
        lastKnownUnreadCountRef.current = effectiveNext.unreadCount;
        setLastKnownUnreadCount(effectiveNext.unreadCount);
      }
    },
    [isOwnerGenerationCurrent],
  );

  const updateItems = useCallback(
    (
      update: (current: NotificationItem[]) => NotificationItem[],
      ownerGeneration: OwnerGeneration,
    ) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const next = update(itemsRef.current);
      commitRealtimeState(
        { ...realtimeStateRef.current, items: next },
        ownerGeneration,
      );
    },
    [commitRealtimeState, isOwnerGenerationCurrent],
  );

  const clearResolvedReadErrors = useCallback(
    (
      notificationIds: readonly string[] | null,
      ownerGeneration: OwnerGeneration,
    ) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const targetIds = notificationIds === null ? null : new Set(notificationIds);
      setRowErrors((current) => {
        let next: Map<string, ApiError> | null = null;
        for (const [notificationId, source] of rowErrorSourcesRef.current) {
          if (
            source === 'read' &&
            (targetIds === null || targetIds.has(notificationId))
          ) {
            next ??= new Map(current);
            next.delete(notificationId);
            rowErrorSourcesRef.current.delete(notificationId);
          }
        }
        return next ?? current;
      });
      if (notificationIds === null) {
        setGlobalMutationError(null);
      }
    },
    [isOwnerGenerationCurrent],
  );

  const applyNotificationEvent = useCallback(
    (event: NotificationRealtimeEvent, ownerGeneration: OwnerGeneration) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const effectiveEvent: NotificationRealtimeEvent =
        event.event === 'created'
          ? {
              ...event,
              notification: applyOverride(
                event.notification,
                overridesRef.current.get(event.notification.id),
              ),
            }
          : event;
      if (effectiveEvent.event === 'read') {
        const sequence = readOutcomeSequenceRef.current + 1;
        readOutcomeSequenceRef.current = sequence;
        for (const notificationId of effectiveEvent.notification_ids) {
          readOutcomeByIdRef.current.set(notificationId, sequence);
        }
      } else if (effectiveEvent.event === 'read_all') {
        const sequence = readOutcomeSequenceRef.current + 1;
        readOutcomeSequenceRef.current = sequence;
        readAllOutcomeSequenceRef.current = sequence;
      }
      const next = notificationRealtimeReducer(realtimeStateRef.current, {
        type: 'REALTIME_EVENT_RECEIVED',
        event: effectiveEvent,
      });
      const version = next.version;
      if (effectiveEvent.event === 'read') {
        for (const notificationId of effectiveEvent.notification_ids) {
          const current = overridesRef.current.get(notificationId);
          overridesRef.current.set(notificationId, {
            ...current,
            isRead: true,
            version,
          });
        }
        clearResolvedReadErrors(effectiveEvent.notification_ids, ownerGeneration);
      } else if (effectiveEvent.event === 'read_all') {
        for (const [notificationId, readOverlay] of next.overlays.readById) {
          if (readOverlay.version !== version) {
            continue;
          }
          const current = overridesRef.current.get(notificationId);
          overridesRef.current.set(notificationId, {
            ...current,
            isRead: true,
            version,
          });
        }
        clearResolvedReadErrors(null, ownerGeneration);
      } else if (!hasUsablePageRef.current) {
        hasUsablePageRef.current = true;
        setStatus('ready');
        setErrorSource((current) => current === 'initial' ? 'refresh' : current);
      }
      commitRealtimeState(next, ownerGeneration);
    },
    [clearResolvedReadErrors, commitRealtimeState, isOwnerGenerationCurrent],
  );

  const clearRowError = useCallback(
    (notificationId: string, ownerGeneration: OwnerGeneration) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      setRowErrors((current) => {
        if (!current.has(notificationId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(notificationId);
        rowErrorSourcesRef.current.delete(notificationId);
        return next;
      });
    },
    [isOwnerGenerationCurrent],
  );

  const setRowError = useCallback(
    (
      notificationId: string,
      nextError: ApiError,
      source: RowErrorSource,
      ownerGeneration: OwnerGeneration,
    ) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      rowErrorSourcesRef.current.set(notificationId, source);
      setRowErrors((current) => new Map(current).set(notificationId, nextError));
    },
    [isOwnerGenerationCurrent],
  );

  const applyLocalOverride = useCallback(
    (
      notificationId: string,
      patch: Omit<NotificationOverride, 'version'>,
      ownerGeneration: OwnerGeneration,
    ) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const clock = notificationRealtimeReducer(realtimeStateRef.current, {
        type: 'LOCAL_MUTATION_RECORDED',
      });
      realtimeStateRef.current = clock;
      const current = overridesRef.current.get(notificationId);
      const override: NotificationOverride = {
        ...current,
        ...patch,
        version: clock.version,
      };
      overridesRef.current.set(notificationId, override);
      updateItems(
        (visibleItems) =>
          visibleItems.map((item) =>
            item.id === notificationId ? applyOverride(item, override) : item,
          ),
        ownerGeneration,
      );
    },
    [isOwnerGenerationCurrent, updateItems],
  );

  const reconcileUnreadCount = useCallback(
    async (expectedOwnerGeneration?: OwnerGeneration) => {
      const ownerGeneration = expectedOwnerGeneration ?? captureOwnerGeneration();
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      const requestId = countRequestRef.current + 1;
      countRequestRef.current = requestId;
      const requestState = realtimeStateRef.current;
      const requestVersion = captureNotificationRealtimeVersion(
        requestState,
      );
      const knownItemIdsAtStart = requestState.items.map((item) => item.id);
      try {
        const count = await getUnreadCount();
        if (
          isOwnerGenerationCurrent(ownerGeneration) &&
          requestId === countRequestRef.current
        ) {
          const previous = realtimeStateRef.current;
          const next = notificationRealtimeReducer(previous, {
            type: 'UNREAD_COUNT_RESOLVED',
            unreadCount: count,
            requestVersion,
            knownItemIdsAtStart,
          });
          if (count === 0 && next.version > previous.version) {
            const sequence = readOutcomeSequenceRef.current + 1;
            readOutcomeSequenceRef.current = sequence;
            for (const notificationId of knownItemIdsAtStart) {
              readOutcomeByIdRef.current.set(notificationId, sequence);
              const current = overridesRef.current.get(notificationId);
              overridesRef.current.set(notificationId, {
                ...current,
                isRead: true,
                version: next.version,
              });
            }
            clearResolvedReadErrors(knownItemIdsAtStart, ownerGeneration);
          }
          commitRealtimeState(next, ownerGeneration);
        }
      } catch {
        // Keep the last usable badge. Focus and foreground transitions retry.
      }
    },
    [
      captureOwnerGeneration,
      clearResolvedReadErrors,
      commitRealtimeState,
      isOwnerGenerationCurrent,
    ],
  );

  const requestRealtimeCountReconcile = useCallback(
    (ownerGeneration: OwnerGeneration) => {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      realtimeCountRequestedRef.current = true;
      if (realtimeCountRunningRef.current) {
        return;
      }
      realtimeCountRunningRef.current = true;
      void (async () => {
        try {
          while (
            realtimeCountRequestedRef.current &&
            isOwnerGenerationCurrent(ownerGeneration)
          ) {
            realtimeCountRequestedRef.current = false;
            await reconcileUnreadCount(ownerGeneration);
          }
        } finally {
          realtimeCountRunningRef.current = false;
        }
      })();
    },
    [isOwnerGenerationCurrent, reconcileUnreadCount],
  );

  const loadFirstPage = useCallback(
    async (mode: NotificationLoadMode, expectedOwnerGeneration?: OwnerGeneration) => {
      const ownerGeneration = expectedOwnerGeneration ?? captureOwnerGeneration();
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      hasRequestedListRef.current = true;
      const requestId = firstPageRequestRef.current + 1;
      firstPageRequestRef.current = requestId;
      firstPageInFlightRef.current = requestId;
      listGenerationRef.current += 1;
      const requestVersion = captureNotificationRealtimeVersion(
        realtimeStateRef.current,
      );
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
      setError(null);
      setErrorSource(null);
      if (mode === 'initial') {
        setStatus('loading');
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const page = await listNotifications();
        if (
          !isOwnerGenerationCurrent(ownerGeneration) ||
          requestId !== firstPageRequestRef.current
        ) {
          return;
        }
        nextCursorRef.current = page.nextCursor;
        setHasNextPage(page.nextCursor !== null);
        const responseItems = applyResponseOverrides(
          page.items,
          overridesRef.current,
          requestVersion,
        );
        commitRealtimeState(
          notificationRealtimeReducer(realtimeStateRef.current, {
            type: 'FIRST_PAGE_RESOLVED',
            items: responseItems,
            requestVersion,
          }),
          ownerGeneration,
        );
        for (const [notificationId, override] of overridesRef.current) {
          if (override.version <= requestVersion) {
            overridesRef.current.delete(notificationId);
          }
        }
        hasUsablePageRef.current = true;
        setStatus('ready');
      } catch (caught) {
        if (
          !isOwnerGenerationCurrent(ownerGeneration) ||
          requestId !== firstPageRequestRef.current
        ) {
          return;
        }
        setError(normalizeApiError(caught));
        if (!hasUsablePageRef.current) {
          setErrorSource('initial');
          setStatus('error');
        } else {
          setErrorSource('refresh');
          setStatus('ready');
        }
      } finally {
        if (requestId === firstPageRequestRef.current) {
          firstPageInFlightRef.current = null;
          if (isOwnerGenerationCurrent(ownerGeneration)) {
            setRefreshing(false);
          }
        }
      }
    },
    [captureOwnerGeneration, commitRealtimeState, isOwnerGenerationCurrent],
  );

  const loadMore = useCallback(async () => {
    const ownerGeneration = captureOwnerGeneration();
    const cursor = nextCursorRef.current;
    if (
      !isOwnerGenerationCurrent(ownerGeneration) ||
      firstPageInFlightRef.current !== null ||
      loadMoreInFlightRef.current ||
      !cursor
    ) {
      return;
    }
    const generation = listGenerationRef.current;
    const requestVersion = captureNotificationRealtimeVersion(
      realtimeStateRef.current,
    );
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setError(null);
    setErrorSource(null);
    try {
      const page = await listNotifications(cursor);
      if (
        !isOwnerGenerationCurrent(ownerGeneration) ||
        generation !== listGenerationRef.current
      ) {
        return;
      }
      nextCursorRef.current = page.nextCursor;
      setHasNextPage(page.nextCursor !== null);
      updateItems(
        (current) => {
          const seen = new Set(current.map((item) => item.id));
          const additions = applyResponseOverrides(
            page.items,
            overridesRef.current,
            requestVersion,
          ).filter((item) => !seen.has(item.id));
          return [...current, ...additions];
        },
        ownerGeneration,
      );
    } catch (caught) {
      if (
        !isOwnerGenerationCurrent(ownerGeneration) ||
        generation !== listGenerationRef.current
      ) {
        return;
      }
      setError(normalizeApiError(caught));
      setErrorSource('loadMore');
    } finally {
      if (generation === listGenerationRef.current) {
        loadMoreInFlightRef.current = false;
        if (isOwnerGenerationCurrent(ownerGeneration)) {
          setLoadingMore(false);
        }
      }
    }
  }, [captureOwnerGeneration, isOwnerGenerationCurrent, updateItems]);

  const refreshForFocus = useCallback(async () => {
    const ownerGeneration = captureOwnerGeneration();
    if (!isOwnerGenerationCurrent(ownerGeneration)) {
      return;
    }
    await Promise.all([
      loadFirstPage(hasUsablePageRef.current ? 'silent' : 'initial', ownerGeneration),
      reconcileUnreadCount(ownerGeneration),
    ]);
  }, [captureOwnerGeneration, isOwnerGenerationCurrent, loadFirstPage, reconcileUnreadCount]);

  const refresh = useCallback(async () => {
    const ownerGeneration = captureOwnerGeneration();
    if (!isOwnerGenerationCurrent(ownerGeneration)) {
      return;
    }
    setGlobalMutationError(null);
    await Promise.all([
      loadFirstPage('refresh', ownerGeneration),
      reconcileUnreadCount(ownerGeneration),
    ]);
  }, [captureOwnerGeneration, isOwnerGenerationCurrent, loadFirstPage, reconcileUnreadCount]);

  const markRead = useCallback(
    async (notificationId: string): Promise<boolean> => {
      const ownerGeneration = captureOwnerGeneration();
      if (
        !isOwnerGenerationCurrent(ownerGeneration) ||
        readLocksRef.current.has(notificationId)
      ) {
        return false;
      }
      const notification = itemsRef.current.find((item) => item.id === notificationId);
      if (notification?.is_read) {
        return true;
      }
      readLocksRef.current.add(notificationId);
      setPendingReadIds(new Set(readLocksRef.current));
      clearRowError(notificationId, ownerGeneration);
      const outcomeSequenceAtStart = readOutcomeSequenceRef.current;
      try {
        await markNotificationRead(notificationId);
        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }
        applyNotificationEvent(
          { type: 'notification', event: 'read', notification_ids: [notificationId] },
          ownerGeneration,
        );
        await reconcileUnreadCount(ownerGeneration);
        return isOwnerGenerationCurrent(ownerGeneration);
      } catch (caught) {
        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }
        if (
          (readOutcomeByIdRef.current.get(notificationId) ?? 0) > outcomeSequenceAtStart ||
          readAllOutcomeSequenceRef.current > outcomeSequenceAtStart
        ) {
          return true;
        }
        setRowError(notificationId, normalizeApiError(caught), 'read', ownerGeneration);
        return false;
      } finally {
        readLocksRef.current.delete(notificationId);
        if (isOwnerGenerationCurrent(ownerGeneration)) {
          setPendingReadIds(new Set(readLocksRef.current));
        }
      }
    },
    [
      applyNotificationEvent,
      captureOwnerGeneration,
      clearRowError,
      isOwnerGenerationCurrent,
      reconcileUnreadCount,
      setRowError,
    ],
  );

  const markAllRead = useCallback(async (): Promise<boolean> => {
    const ownerGeneration = captureOwnerGeneration();
    if (!isOwnerGenerationCurrent(ownerGeneration) || markAllLockRef.current) {
      return false;
    }
    const visibleIdsAtStart = itemsRef.current.map((item) => item.id);
    const outcomeSequenceAtStart = readOutcomeSequenceRef.current;
    markAllLockRef.current = true;
    setMarkingAllRead(true);
    setGlobalMutationError(null);
    try {
      const updatedCount = await markAllNotificationsRead();
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return false;
      }
      const countIsAmbiguous =
        readAllOutcomeSequenceRef.current > outcomeSequenceAtStart;
      const sequence = readOutcomeSequenceRef.current + 1;
      readOutcomeSequenceRef.current = sequence;
      for (const notificationId of visibleIdsAtStart) {
        readOutcomeByIdRef.current.set(notificationId, sequence);
      }
      const next = notificationRealtimeReducer(realtimeStateRef.current, {
        type: 'LOCAL_READ_ALL_CONFIRMED',
        notificationIds: visibleIdsAtStart,
        updatedCount,
        countIsAmbiguous,
      });
      const version = next.version;
      for (const notificationId of visibleIdsAtStart) {
        const current = overridesRef.current.get(notificationId);
        overridesRef.current.set(notificationId, {
          ...current,
          isRead: true,
          version,
        });
      }
      commitRealtimeState(next, ownerGeneration);
      clearResolvedReadErrors(visibleIdsAtStart, ownerGeneration);
      await Promise.all([
        loadFirstPage(
          hasUsablePageRef.current ? 'silent' : 'initial',
          ownerGeneration,
        ),
        reconcileUnreadCount(ownerGeneration),
      ]);
      return isOwnerGenerationCurrent(ownerGeneration);
    } catch (caught) {
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return false;
      }
      if (readAllOutcomeSequenceRef.current > outcomeSequenceAtStart) {
        return true;
      }
      setGlobalMutationError(normalizeApiError(caught));
      return false;
    } finally {
      markAllLockRef.current = false;
      if (isOwnerGenerationCurrent(ownerGeneration)) {
        setMarkingAllRead(false);
      }
    }
  }, [
    captureOwnerGeneration,
    clearResolvedReadErrors,
    commitRealtimeState,
    isOwnerGenerationCurrent,
    loadFirstPage,
    reconcileUnreadCount,
  ]);

  const respondToInvitation = useCallback(
    async (
      notificationId: string,
      invitationId: string,
      tripId: string,
      action: InvitationAction,
    ): Promise<boolean> => {
      const ownerGeneration = captureOwnerGeneration();
      if (
        !isOwnerGenerationCurrent(ownerGeneration) ||
        invitationLocksRef.current.has(notificationId)
      ) {
        return false;
      }
      invitationLocksRef.current.set(notificationId, action);
      setPendingInvitationActions(new Map(invitationLocksRef.current));
      clearRowError(notificationId, ownerGeneration);
      try {
        if (action === 'accept') {
          await acceptTripInvitation(invitationId);
        } else {
          await declineTripInvitation(invitationId);
        }

        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }

        const nextStatus: InvitationStatus = action === 'accept' ? 'ACCEPTED' : 'DECLINED';
        applyLocalOverride(notificationId, { invitationStatus: nextStatus }, ownerGeneration);
        if (action === 'accept') {
          publishTripEvent({ type: 'membershipAdded', tripId });
        }

        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }

        const outcomeSequenceAtStart = readOutcomeSequenceRef.current;
        try {
          await markNotificationRead(notificationId);
          if (!isOwnerGenerationCurrent(ownerGeneration)) {
            return false;
          }
          applyNotificationEvent(
            { type: 'notification', event: 'read', notification_ids: [notificationId] },
            ownerGeneration,
          );
        } catch (caught) {
          if (!isOwnerGenerationCurrent(ownerGeneration)) {
            return false;
          }
          if (
            (readOutcomeByIdRef.current.get(notificationId) ?? 0) <=
              outcomeSequenceAtStart &&
            readAllOutcomeSequenceRef.current <= outcomeSequenceAtStart
          ) {
            setRowError(
              notificationId,
              normalizeApiError(caught),
              'invitation',
              ownerGeneration,
            );
          }
        }

        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }
        await Promise.all([
          loadFirstPage('silent', ownerGeneration),
          reconcileUnreadCount(ownerGeneration),
        ]);
        return isOwnerGenerationCurrent(ownerGeneration);
      } catch (caught) {
        if (!isOwnerGenerationCurrent(ownerGeneration)) {
          return false;
        }
        const nextError = normalizeApiError(caught);
        setRowError(notificationId, nextError, 'invitation', ownerGeneration);
        if (nextError.status === 404 || nextError.status === 409) {
          applyLocalOverride(notificationId, { invitationStatus: null }, ownerGeneration);
          await Promise.all([
            loadFirstPage('silent', ownerGeneration),
            reconcileUnreadCount(ownerGeneration),
          ]);
        }
        return false;
      } finally {
        invitationLocksRef.current.delete(notificationId);
        if (isOwnerGenerationCurrent(ownerGeneration)) {
          setPendingInvitationActions(new Map(invitationLocksRef.current));
        }
      }
    },
    [
      applyLocalOverride,
      applyNotificationEvent,
      captureOwnerGeneration,
      clearRowError,
      isOwnerGenerationCurrent,
      loadFirstPage,
      reconcileUnreadCount,
      setRowError,
    ],
  );

  useEffect(() => {
    const ownerGeneration = captureOwnerGeneration();
    if (!isOwnerGenerationCurrent(ownerGeneration)) {
      return;
    }
    void reconcileUnreadCount(ownerGeneration);
  }, [captureOwnerGeneration, isOwnerGenerationCurrent, reconcileUnreadCount]);

  useEffect(() => {
    const unsubscribe = subscribe('notification', (message) => {
      const event = parseNotificationRealtimeEvent(message);
      if (!event) {
        return;
      }
      const ownerGeneration = captureOwnerGeneration();
      if (!isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      applyNotificationEvent(event, ownerGeneration);
      if (event.event === 'read_all' && hasRequestedListRef.current) {
        void loadFirstPage(
          hasUsablePageRef.current ? 'silent' : 'initial',
          ownerGeneration,
        );
      }
      requestRealtimeCountReconcile(ownerGeneration);
    });
    return unsubscribe;
  }, [
    applyNotificationEvent,
    captureOwnerGeneration,
    isOwnerGenerationCurrent,
    loadFirstPage,
    requestRealtimeCountReconcile,
    subscribe,
  ]);

  useEffect(() => {
    const ownerGeneration = captureOwnerGeneration();
    if (!isOwnerGenerationCurrent(ownerGeneration)) {
      return;
    }
    appStateRef.current = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const becameActive = appStateRef.current !== 'active' && nextState === 'active';
      appStateRef.current = nextState;
      if (!becameActive || !isOwnerGenerationCurrent(ownerGeneration)) {
        return;
      }
      void reconcileUnreadCount(ownerGeneration);
      if (hasRequestedListRef.current) {
        void loadFirstPage(
          hasUsablePageRef.current ? 'silent' : 'initial',
          ownerGeneration,
        );
      }
    });
    return () => subscription?.remove();
  }, [
    captureOwnerGeneration,
    isOwnerGenerationCurrent,
    loadFirstPage,
    reconcileUnreadCount,
  ]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      items,
      status,
      error,
      errorSource,
      refreshing,
      loadingMore,
      hasNextPage,
      unreadCount,
      lastKnownUnreadCount,
      markingAllRead,
      pendingReadIds,
      pendingInvitationActions,
      rowErrors,
      globalMutationError,
      refreshForFocus,
      refresh,
      loadMore,
      markRead,
      markAllRead,
      respondToInvitation,
    }),
    [
      error,
      errorSource,
      globalMutationError,
      hasNextPage,
      items,
      lastKnownUnreadCount,
      loadMore,
      loadingMore,
      markAllRead,
      markRead,
      markingAllRead,
      pendingInvitationActions,
      pendingReadIds,
      refresh,
      refreshForFocus,
      refreshing,
      respondToInvitation,
      rowErrors,
      status,
      unreadCount,
    ],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function NotificationsProvider({ children, ownerUserId }: NotificationsProviderProps) {
  return (
    <OwnedNotificationsProvider key={ownerUserId ?? 'signed-out'} ownerUserId={ownerUserId}>
      {children}
    </OwnedNotificationsProvider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error('useNotifications must be used within NotificationsProvider');
  }
  return context;
}
