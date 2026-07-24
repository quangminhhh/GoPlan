import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { getTimeline } from '../api';
import { subscribeToTimelineEvents } from '../timelineEvents';
import type { TimelineResponse } from '../types';

export type TimelineLoadStatus = 'loading' | 'ready' | 'error';
export type TimelineLoadMode = 'initial' | 'refresh' | 'silent';

interface UseTimelineOptions {
  autoReconcile?: boolean;
}

interface TimelineSnapshot {
  tripId: string;
  timeline: TimelineResponse;
}

const MISSING_TIMELINE_ERROR: ApiError = {
  kind: 'message',
  message: 'Timeline not found.',
  errorCode: 'TRIP_NOT_FOUND',
  status: 404,
};

export function useTimeline(
  tripId: string | undefined,
  { autoReconcile = true }: UseTimelineOptions = {},
) {
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [status, setStatus] = useState<TimelineLoadStatus>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stateTripId, setStateTripId] = useState<string | undefined>(tripId);
  const [timelineTripId, setTimelineTripId] = useState<string | undefined>();
  const snapshotRef = useRef<TimelineSnapshot | null>(null);
  const requestIdRef = useRef(0);
  const activeTripIdRef = useRef(tripId);

  useEffect(() => {
    activeTripIdRef.current = tripId;
    requestIdRef.current += 1;
  }, [tripId]);

  const isCurrentRequest = useCallback((requestId: number, resourceKey: string) => {
    return (
      requestId === requestIdRef.current &&
      resourceKey === activeTripIdRef.current
    );
  }, []);

  const commitTimeline = useCallback(
    (resourceKey: string, nextTimeline: TimelineResponse) => {
      snapshotRef.current = { tripId: resourceKey, timeline: nextTimeline };
      setStateTripId(resourceKey);
      setTimelineTripId(resourceKey);
      setTimeline(nextTimeline);
      setError(null);
      setStatus('ready');
    },
    [],
  );

  const refresh = useCallback(
    async (mode: TimelineLoadMode = 'silent') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!tripId) {
        snapshotRef.current = null;
        setStateTripId(tripId);
        setTimelineTripId(undefined);
        setTimeline(null);
        setError(MISSING_TIMELINE_ERROR);
        setStatus('error');
        setRefreshing(false);
        return;
      }

      const resourceKey = tripId;
      const hasTimeline = snapshotRef.current?.tripId === resourceKey;
      setStateTripId(resourceKey);

      if (!hasTimeline) {
        snapshotRef.current = null;
        setTimelineTripId(undefined);
        setTimeline(null);
        setError(null);
        setStatus('loading');
        setRefreshing(false);
      } else if (mode === 'refresh') {
        setRefreshing(true);
      }

      try {
        const nextTimeline = await getTimeline(resourceKey);
        if (!isCurrentRequest(requestId, resourceKey)) {
          return;
        }
        commitTimeline(resourceKey, nextTimeline);
      } catch (caught) {
        if (!isCurrentRequest(requestId, resourceKey)) {
          return;
        }

        const nextError = normalizeApiError(caught);
        const hasCurrentTimeline = snapshotRef.current?.tripId === resourceKey;
        setStateTripId(resourceKey);

        if (nextError.status === 404 || !hasCurrentTimeline) {
          snapshotRef.current = null;
          setTimelineTripId(undefined);
          setTimeline(null);
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
    [commitTimeline, isCurrentRequest, tripId],
  );

  const invalidate = useCallback(() => {
    requestIdRef.current += 1;
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!autoReconcile || !tripId) {
      return undefined;
    }

    return subscribeToTimelineEvents(tripId, () => {
      void refresh('silent');
    });
  }, [autoReconcile, refresh, tripId]);

  const reconcileOnForeground = useCallback(() => {
    if (autoReconcile) {
      void refresh(snapshotRef.current?.tripId === tripId ? 'silent' : 'initial');
    }
  }, [autoReconcile, refresh, tripId]);

  useAppForegroundEffect(reconcileOnForeground);

  useFocusEffect(
    useCallback(() => {
      if (autoReconcile) {
        void refresh(snapshotRef.current?.tripId === tripId ? 'silent' : 'initial');
      }

      return () => {
        requestIdRef.current += 1;
      };
    }, [autoReconcile, refresh, tripId]),
  );

  const stateMatchesTrip = stateTripId === tripId;
  const visibleTimeline =
    stateMatchesTrip && timelineTripId === tripId ? timeline : null;

  return {
    timeline: visibleTimeline,
    status: stateMatchesTrip ? status : 'loading',
    error: stateMatchesTrip ? error : null,
    refreshing: stateMatchesTrip ? refreshing : false,
    refresh,
    invalidate,
  };
}
