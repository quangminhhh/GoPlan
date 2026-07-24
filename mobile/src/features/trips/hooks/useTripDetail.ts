import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { getTripDetail } from '../api';
import { subscribeToTripEvents } from '../tripEvents';
import type { Trip, TripDetailResponse, TripStatus } from '../types';

export type TripDetailLoadStatus = 'loading' | 'ready' | 'error';
export type TripDetailLoadMode = 'initial' | 'refresh' | 'silent';

interface UseTripDetailOptions {
  autoReconcile?: boolean;
}

const MISSING_TRIP_ERROR: ApiError = {
  kind: 'message',
  message: 'Trip not found.',
  errorCode: 'TRIP_NOT_FOUND',
  status: 404,
};

export function useTripDetail(
  tripId: string | undefined,
  { autoReconcile = true }: UseTripDetailOptions = {},
) {
  const [detail, setDetail] = useState<TripDetailResponse | null>(null);
  const [status, setStatus] = useState<TripDetailLoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stateTripId, setStateTripId] = useState<string | undefined>(tripId);
  const detailRef = useRef<TripDetailResponse | null>(null);
  const requestIdRef = useRef(0);

  const commitDetail = useCallback((nextDetail: TripDetailResponse) => {
    setStateTripId(nextDetail.trip.id);
    detailRef.current = nextDetail;
    setDetail(nextDetail);
    setError(null);
    setStatus('ready');
  }, []);

  const refresh = useCallback(
    async (mode: TripDetailLoadMode = 'silent') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!tripId) {
        setStateTripId(tripId);
        detailRef.current = null;
        setDetail(null);
        setError(MISSING_TRIP_ERROR);
        setStatus('error');
        setRefreshing(false);
        return;
      }

      const hasDetail = detailRef.current?.trip.id === tripId;
      setStateTripId(tripId);
      if (!hasDetail) {
        detailRef.current = null;
        setError(null);
        setStatus('loading');
        setRefreshing(false);
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const nextDetail = await getTripDetail(tripId);
        if (requestId === requestIdRef.current) {
          commitDetail(nextDetail);
        }
      } catch (caught) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        const nextError = normalizeApiError(caught);
        setStateTripId(tripId);
        if (nextError.status === 404 || !detailRef.current) {
          detailRef.current = null;
          setDetail(null);
          setStatus('error');
        } else {
          setStatus('ready');
        }
        setError(nextError);
      } finally {
        if (requestId === requestIdRef.current) {
          setRefreshing(false);
        }
      }
    },
    [commitDetail, tripId],
  );

  const applyTrip = useCallback(
    (trip: Trip) => {
      const current = detailRef.current;
      if (!current || current.trip.id !== trip.id) {
        return;
      }
      requestIdRef.current += 1;
      commitDetail({ ...current, trip });
      setRefreshing(false);
    },
    [commitDetail],
  );

  const applyStatus = useCallback(
    (nextStatus: TripStatus) => {
      const current = detailRef.current;
      if (!current) {
        return;
      }
      applyTrip({ ...current.trip, status: nextStatus });
    },
    [applyTrip],
  );

  const applyMemberRemoved = useCallback(
    (userId: string) => {
      const current = detailRef.current;
      if (!current || current.trip.id !== tripId) {
        return;
      }
      requestIdRef.current += 1;
      commitDetail({
        ...current,
        members: current.members.filter((member) => member.user.id !== userId),
      });
      setRefreshing(false);
    },
    [commitDetail, tripId],
  );

  useEffect(
    () => {
      if (!autoReconcile) {
        return undefined;
      }
      return subscribeToTripEvents((event) => {
        if (event.type === 'updated' && event.trip.id === tripId) {
          applyTrip(event.trip);
        } else if (event.type === 'statusChanged' && event.tripId === tripId) {
          applyStatus(event.status);
        } else if (event.type === 'memberRemoved' && event.tripId === tripId) {
          applyMemberRemoved(event.userId);
        }
      });
    },
    [applyMemberRemoved, applyStatus, applyTrip, autoReconcile, tripId],
  );

  const reconcileOnForeground = useCallback(() => {
    if (autoReconcile) {
      void refresh(detailRef.current?.trip.id === tripId ? 'silent' : 'initial');
    }
  }, [autoReconcile, refresh, tripId]);

  useAppForegroundEffect(reconcileOnForeground);

  useFocusEffect(
    useCallback(() => {
      if (autoReconcile) {
        void refresh(detailRef.current?.trip.id === tripId ? 'silent' : 'initial');
      }
      return () => {
        requestIdRef.current += 1;
      };
    }, [autoReconcile, refresh, tripId]),
  );

  const stateMatchesTrip = stateTripId === tripId;
  const visibleDetail = stateMatchesTrip && detail?.trip.id === tripId ? detail : null;

  return {
    detail: visibleDetail,
    status: stateMatchesTrip ? status : 'loading',
    error: stateMatchesTrip ? error : null,
    refreshing: stateMatchesTrip ? refreshing : false,
    refresh,
    applyTrip,
    applyStatus,
  };
}
