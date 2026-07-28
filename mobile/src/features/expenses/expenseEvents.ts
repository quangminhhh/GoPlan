export type ExpenseEvent = {
  type: 'expensesChanged';
  tripId: string;
};

export type ExpenseEventListener = (
  event: ExpenseEvent,
) => void | Promise<void>;

const listenersByTripId = new Map<string, Set<ExpenseEventListener>>();

export async function publishExpenseEvent(event: ExpenseEvent): Promise<void> {
  const listeners = listenersByTripId.get(event.tripId);
  if (!listeners) {
    return;
  }

  await Promise.all(
    Array.from(listeners, (listener) => listener(event)),
  );
}

export function subscribeToExpenseEvents(
  tripId: string,
  listener: ExpenseEventListener,
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
