const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AIExpiryClockScheduler {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface AIExpiryDeadlineClock {
  readonly subscribe: (
    expiresAtMs: number,
    listener: (nowMs: number) => void,
  ) => () => void;
}

interface DeadlineSubscriber {
  readonly expiresAtMs: number;
  readonly listener: (nowMs: number) => void;
  nextUpdateAtMs: number;
}

function nextLabelUpdateAt(expiresAtMs: number, nowMs: number): number {
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) {
    return expiresAtMs - (seconds - 1) * 1_000;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1
    ? expiresAtMs - 59_000
    : expiresAtMs - (minutes - 1) * 60_000;
}

export function createAIExpiryDeadlineClock(options: {
  readonly now: () => number;
  readonly scheduler: AIExpiryClockScheduler;
}): AIExpiryDeadlineClock {
  const subscribers = new Set<DeadlineSubscriber>();
  let timeoutHandle: unknown = null;

  const cancelScheduledTick = (): void => {
    if (timeoutHandle !== null) {
      options.scheduler.clear(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const schedule = (): void => {
    cancelScheduledTick();
    if (subscribers.size === 0) {
      return;
    }
    const nextUpdateAtMs = [...subscribers].reduce(
      (earliest, subscriber) => Math.min(earliest, subscriber.nextUpdateAtMs),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nextUpdateAtMs)) {
      return;
    }
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, nextUpdateAtMs - options.now()),
    );
    timeoutHandle = options.scheduler.set(() => {
      timeoutHandle = null;
      const nowMs = options.now();
      for (const subscriber of [...subscribers]) {
        if (subscriber.nextUpdateAtMs <= nowMs) {
          subscriber.nextUpdateAtMs = nextLabelUpdateAt(
            subscriber.expiresAtMs,
            nowMs,
          );
          subscriber.listener(nowMs);
        }
      }
      schedule();
    }, delayMs);
  };

  return {
    subscribe: (expiresAtMs, listener) => {
      const nowMs = options.now();
      const subscriber: DeadlineSubscriber = {
        expiresAtMs,
        listener,
        nextUpdateAtMs: nextLabelUpdateAt(expiresAtMs, nowMs),
      };
      subscribers.add(subscriber);
      listener(nowMs);
      schedule();
      return () => {
        subscribers.delete(subscriber);
        schedule();
      };
    },
  };
}

export const sharedAIExpiryDeadlineClock = createAIExpiryDeadlineClock({
  now: () => Date.now(),
  scheduler: {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});
