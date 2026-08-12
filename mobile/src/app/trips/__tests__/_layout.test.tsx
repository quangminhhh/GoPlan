const mockRouter = { canGoBack: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockUseSession = jest.fn();
const mockRegisterScreen = jest.fn();

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

  function MockStack({ children }: { children: import('react').ReactNode }) {
    return React.createElement(View, null, children);
  }

  MockStack.Screen = function MockStackScreen({
    name,
    options,
  }: {
    name: string;
    options: {
      title: string;
      presentation?: string;
      headerLeft?: () => import('react').ReactNode;
    };
  }) {
    mockRegisterScreen(name, options);
    return React.createElement(View, { testID: `screen-${name}` }, options.headerLeft?.());
  };

  return {
    Redirect: ({ href }: { href: string }) => React.createElement(View, { testID: `redirect-${href}` }),
    Stack: MockStack,
    useRouter: () => mockRouter,
  };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/features/auth/session', () => ({ useSession: () => mockUseSession() }));
jest.mock('@/shared/ui/LoadingScreen', () => ({ LoadingScreen: () => null }));

// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import TripsLayout from '../_layout';

describe('TripsLayout header actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSession.mockReturnValue({ status: 'signedIn', user: { requires_profile_setup: false } });
  });

  it('registers the edit route as an Edit Trip modal with a cancel action', async () => {
    await render(<TripsLayout />);
    expect(screen.getByTestId('screen-[tripId]/edit')).toBeTruthy();
    expect(screen.getByLabelText('Cancel trip editing')).toBeTruthy();
    expect(screen.getByTestId('screen-[tripId]/invite')).toBeTruthy();
    expect(screen.getByLabelText('Cancel member invitation')).toBeTruthy();
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/invite',
      expect.objectContaining({ title: 'Invite Friends', presentation: 'formSheet' }),
    );
  });

  it('registers Timeline as a push route and its management routes as form sheets', async () => {
    await render(<TripsLayout />);

    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/timeline/index',
      expect.objectContaining({ title: 'Timeline' }),
    );
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/timeline/section-form',
      expect.objectContaining({ title: 'Timeline Day', presentation: 'formSheet' }),
    );
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/timeline/activity-form',
      expect.objectContaining({ title: 'Activity', presentation: 'formSheet' }),
    );
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/timeline/custom-types',
      expect.objectContaining({ title: 'Custom Types', presentation: 'formSheet' }),
    );
    expect(screen.getByLabelText('Cancel timeline day form')).toBeTruthy();
    expect(screen.getByLabelText('Cancel timeline activity form')).toBeTruthy();
    expect(screen.getByLabelText('Close custom types')).toBeTruthy();
  });

  it('registers Chat as a push route in the Trips stack', async () => {
    await render(<TripsLayout />);

    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/chat/index',
      expect.objectContaining({ title: 'Chat' }),
    );
  });

  it('registers Expenses dashboard and detail as push routes and its form as a sheet', async () => {
    await render(<TripsLayout />);

    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/expenses/index',
      expect.objectContaining({ title: 'Expenses' }),
    );
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/expenses/[expenseId]',
      expect.objectContaining({ title: 'Expense' }),
    );
    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/expenses/expense-form',
      expect.objectContaining({ title: 'Expense', presentation: 'formSheet' }),
    );
    expect(screen.getByLabelText('Cancel expense form')).toBeTruthy();
  });

  it('registers Photos as a push route', async () => {
    await render(<TripsLayout />);

    expect(mockRegisterScreen).toHaveBeenCalledWith(
      '[tripId]/photos/index',
      expect.objectContaining({ title: 'Photos' }),
    );
  });

  it('returns to the previous route from the trip detail header when history exists', async () => {
    mockRouter.canGoBack.mockReturnValue(true);
    await render(<TripsLayout />);
    await fireEvent.press(screen.getByLabelText('Back to Trips'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['Cancel trip creation'],
    ['Cancel trip editing'],
    ['Cancel member invitation'],
    ['Cancel timeline day form'],
    ['Cancel timeline activity form'],
    ['Close custom types'],
    ['Cancel expense form'],
  ])('returns to tabs from %s when there is no navigation history', async (label) => {
    mockRouter.canGoBack.mockReturnValue(false);
    await render(<TripsLayout />);
    await fireEvent.press(screen.getByLabelText(label));
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)');
  });
});
