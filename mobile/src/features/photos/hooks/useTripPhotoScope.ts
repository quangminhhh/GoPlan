import { useLayoutEffect, useMemo, useState } from 'react';

export interface TripPhotoScopeTicket {
  readonly tripId: string;
  readonly generation: number;
}

interface MutableTripPhotoScopeTicket {
  tripId: string;
  generation: number;
}

export type TripPhotoScopeInvalidationListener = (
  previous: TripPhotoScopeTicket,
  current: TripPhotoScopeTicket,
) => void | Promise<void>;

export interface TripPhotoScope {
  /** Capture once, before the first prompt/request/await in an async entry point. */
  capture(): TripPhotoScopeTicket;
  /** Both the trip identity and its monotonic generation must still match. */
  isCurrent(ticket: TripPhotoScopeTicket): boolean;
  /**
   * Runs in the layout phase of a committed trip change. The listener must close
   * its old work synchronously and may return the asynchronous cleanup tail.
   */
  subscribeInvalidation(listener: TripPhotoScopeInvalidationListener): () => void;
  /**
   * Waits for every cleanup tail published so far. Callers must re-check their
   * captured ticket afterwards because another trip can win while this awaits.
   */
  waitForCleanup(): Promise<void>;
}

/**
 * The screen owner can additionally close the current trip after authoritative
 * membership/deletion evidence. Consumers only need the read-only scope above.
 */
export interface TripPhotoScopeController extends TripPhotoScope {
  /**
   * Fails the current trip closed immediately and notifies every work owner.
   * The same trip id cannot reopen the scope; only observing a different trip
   * creates a new usable generation.
   */
  invalidateCurrentTrip(): void;
}

function sameTicket(left: TripPhotoScopeTicket, right: TripPhotoScopeTicket): boolean {
  return left.tripId === right.tripId && left.generation === right.generation;
}

class TripPhotoScopeOwner implements TripPhotoScopeController {
  private ticket: MutableTripPhotoScopeTicket;
  private terminalInvalidated = false;
  private readonly listeners = new Set<TripPhotoScopeInvalidationListener>();
  private cleanupTail: Promise<void> = Promise.resolve();
  private cleanupRevision = 0;

  constructor(tripId: string) {
    this.ticket = { tripId, generation: 0 };
  }

  capture(): TripPhotoScopeTicket {
    return this.ticket;
  }

  isCurrent(ticket: TripPhotoScopeTicket): boolean {
    return !this.terminalInvalidated && sameTicket(ticket, this.ticket);
  }

  subscribeInvalidation(listener: TripPhotoScopeInvalidationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async waitForCleanup(): Promise<void> {
    let observedRevision = -1;
    while (observedRevision !== this.cleanupRevision) {
      observedRevision = this.cleanupRevision;
      await this.cleanupTail;
    }
  }

  /** Pure preview used by a render-bound facade before its trip commits. */
  previewTrip(tripId: string): MutableTripPhotoScopeTicket {
    if (this.ticket.tripId === tripId) {
      return this.ticket;
    }
    return {
      tripId,
      generation: this.ticket.generation + 1,
    };
  }

  /** Publishes only from the layout phase, so abandoned renders are inert. */
  commitTrip(
    tripId: string,
    preview: MutableTripPhotoScopeTicket,
  ): void {
    if (this.ticket.tripId === tripId) {
      return;
    }

    const previous = this.ticket;
    // An authoritative invalidation can land after render but before this
    // layout effect. Update the render's preview in place before consumers'
    // later layout effects run; tickets they captured from this facade then
    // observe the actual monotonic generation committed by the owner.
    preview.generation = previous.generation + 1;
    this.ticket = preview;
    this.terminalInvalidated = false;
    this.publishInvalidation(previous, preview);
  }

  invalidateCurrentTrip(): void {
    if (this.terminalInvalidated) {
      return;
    }

    const previous = this.ticket;
    const terminal = {
      tripId: previous.tripId,
      generation: previous.generation + 1,
    };
    // Move the gate before notifying subscribers. A listener that synchronously
    // probes the scope therefore already sees a closed trip and cannot schedule
    // another request while sibling listeners are still being called.
    this.ticket = terminal;
    this.terminalInvalidated = true;
    this.publishInvalidation(previous, terminal);
  }

  private publishInvalidation(
    previous: TripPhotoScopeTicket,
    current: TripPhotoScopeTicket,
  ): void {
    const cleanups: Promise<void>[] = [];
    for (const listener of Array.from(this.listeners)) {
      try {
        const cleanup = listener(previous, current);
        if (cleanup) {
          cleanups.push(Promise.resolve(cleanup).catch(() => undefined));
        }
      } catch {
        // One owner must not prevent the other owners from receiving the same
        // synchronous invalidation boundary.
      }
    }
    if (cleanups.length > 0) {
      this.cleanupRevision += 1;
      const previousTail = this.cleanupTail;
      this.cleanupTail = Promise.allSettled([previousTail, ...cleanups]).then(
        () => undefined,
      );
    }
  }
}

/**
 * A render may describe a future trip without changing the committed owner.
 * Its preview becomes current in the hook's layout effect, before later layout
 * effects from photo consumers can start work for the newly committed screen.
 */
class RenderBoundTripPhotoScope implements TripPhotoScopeController {
  constructor(
    private readonly owner: TripPhotoScopeOwner,
    private readonly tripId: string,
    private readonly preview: MutableTripPhotoScopeTicket,
  ) {}

  commit(): void {
    this.owner.commitTrip(this.tripId, this.preview);
  }

  capture(): TripPhotoScopeTicket {
    const committed = this.owner.capture();
    // A future render sees its preview until commit. A controller retained from
    // an older committed render continues exposing the owner's latest ticket,
    // preserving the public read contract without letting it mutate that trip.
    return committed.generation < this.preview.generation ? this.preview : committed;
  }

  isCurrent(ticket: TripPhotoScopeTicket): boolean {
    return this.owner.isCurrent(ticket);
  }

  subscribeInvalidation(listener: TripPhotoScopeInvalidationListener): () => void {
    return this.owner.subscribeInvalidation(listener);
  }

  waitForCleanup(): Promise<void> {
    return this.owner.waitForCleanup();
  }

  invalidateCurrentTrip(): void {
    if (sameTicket(this.owner.capture(), this.preview)) {
      this.owner.invalidateCurrentTrip();
    }
  }
}

/**
 * One stable committed owner shared by every photo hook mounted for a screen.
 *
 * Render receives a pure trip-bound preview. The stable owner changes only in a
 * layout effect, so React 19 can abandon or replay a render without invalidating
 * the currently committed trip. The scope layout effect is registered before
 * consumer effects and publishes the transition before new work can start.
 */
export function useTripPhotoScope(tripId: string): TripPhotoScopeController {
  const [owner] = useState(() => new TripPhotoScopeOwner(tripId));
  const scope = useMemo(
    () => new RenderBoundTripPhotoScope(owner, tripId, owner.previewTrip(tripId)),
    [owner, tripId],
  );

  useLayoutEffect(() => {
    scope.commit();
  }, [scope]);

  return scope;
}
