let mockParams: Record<string, string | string[] | undefined> = {};
const mockUseExpenseDashboard = jest.fn();
const mockUseExpenseDetail = jest.fn();
const mockUseTripDetail = jest.fn();
const mockUseExpenseCompositionCoordinator = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: jest.fn(),
    dismissTo: jest.fn(),
  }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../hooks/useExpenseDashboard', () => ({
  useExpenseDashboard: (...args: unknown[]) =>
    mockUseExpenseDashboard(...args),
}));
jest.mock('../hooks/useExpenseDetail', () => ({
  useExpenseDetail: (...args: unknown[]) => mockUseExpenseDetail(...args),
}));
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));
jest.mock('../hooks/useExpenseCompositionCoordinator', () => ({
  useExpenseCompositionCoordinator: (...args: unknown[]) =>
    mockUseExpenseCompositionCoordinator(...args),
}));

// eslint-disable-next-line import/first
import { render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import ExpensesRoute from '@/app/trips/[tripId]/expenses/index';
// eslint-disable-next-line import/first
import ExpenseDetailRoute from '@/app/trips/[tripId]/expenses/[expenseId]';
// eslint-disable-next-line import/first
import ExpenseFormRoute from '@/app/trips/[tripId]/expenses/expense-form';
// eslint-disable-next-line import/first
import { ExpensesScreen } from '../screens/ExpensesScreen';
// eslint-disable-next-line import/first
import { ExpenseDetailScreen } from '../screens/ExpenseDetailScreen';
// eslint-disable-next-line import/first
import { ExpenseFormScreen } from '../screens/ExpenseFormScreen';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPENSE_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';

describe('Expenses route screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
  });

  it('keeps every Expo Router file a thin default re-export', () => {
    expect(ExpensesRoute).toBe(ExpensesScreen);
    expect(ExpenseDetailRoute).toBe(ExpenseDetailScreen);
    expect(ExpenseFormRoute).toBe(ExpenseFormScreen);
  });

  it('guards invalid dashboard intent before any aggregate hook', async () => {
    mockParams = { tripId: [TRIP_ID] };
    await render(<ExpensesRoute />);

    expect(screen.getByText('Expenses unavailable')).toBeTruthy();
    expect(mockUseExpenseDashboard).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockUseExpenseCompositionCoordinator).not.toHaveBeenCalled();
  });

  it('guards invalid detail intent before any aggregate hook', async () => {
    mockParams = {
      tripId: TRIP_ID,
      expenseId: [EXPENSE_ID],
    };
    await render(<ExpenseDetailRoute />);

    expect(screen.getByText('Expense unavailable')).toBeTruthy();
    expect(mockUseExpenseDetail).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockUseExpenseCompositionCoordinator).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'create with an expense id',
      params: {
        tripId: TRIP_ID,
        mode: 'create',
        expenseId: EXPENSE_ID,
      },
    },
    {
      name: 'edit without an expense id',
      params: {
        tripId: TRIP_ID,
        mode: 'edit',
      },
    },
    {
      name: 'unknown mode',
      params: {
        tripId: TRIP_ID,
        mode: 'duplicate',
      },
    },
  ])('guards contradictory form intent: $name', async ({ params }) => {
    mockParams = params;
    await render(<ExpenseFormRoute />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(mockUseExpenseDashboard).not.toHaveBeenCalled();
    expect(mockUseExpenseDetail).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
  });
});
