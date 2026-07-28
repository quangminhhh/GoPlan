import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { getExpenseDetail } from '../api';
import { subscribeToExpenseEvents } from '../expenseEvents';
import type { ExpenseDetailResponse } from '../types';

export type ExpenseDetailLoadStatus = 'loading' | 'ready' | 'error';
export type ExpenseDetailLoadMode = 'initial' | 'refresh' | 'silent';

interface UseExpenseDetailOptions {
  autoReconcile?: boolean;
}

interface ExpenseDetailSnapshot {
  resourceKey: string;
  detail: ExpenseDetailResponse;
}

const MISSING_EXPENSE_DETAIL_ERROR: ApiError = {
  kind: 'message',
  message: 'Expense not found.',
  errorCode: 'EXPENSE_NOT_FOUND',
  status: 404,
};

function getExpenseDetailResourceKey(
  tripId: string | undefined,
  expenseId: string | undefined,
): string | undefined {
  if (!tripId || !expenseId) {
    return undefined;
  }
  return JSON.stringify([tripId, expenseId]);
}

function shouldClearExpenseDetail(error: ApiError): boolean {
  return (
    error.status === 404 &&
    (error.errorCode === 'TRIP_NOT_FOUND' ||
      error.errorCode === 'EXPENSE_NOT_FOUND')
  );
}

export function useExpenseDetail(
  tripId: string | undefined,
  expenseId: string | undefined,
  { autoReconcile = true }: UseExpenseDetailOptions = {},
) {
  const resourceKey = getExpenseDetailResourceKey(tripId, expenseId);
  const [detail, setDetail] = useState<ExpenseDetailResponse | null>(null);
  const [status, setStatus] = useState<ExpenseDetailLoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stateResourceKey, setStateResourceKey] = useState<
    string | undefined
  >(resourceKey);
  const [detailResourceKey, setDetailResourceKey] = useState<
    string | undefined
  >();
  const snapshotRef = useRef<ExpenseDetailSnapshot | null>(null);
  const requestIdRef = useRef(0);
  const activeResourceKeyRef = useRef(resourceKey);
  const focusedRef = useRef(false);

  useEffect(() => {
    activeResourceKeyRef.current = resourceKey;
    requestIdRef.current += 1;
  }, [resourceKey]);

  const isCurrentRequest = useCallback(
    (requestId: number, requestResourceKey: string) => {
      return (
        requestId === requestIdRef.current &&
        requestResourceKey === activeResourceKeyRef.current
      );
    },
    [],
  );

  const commitDetail = useCallback(
    (
      requestResourceKey: string,
      nextDetail: ExpenseDetailResponse,
    ) => {
      snapshotRef.current = {
        resourceKey: requestResourceKey,
        detail: nextDetail,
      };
      setStateResourceKey(requestResourceKey);
      setDetailResourceKey(requestResourceKey);
      setDetail(nextDetail);
      setError(null);
      setStatus('ready');
    },
    [],
  );

  const refresh = useCallback(
    async (mode: ExpenseDetailLoadMode = 'silent') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!tripId || !expenseId || !resourceKey) {
        snapshotRef.current = null;
        setStateResourceKey(resourceKey);
        setDetailResourceKey(undefined);
        setDetail(null);
        setError(MISSING_EXPENSE_DETAIL_ERROR);
        setStatus('error');
        setRefreshing(false);
        return;
      }

      const requestResourceKey = resourceKey;
      const hasDetail =
        snapshotRef.current?.resourceKey === requestResourceKey;
      setStateResourceKey(requestResourceKey);

      if (!hasDetail) {
        snapshotRef.current = null;
        setDetailResourceKey(undefined);
        setDetail(null);
        setError(null);
        setStatus('loading');
        setRefreshing(false);
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const nextDetail = await getExpenseDetail(tripId, expenseId);
        if (!isCurrentRequest(requestId, requestResourceKey)) {
          return;
        }
        commitDetail(requestResourceKey, nextDetail);
      } catch (caught) {
        if (!isCurrentRequest(requestId, requestResourceKey)) {
          return;
        }

        const nextError = normalizeApiError(caught);
        const hasCurrentDetail =
          snapshotRef.current?.resourceKey === requestResourceKey;
        setStateResourceKey(requestResourceKey);

        if (!hasCurrentDetail || shouldClearExpenseDetail(nextError)) {
          snapshotRef.current = null;
          setDetailResourceKey(undefined);
          setDetail(null);
          setStatus('error');
        } else {
          setStatus('ready');
        }
        setError(nextError);
      } finally {
        if (isCurrentRequest(requestId, requestResourceKey)) {
          setRefreshing(false);
        }
      }
    },
    [
      commitDetail,
      expenseId,
      isCurrentRequest,
      resourceKey,
      tripId,
    ],
  );

  const invalidate = useCallback(() => {
    requestIdRef.current += 1;
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!autoReconcile || !tripId || !resourceKey) {
      return undefined;
    }

    return subscribeToExpenseEvents(tripId, () => {
      if (focusedRef.current) {
        return refresh('silent');
      }
      return undefined;
    });
  }, [autoReconcile, refresh, resourceKey, tripId]);

  const reconcileOnForeground = useCallback(() => {
    if (autoReconcile && focusedRef.current) {
      void refresh(
        snapshotRef.current?.resourceKey === resourceKey
          ? 'silent'
          : 'initial',
      );
    }
  }, [autoReconcile, refresh, resourceKey]);

  useAppForegroundEffect(reconcileOnForeground);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (autoReconcile) {
        void refresh(
          snapshotRef.current?.resourceKey === resourceKey
            ? 'silent'
            : 'initial',
        );
      }

      return () => {
        focusedRef.current = false;
        requestIdRef.current += 1;
      };
    }, [autoReconcile, refresh, resourceKey]),
  );

  const stateMatchesResource = stateResourceKey === resourceKey;
  const visibleDetail =
    stateMatchesResource && detailResourceKey === resourceKey
      ? detail
      : null;

  return {
    detail: visibleDetail,
    status: stateMatchesResource ? status : 'loading',
    error: stateMatchesResource ? error : null,
    refreshing: stateMatchesResource ? refreshing : false,
    refresh,
    invalidate,
  };
}
