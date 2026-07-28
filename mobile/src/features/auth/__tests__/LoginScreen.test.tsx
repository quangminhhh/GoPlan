jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useRouter: () => mockRouter,
    // Renders its children so link copy is assertable; href routing is Expo Router's.
    Link: ({ children }: { children: import('react').ReactNode }) => React.createElement(Text, null, children),
  };
});
jest.mock('../api', () => ({
  loginRequest: jest.fn(),
}));
const mockSignIn = jest.fn();
jest.mock('../session', () => ({
  useSession: () => ({ status: 'signedOut', user: null, signIn: mockSignIn }),
}));

// eslint-disable-next-line import/first
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import { loginRequest } from '../api';
// eslint-disable-next-line import/first
import { LoginScreen } from '../screens/LoginScreen';

const mockLogin = loginRequest as jest.MockedFunction<typeof loginRequest>;

describe('LoginScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('submits trimmed credentials and signs in', async () => {
    const auth = { user: { requires_profile_setup: false }, tokens: {} };
    mockLogin.mockResolvedValue(auth as never);

    await render(<LoginScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), ' owner@goplan.dev ');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
    await fireEvent.press(screen.getByText('Sign in'));

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith(auth));
    expect(mockLogin).toHaveBeenCalledWith('owner@goplan.dev', 'secret123');
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });

  it('routes to verify-email on EMAIL_NOT_VERIFIED', async () => {
    const config = { headers: new AxiosHeaders() };
    mockLogin.mockRejectedValue(
      new AxiosError('forbidden', 'ERR_BAD_REQUEST', config, {}, {
        status: 403, statusText: '', headers: {}, config,
        data: { detail: 'Please verify your email address before signing in.', error_code: 'EMAIL_NOT_VERIFIED' },
      }),
    );

    await render(<LoginScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'owner@goplan.dev');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
    await fireEvent.press(screen.getByText('Sign in'));

    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/(auth)/verify-email',
        params: { email: 'owner@goplan.dev' },
      }),
    );
  });

  it('shows the backend message on bad credentials', async () => {
    const config = { headers: new AxiosHeaders() };
    mockLogin.mockRejectedValue(
      new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, {}, {
        status: 401, statusText: '', headers: {}, config,
        data: { detail: 'Invalid email or password.' },
      }),
    );

    await render(<LoginScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'owner@goplan.dev');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByText('Sign in'));

    expect(await screen.findByText('Invalid email or password.')).toBeTruthy();
  });

  it('offers a route to the forgot password screen', async () => {
    await render(<LoginScreen />);

    expect(screen.getByText('Forgot password?')).toBeTruthy();
  });
});
