import {
  publishTimelineEvent,
  subscribeToTimelineEvents,
  type TimelineEvent,
} from '../timelineEvents';

describe('timeline events', () => {
  it('publishes only to listeners keyed to the changed trip', async () => {
    const tripOneListener = jest.fn();
    const tripTwoListener = jest.fn();
    const unsubscribeTripOne = subscribeToTimelineEvents(
      'trip-1',
      tripOneListener,
    );
    const unsubscribeTripTwo = subscribeToTimelineEvents(
      'trip-2',
      tripTwoListener,
    );
    const event: TimelineEvent = {
      type: 'timelineChanged',
      tripId: 'trip-1',
    };

    await publishTimelineEvent(event);

    expect(tripOneListener).toHaveBeenCalledTimes(1);
    expect(tripOneListener).toHaveBeenCalledWith(event);
    expect(tripTwoListener).not.toHaveBeenCalled();

    unsubscribeTripOne();
    unsubscribeTripTwo();
  });

  it('notifies every listener for one trip and stops after unsubscribe', async () => {
    const firstListener = jest.fn();
    const secondListener = jest.fn();
    const unsubscribeFirst = subscribeToTimelineEvents(
      'trip-1',
      firstListener,
    );
    const unsubscribeSecond = subscribeToTimelineEvents(
      'trip-1',
      secondListener,
    );
    const event: TimelineEvent = {
      type: 'timelineChanged',
      tripId: 'trip-1',
    };

    await publishTimelineEvent(event);
    unsubscribeFirst();
    await publishTimelineEvent(event);
    unsubscribeFirst();
    unsubscribeSecond();
    await publishTimelineEvent(event);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(2);
  });

  it('waits for asynchronous listeners before resolving', async () => {
    let resolveListener: () => void = () => undefined;
    const listener = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveListener = resolve;
        }),
    );
    const unsubscribe = subscribeToTimelineEvents('trip-1', listener);
    let settled = false;

    const published = publishTimelineEvent({
      type: 'timelineChanged',
      tripId: 'trip-1',
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveListener();
    await published;
    expect(settled).toBe(true);
    unsubscribe();
  });
});
