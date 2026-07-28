import {
  parseExpenseDetailRouteIntent,
  parseExpenseFormRouteIntent,
  parseExpensesRouteIntent,
  type ExpenseFormRouteParams,
  type ExpenseRouteParam,
} from '../routeIntent';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPENSE_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';

const INVALID_UUID_PARAMS: ExpenseRouteParam[] = [
  undefined,
  '',
  '   ',
  ` ${TRIP_ID}`,
  `${TRIP_ID} `,
  'not-a-uuid',
  '123e4567e89b12d3a456426614174000',
  [TRIP_ID],
];

describe('parseExpensesRouteIntent', () => {
  it('accepts one UUID string and canonicalizes uppercase values', () => {
    expect(parseExpensesRouteIntent({ tripId: TRIP_ID })).toEqual({
      tripId: TRIP_ID,
    });
    expect(
      parseExpensesRouteIntent({ tripId: TRIP_ID.toUpperCase() }),
    ).toEqual({ tripId: TRIP_ID });
  });

  it.each(INVALID_UUID_PARAMS)('rejects invalid tripId %#', (tripId) => {
    expect(parseExpensesRouteIntent({ tripId })).toBeNull();
  });
});

describe('parseExpenseDetailRouteIntent', () => {
  it('requires exactly one valid trip and expense id', () => {
    expect(
      parseExpenseDetailRouteIntent({
        tripId: TRIP_ID.toUpperCase(),
        expenseId: EXPENSE_ID.toUpperCase(),
      }),
    ).toEqual({
      tripId: TRIP_ID,
      expenseId: EXPENSE_ID,
    });
  });

  it.each(INVALID_UUID_PARAMS)(
    'rejects invalid detail tripId %#',
    (tripId) => {
      expect(
        parseExpenseDetailRouteIntent({
          tripId,
          expenseId: EXPENSE_ID,
        }),
      ).toBeNull();
    },
  );

  it.each(INVALID_UUID_PARAMS)(
    'rejects invalid detail expenseId %#',
    (expenseId) => {
      expect(
        parseExpenseDetailRouteIntent({
          tripId: TRIP_ID,
          expenseId,
        }),
      ).toBeNull();
    },
  );
});

describe('parseExpenseFormRouteIntent', () => {
  const createParams: ExpenseFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'create',
    expenseId: undefined,
  };
  const editParams: ExpenseFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'edit',
    expenseId: EXPENSE_ID,
  };

  it('returns strict explicit create and edit discriminants', () => {
    expect(parseExpenseFormRouteIntent(createParams)).toEqual({
      mode: 'create',
      tripId: TRIP_ID,
    });
    expect(
      parseExpenseFormRouteIntent({
        ...editParams,
        tripId: TRIP_ID.toUpperCase(),
        expenseId: EXPENSE_ID.toUpperCase(),
      }),
    ).toEqual({
      mode: 'edit',
      tripId: TRIP_ID,
      expenseId: EXPENSE_ID,
    });
  });

  it.each(INVALID_UUID_PARAMS)('rejects invalid tripId %#', (tripId) => {
    expect(
      parseExpenseFormRouteIntent({ ...createParams, tripId }),
    ).toBeNull();
  });

  it.each([
    undefined,
    '',
    'CREATE',
    'unknown',
    ['create'],
  ] as ExpenseRouteParam[])(
    'rejects missing, blank, unknown, or array mode %#',
    (mode) => {
      expect(
        parseExpenseFormRouteIntent({ ...createParams, mode }),
      ).toBeNull();
    },
  );

  it.each(['', 'not-a-uuid', EXPENSE_ID, [EXPENSE_ID]] as ExpenseRouteParam[])(
    'rejects create with any expenseId %#',
    (expenseId) => {
      expect(
        parseExpenseFormRouteIntent({
          ...createParams,
          expenseId,
        }),
      ).toBeNull();
    },
  );

  it.each(INVALID_UUID_PARAMS)(
    'rejects edit without exactly one valid expenseId %#',
    (expenseId) => {
      expect(
        parseExpenseFormRouteIntent({
          ...editParams,
          expenseId,
        }),
      ).toBeNull();
    },
  );
});
