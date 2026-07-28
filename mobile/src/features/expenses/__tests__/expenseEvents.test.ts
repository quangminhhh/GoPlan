import {
  publishExpenseEvent,
  subscribeToExpenseEvents,
  type ExpenseEvent,
} from '../expenseEvents';

describe('expense events', () => {
  it('publishes only to listeners keyed to the changed trip', async () => {
    const tripOneListener = jest.fn();
    const tripTwoListener = jest.fn();
    const unsubscribeTripOne = subscribeToExpenseEvents(
      'trip-1',
      tripOneListener,
    );
    const unsubscribeTripTwo = subscribeToExpenseEvents(
      'trip-2',
      tripTwoListener,
    );
    const event: ExpenseEvent = {
      type: 'expensesChanged',
      tripId: 'trip-1',
    };

    await publishExpenseEvent(event);

    expect(tripOneListener).toHaveBeenCalledTimes(1);
    expect(tripOneListener).toHaveBeenCalledWith(event);
    expect(tripTwoListener).not.toHaveBeenCalled();

    unsubscribeTripOne();
    unsubscribeTripTwo();
  });

  it('notifies every listener and stops after unsubscribe', async () => {
    const firstListener = jest.fn();
    const secondListener = jest.fn();
    const unsubscribeFirst = subscribeToExpenseEvents(
      'trip-1',
      firstListener,
    );
    const unsubscribeSecond = subscribeToExpenseEvents(
      'trip-1',
      secondListener,
    );
    const event: ExpenseEvent = {
      type: 'expensesChanged',
      tripId: 'trip-1',
    };

    await publishExpenseEvent(event);
    unsubscribeFirst();
    await publishExpenseEvent(event);
    unsubscribeFirst();
    unsubscribeSecond();
    await publishExpenseEvent(event);

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
    const unsubscribe = subscribeToExpenseEvents('trip-1', listener);
    let settled = false;

    const published = publishExpenseEvent({
      type: 'expensesChanged',
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
