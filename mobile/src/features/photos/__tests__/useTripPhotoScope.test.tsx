import { act, renderHook } from '@testing-library/react-native';
import { createDeferred } from '@test/fakeProtectedTransport';
import { useTripPhotoScope } from '../hooks/useTripPhotoScope';

describe('useTripPhotoScope', () => {
  it('keeps one owner and invalidates the old ticket when a new trip is observed', async () => {
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    const owner = rendered.result.current;
    const tripA = owner.capture();

    await rendered.rerender({ tripId: 'trip-b' });

    const tripB = rendered.result.current.capture();
    expect(rendered.result.current).toBe(owner);
    expect(tripB).toEqual({ tripId: 'trip-b', generation: tripA.generation + 1 });
    expect(owner.isCurrent(tripA)).toBe(false);
    expect(owner.isCurrent(tripB)).toBe(true);
  });

  it('publishes the committed transition to subscribers', async () => {
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    const listener = jest.fn();
    rendered.result.current.subscribeInvalidation(listener);

    await rendered.rerender({ tripId: 'trip-b' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { tripId: 'trip-a', generation: 0 },
      { tripId: 'trip-b', generation: 1 },
    );
  });

  it('makes new work wait for the prior trip cleanup tail', async () => {
    const cleanup = createDeferred<void>();
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    rendered.result.current.subscribeInvalidation(() => cleanup.promise);

    await rendered.rerender({ tripId: 'trip-b' });
    const tripB = rendered.result.current.capture();
    let settled = false;
    const waiting = rendered.result.current.waitForCleanup().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    await act(async () => {
      cleanup.resolve();
      await waiting;
    });
    expect(settled).toBe(true);
    expect(rendered.result.current.isCurrent(tripB)).toBe(true);
  });

  it('fails an authoritative terminal trip closed until a different trip reopens it', async () => {
    const cleanup = createDeferred<void>();
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    const owner = rendered.result.current;
    const activeTrip = owner.capture();
    let listenerSawClosedGate = false;
    const listener = jest.fn(() => {
      listenerSawClosedGate = !owner.isCurrent(owner.capture());
      return cleanup.promise;
    });
    owner.subscribeInvalidation(listener);

    owner.invalidateCurrentTrip();

    const terminalTicket = owner.capture();
    expect(listenerSawClosedGate).toBe(true);
    expect(listener).toHaveBeenCalledWith(activeTrip, terminalTicket);
    expect(terminalTicket.generation).toBe(activeTrip.generation + 1);
    expect(owner.isCurrent(activeTrip)).toBe(false);
    expect(owner.isCurrent(terminalTicket)).toBe(false);

    // Terminal invalidation is idempotent, and observing the same route identity
    // cannot accidentally turn its captured ticket back into usable work.
    owner.invalidateCurrentTrip();
    await rendered.rerender({ tripId: 'trip-a' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(owner.isCurrent(owner.capture())).toBe(false);

    let cleanupSettled = false;
    const waiting = owner.waitForCleanup().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    await act(async () => {
      cleanup.resolve();
      await waiting;
    });
    await rendered.rerender({ tripId: 'trip-b' });

    const tripB = owner.capture();
    expect(tripB).toEqual({
      tripId: 'trip-b',
      generation: terminalTicket.generation + 1,
    });
    expect(owner.isCurrent(tripB)).toBe(true);
  });

  it('does not let a stale callback become current after an await', async () => {
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    const capturedByTripA = rendered.result.current.capture();

    await rendered.rerender({ tripId: 'trip-b' });

    expect(rendered.result.current.isCurrent(capturedByTripA)).toBe(false);
  });

  it('unsubscribes an invalidation owner', async () => {
    const rendered = await renderHook(
      ({ tripId }: { tripId: string }) => useTripPhotoScope(tripId),
      { initialProps: { tripId: 'trip-a' } },
    );
    const listener = jest.fn();
    const unsubscribe = rendered.result.current.subscribeInvalidation(listener);
    unsubscribe();

    await rendered.rerender({ tripId: 'trip-b' });

    expect(listener).not.toHaveBeenCalled();
  });
});
