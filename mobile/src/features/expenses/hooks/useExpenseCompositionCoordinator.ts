import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { subscribeToTripEvents, type TripEvent } from '@/features/trips/tripEvents';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { subscribeToExpenseEvents } from '../expenseEvents';

export type ExpenseCompositionLoadMode = 'initial' | 'refresh' | 'silent';

interface UseExpenseCompositionCoordinatorOptions {
  tripId: string;
  refreshExpense: (mode: ExpenseCompositionLoadMode) => Promise<void>;
  refreshTrip: (mode: ExpenseCompositionLoadMode) => Promise<void>;
  enabled?: boolean;
}

function isTripEventForTrip(event: TripEvent, tripId: string): boolean {
  return event.type === 'updated'
    ? event.trip.id === tripId
    : event.tripId === tripId;
}

export function useExpenseCompositionCoordinator({
  tripId,
  refreshExpense,
  refreshTrip,
  enabled = true,
}: UseExpenseCompositionCoordinatorOptions) {
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const hasRequestedInitialRef = useRef(false);

  const refreshAll = useCallback(
    async (mode: ExpenseCompositionLoadMode) => {
      await Promise.all([refreshExpense(mode), refreshTrip(mode)]);
    },
    [refreshExpense, refreshTrip],
  );

  const requestReconcile = useCallback(
    (forceInitial = false) => {
      const mode =
        forceInitial || !hasRequestedInitialRef.current
          ? 'initial'
          : 'silent';
      hasRequestedInitialRef.current = true;
      return refreshAll(mode);
    },
    [refreshAll],
  );

  useFocusEffect(
    useCallback(() => {
      activeRef.current = true;
      generationRef.current += 1;
      if (enabled) {
        void requestReconcile();
      }

      return () => {
        activeRef.current = false;
        generationRef.current += 1;
      };
    }, [enabled, requestReconcile]),
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      activeRef.current = false;
      generationRef.current += 1;
    },
    [],
  );

  useAppForegroundEffect(
    useCallback(() => {
      if (enabled && activeRef.current) {
        void requestReconcile();
      }
    }, [enabled, requestReconcile]),
  );

  useEffect(
    () =>
      subscribeToExpenseEvents(tripId, () => {
        if (enabled && activeRef.current) {
          return requestReconcile();
        }
        return undefined;
      }),
    [enabled, requestReconcile, tripId],
  );

  useEffect(
    () =>
      subscribeToTripEvents((event) => {
        if (
          enabled &&
          activeRef.current &&
          isTripEventForTrip(event, tripId)
        ) {
          void requestReconcile();
        }
      }),
    [enabled, requestReconcile, tripId],
  );

  const isScreenActive = useCallback(
    () => mountedRef.current && activeRef.current,
    [],
  );

  const isActiveGeneration = useCallback((generation: number) => {
    return (
      mountedRef.current &&
      activeRef.current &&
      generationRef.current === generation
    );
  }, []);

  const getGeneration = useCallback(() => generationRef.current, []);

  return {
    refreshAll,
    requestReconcile,
    isScreenActive,
    isActiveGeneration,
    getGeneration,
  };
}
