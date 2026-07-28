export type ExpenseRouteParam = string | string[] | undefined;

export interface ExpensesRouteParams {
  tripId: ExpenseRouteParam;
}

export interface ExpenseDetailRouteParams extends ExpensesRouteParams {
  expenseId: ExpenseRouteParam;
}

export interface ExpenseFormRouteParams extends ExpensesRouteParams {
  mode: ExpenseRouteParam;
  expenseId: ExpenseRouteParam;
}

export interface ExpenseDashboardRouteIntent {
  tripId: string;
}

export interface ExpenseDetailRouteIntent {
  tripId: string;
  expenseId: string;
}

export type ExpenseFormRouteIntent =
  | { mode: 'create'; tripId: string }
  | { mode: 'edit'; tripId: string; expenseId: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: ExpenseRouteParam): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return null;
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function parseExpensesRouteIntent({
  tripId,
}: ExpensesRouteParams): ExpenseDashboardRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  return parsedTripId ? { tripId: parsedTripId } : null;
}

export const parseExpenseDashboardRouteIntent = parseExpensesRouteIntent;

export function parseExpenseDetailRouteIntent({
  tripId,
  expenseId,
}: ExpenseDetailRouteParams): ExpenseDetailRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  const parsedExpenseId = parseUuid(expenseId);
  return parsedTripId && parsedExpenseId
    ? { tripId: parsedTripId, expenseId: parsedExpenseId }
    : null;
}

export function parseExpenseFormRouteIntent({
  tripId,
  mode,
  expenseId,
}: ExpenseFormRouteParams): ExpenseFormRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  if (!parsedTripId || (mode !== 'create' && mode !== 'edit')) {
    return null;
  }

  if (mode === 'create') {
    return expenseId === undefined ? { mode, tripId: parsedTripId } : null;
  }

  const parsedExpenseId = parseUuid(expenseId);
  return parsedExpenseId
    ? { mode, tripId: parsedTripId, expenseId: parsedExpenseId }
    : null;
}
