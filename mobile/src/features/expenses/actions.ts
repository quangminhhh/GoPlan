import type { TripStatus } from '@/features/trips/types';
import type { TripSettlement } from './types';

export interface ExpenseDashboardActionInput {
  canManageExpenses: boolean;
  tripStatus: TripStatus;
  settlement: TripSettlement | null;
  expenseCount: number;
}

export interface ExpenseDashboardActions {
  canAddExpense: boolean;
  canFinalize: boolean;
  canReopen: boolean;
}

export interface ExpenseItemActionInput {
  canManageExpenses: boolean;
  tripStatus: TripStatus;
  locked: boolean;
}

export interface ExpenseItemActions {
  canEditExpense: boolean;
  canEditContributions: boolean;
}

export function isTerminalTripStatus(tripStatus: TripStatus): boolean {
  return tripStatus === 'COMPLETED' || tripStatus === 'CANCELLED';
}

export function getExpenseDashboardActions({
  canManageExpenses,
  tripStatus,
  settlement,
  expenseCount,
}: ExpenseDashboardActionInput): ExpenseDashboardActions {
  const canMutate = canManageExpenses && !isTerminalTripStatus(tripStatus);
  const isFinalized = settlement?.status === 'FINALIZED';

  return {
    canAddExpense: canMutate && !isFinalized,
    canFinalize: canMutate && !isFinalized && expenseCount > 0,
    canReopen: canMutate && isFinalized,
  };
}

export function getExpenseItemActions({
  canManageExpenses,
  tripStatus,
  locked,
}: ExpenseItemActionInput): ExpenseItemActions {
  const canMutate =
    canManageExpenses && !isTerminalTripStatus(tripStatus) && !locked;

  return {
    canEditExpense: canMutate,
    canEditContributions: canMutate,
  };
}
