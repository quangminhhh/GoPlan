export type TimelineEvent = {
  type: 'timelineChanged';
  tripId: string;
};

type TimelineEventListener = (event: TimelineEvent) => void;

const listenersByTripId = new Map<string, Set<TimelineEventListener>>();

export function publishTimelineEvent(event: TimelineEvent): void {
  const listeners = listenersByTripId.get(event.tripId);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeToTimelineEvents(
  tripId: string,
  listener: TimelineEventListener,
): () => void {
  let listeners = listenersByTripId.get(tripId);
  if (!listeners) {
    listeners = new Set();
    listenersByTripId.set(tripId, listeners);
  }
  listeners.add(listener);

  return () => {
    const currentListeners = listenersByTripId.get(tripId);
    if (!currentListeners) {
      return;
    }
    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      listenersByTripId.delete(tripId);
    }
  };
}
