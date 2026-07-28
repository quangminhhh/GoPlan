import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { getExpenseDashboard } from '../api';
import { subscribeToExpenseEvents } from '../expenseEvents';
import type { ExpenseDashboardResponse } from '../types';

export type ExpenseDashboardLoadStatus = 'loading' | 'ready' | 'error';
export type ExpenseDashboardLoadMode = 'initial' | 'refresh' | 'silent';

interface UseExpenseDashboardOptions {
  autoReconcile?: boolean;
}

interface ExpenseDashboardSnapshot {
  tripId: string;
  dashboard: ExpenseDashboardResponse;
}

const MISSING_EXPENSE_DASHBOARD_ERROR: ApiError = {
  kind: 'message',
  message: 'Trip not found.',
  errorCode: 'TRIP_NOT_FOUND',
  status: 404,
};

function shouldClearExpenseDashboard(error: ApiError): boolean {
  return error.status === 404 && error.errorCode === 'TRIP_NOT_FOUND';
}

export function useExpenseDashboard(
  tripId: string | undefined,
  { autoReconcile = true }: UseExpenseDashboardOptions = {},
) {
  const [dashboard, setDashboard] =
    useState<ExpenseDashboardResponse | null>(null);
  const [status, setStatus] =
    useState<ExpenseDashboardLoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stateTripId, setStateTripId] = useState<string | undefined>(tripId);
  const [dashboardTripId, setDashboardTripId] = useState<
    string | undefined
  >();
  const snapshotRef = useRef<ExpenseDashboardSnapshot | null>(null);
  const requestIdRef = useRef(0);
  const activeTripIdRef = useRef(tripId);
  const focusedRef = useRef(false);

  useEffect(() => {
    activeTripIdRef.current = tripId;
    requestIdRef.current += 1;
  }, [tripId]);

  const isCurrentRequest = useCallback(
    (requestId: number, resourceKey: string) => {
      return (
        requestId === requestIdRef.current &&
        resourceKey === activeTripIdRef.current
      );
    },
    [],
  );

  const commitDashboard = useCallback(
    (resourceKey: string, nextDashboard: ExpenseDashboardResponse) => {
      snapshotRef.current = {
        tripId: resourceKey,
        dashboard: nextDashboard,
      };
      setStateTripId(resourceKey);
      setDashboardTripId(resourceKey);
      setDashboard(nextDashboard);
      setError(null);
      setStatus('ready');
    },
    [],
  );

  const refresh = useCallback(
    async (mode: ExpenseDashboardLoadMode = 'silent') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!tripId) {
        snapshotRef.current = null;
        setStateTripId(tripId);
        setDashboardTripId(undefined);
        setDashboard(null);
        setError(MISSING_EXPENSE_DASHBOARD_ERROR);
        setStatus('error');
        setRefreshing(false);
        return;
      }

      const resourceKey = tripId;
      const hasDashboard = snapshotRef.current?.tripId === resourceKey;
      setStateTripId(resourceKey);

      if (!hasDashboard) {
        snapshotRef.current = null;
        setDashboardTripId(undefined);
        setDashboard(null);
        setError(null);
        setStatus('loading');
        setRefreshing(false);
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const nextDashboard = await getExpenseDashboard(resourceKey);
        if (!isCurrentRequest(requestId, resourceKey)) {
          return;
        }
        commitDashboard(resourceKey, nextDashboard);
      } catch (caught) {
        if (!isCurrentRequest(requestId, resourceKey)) {
          return;
        }

        const nextError = normalizeApiError(caught);
        const hasCurrentDashboard =
          snapshotRef.current?.tripId === resourceKey;
        setStateTripId(resourceKey);

        if (
          !hasCurrentDashboard ||
          shouldClearExpenseDashboard(nextError)
        ) {
          snapshotRef.current = null;
          setDashboardTripId(undefined);
          setDashboard(null);
          setStatus('error');
        } else {
          setStatus('ready');
        }
        setError(nextError);
      } finally {
        if (isCurrentRequest(requestId, resourceKey)) {
          setRefreshing(false);
        }
      }
    },
    [commitDashboard, isCurrentRequest, tripId],
  );

  const invalidate = useCallback(() => {
    requestIdRef.current += 1;
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!autoReconcile || !tripId) {
      return undefined;
    }

    return subscribeToExpenseEvents(tripId, () => {
      if (focusedRef.current) {
        return refresh('silent');
      }
      return undefined;
    });
  }, [autoReconcile, refresh, tripId]);

  const reconcileOnForeground = useCallback(() => {
    if (autoReconcile && focusedRef.current) {
      void refresh(
        snapshotRef.current?.tripId === tripId ? 'silent' : 'initial',
      );
    }
  }, [autoReconcile, refresh, tripId]);

  useAppForegroundEffect(reconcileOnForeground);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (autoReconcile) {
        void refresh(
          snapshotRef.current?.tripId === tripId ? 'silent' : 'initial',
        );
      }

      return () => {
        focusedRef.current = false;
        requestIdRef.current += 1;
      };
    }, [autoReconcile, refresh, tripId]),
  );

  const stateMatchesTrip = stateTripId === tripId;
  const visibleDashboard =
    stateMatchesTrip && dashboardTripId === tripId ? dashboard : null;

  return {
    dashboard: visibleDashboard,
    status: stateMatchesTrip ? status : 'loading',
    error: stateMatchesTrip ? error : null,
    refreshing: stateMatchesTrip ? refreshing : false,
    refresh,
    invalidate,
  };
}
