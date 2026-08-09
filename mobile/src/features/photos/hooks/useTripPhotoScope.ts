import { useLayoutEffect, useState } from 'react';

export interface TripPhotoScopeTicket {
  readonly tripId: string;
  readonly generation: number;
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
  private ticket: TripPhotoScopeTicket;
  private committedTicket: TripPhotoScopeTicket;
  private terminalInvalidated = false;
  private readonly listeners = new Set<TripPhotoScopeInvalidationListener>();
  private cleanupTail: Promise<void> = Promise.resolve();
  private cleanupRevision = 0;

  constructor(tripId: string) {
    this.ticket = { tripId, generation: 0 };
    this.committedTicket = this.ticket;
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

  /** Called during render so old closures fail before any new effect can run. */
  observeTrip(tripId: string): void {
    if (this.ticket.tripId === tripId) {
      return;
    }
    this.ticket = {
      tripId,
      generation: this.ticket.generation + 1,
    };
    this.terminalInvalidated = false;
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
    this.committedTicket = terminal;
    this.terminalInvalidated = true;
    this.publishInvalidation(previous, terminal);
  }

  /** Called from the hook's layout effect, so abandoned renders never publish. */
  publishCommittedInvalidation(): void {
    const current = this.ticket;
    if (sameTicket(this.committedTicket, current)) {
      return;
    }

    const previous = this.committedTicket;
    this.committedTicket = current;
    this.publishInvalidation(previous, current);
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
 * One stable owner shared by every photo hook mounted for a trip screen.
 *
 * The ticket changes during render as soon as a different `tripId` is observed,
 * so callbacks retained by Trip A fail `isCurrent()` even before effects for
 * Trip B run. Subscribers are notified only for the committed transition, in a
 * layout effect, before the user can interact with the new screen.
 */
export function useTripPhotoScope(tripId: string): TripPhotoScopeController {
  const [owner] = useState(() => new TripPhotoScopeOwner(tripId));
  owner.observeTrip(tripId);

  useLayoutEffect(() => {
    owner.publishCommittedInvalidation();
  }, [owner, tripId]);

  return owner;
}
