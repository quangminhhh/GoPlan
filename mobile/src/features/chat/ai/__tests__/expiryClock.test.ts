import { createAIExpiryDeadlineClock } from '../expiryClock';

describe('shared AI draft expiry deadline clock', () => {
  it('keeps one scheduled deadline for all subscribers and clears it after the last unsubscribe', () => {
    let nowMs = 0;
    let nextHandle = 0;
    const activeHandles = new Map<number, () => void>();
    const scheduler = {
      set: jest.fn((callback: () => void) => {
        nextHandle += 1;
        activeHandles.set(nextHandle, callback);
        return nextHandle;
      }),
      clear: jest.fn((handle: unknown) => {
        if (typeof handle === 'number') {
          activeHandles.delete(handle);
        }
      }),
    };
    const clock = createAIExpiryDeadlineClock({
      now: () => nowMs,
      scheduler,
    });
    const first = clock.subscribe(120_000, jest.fn());
    expect(activeHandles.size).toBe(1);
    const second = clock.subscribe(180_000, jest.fn());
    expect(activeHandles.size).toBe(1);
    first();
    expect(activeHandles.size).toBe(1);
    second();
    expect(activeHandles.size).toBe(0);
    nowMs = 1;
  });

  it('notifies only at the next visible label boundary instead of every second', () => {
    let nowMs = 0;
    let callback: (() => void) | null = null;
    let delayMs: number | null = null;
    const listener = jest.fn();
    const clock = createAIExpiryDeadlineClock({
      now: () => nowMs,
      scheduler: {
        set: (next, delay) => {
          callback = next;
          delayMs = delay;
          return 1;
        },
        clear: () => {
          callback = null;
        },
      },
    });
    const unsubscribe = clock.subscribe(180_000, listener);
    expect(delayMs).toBe(60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    nowMs = 60_000;
    const scheduled = callback as (() => void) | null;
    scheduled?.();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('keeps a far-future deadline on a safe visible boundary instead of an immediate timer', () => {
    const set = jest.fn(() => 1);
    const clock = createAIExpiryDeadlineClock({
      now: () => 0,
      scheduler: { set, clear: jest.fn() },
    });
    const unsubscribe = clock.subscribe(8_640_000_000_000_000, jest.fn());
    expect(set).toHaveBeenCalledWith(expect.any(Function), 60_000);
    unsubscribe();
  });
});
