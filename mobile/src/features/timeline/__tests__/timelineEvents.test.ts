import {
  publishTimelineEvent,
  subscribeToTimelineEvents,
  type TimelineEvent,
} from '../timelineEvents';

describe('timeline events', () => {
  it('publishes only to listeners keyed to the changed trip', () => {
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

    publishTimelineEvent(event);

    expect(tripOneListener).toHaveBeenCalledTimes(1);
    expect(tripOneListener).toHaveBeenCalledWith(event);
    expect(tripTwoListener).not.toHaveBeenCalled();

    unsubscribeTripOne();
    unsubscribeTripTwo();
  });

  it('notifies every listener for one trip and stops after unsubscribe', () => {
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

    publishTimelineEvent(event);
    unsubscribeFirst();
    publishTimelineEvent(event);
    unsubscribeFirst();
    unsubscribeSecond();
    publishTimelineEvent(event);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(2);
  });
});
