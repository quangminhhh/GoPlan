const mockRouter = { replace: jest.fn(), back: jest.fn() };
const mockStackScreen = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: {
    Screen: ({ options }: { options: { gestureEnabled?: boolean } }) => {
      mockStackScreen(options);
      return null;
    },
  },
}));
jest.mock('../api', () => ({ requestPasswordResetRequest: jest.fn() }));

// eslint-disable-next-line import/first
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { axiosError } from '@test/axiosError';
// eslint-disable-next-line import/first
import { requestPasswordResetRequest } from '../api';
// eslint-disable-next-line import/first
import { ForgotPasswordScreen } from '../screens/ForgotPasswordScreen';

const mockRequest = requestPasswordResetRequest as jest.MockedFunction<typeof requestPasswordResetRequest>;
const NEUTRAL = 'If an account exists with that email, a password reset link has been sent.';

/**
 * Holds the request open so the in-flight UI can be observed. The press must
 * stay un-awaited until `release()` runs: React's act() awaits the promise the
 * async onPress returns, so awaiting a never-settling request hangs the test.
 */
function deferredRequest() {
  let release: () => void = () => undefined;
  mockRequest.mockImplementation(
    () => new Promise((resolve) => { release = () => resolve({ detail: NEUTRAL }); }),
  );
  return { release: () => release() };
}

describe('ForgotPasswordScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps submit disabled until an email is entered', async () => {
    await render(<ForgotPasswordScreen />);

    expect(screen.getByLabelText('Send reset link').props.accessibilityState.disabled).toBe(true);
  });

  it('sends the trimmed email and renders the neutral detail verbatim', async () => {
    mockRequest.mockResolvedValue({ detail: NEUTRAL });

    await render(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), '  a@b.com  ');
    await fireEvent.press(screen.getByLabelText('Send reset link'));

    await waitFor(() => expect(screen.getByText(NEUTRAL)).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith('a@b.com');
  });

  it('tells the user to finish in the emailed link and hides the form after success', async () => {
    mockRequest.mockResolvedValue({ detail: NEUTRAL });

    await render(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    await fireEvent.press(screen.getByLabelText('Send reset link'));

    await waitFor(() => expect(screen.getByText(/Open the link in that email/)).toBeTruthy());
    expect(screen.queryByLabelText('Send reset link')).toBeNull();
  });

  it('surfaces the 5/hour throttle as its own state', async () => {
    mockRequest.mockRejectedValue(axiosError(429, {}));

    await render(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    await fireEvent.press(screen.getByLabelText('Send reset link'));

    await waitFor(() =>
      expect(screen.getByText('Too many attempts. Please wait a moment and try again.')).toBeTruthy(),
    );
    expect(screen.getByLabelText('Send reset link')).toBeTruthy();
  });

  it('allows only one request across rapid duplicate submits', async () => {
    const { release } = deferredRequest();

    await render(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');

    // Both taps land inside one act scope, which is what a double tap before the
    // first re-render looks like: only the submit ref lock can reject the second.
    const submit = screen.getByLabelText('Send reset link');
    await act(async () => {
      void fireEvent.press(submit);
      void fireEvent.press(submit);
      release();
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('blocks explicit back and the native swipe gesture while submitting', async () => {
    const { release } = deferredRequest();

    await render(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    const pressed = fireEvent.press(screen.getByLabelText('Send reset link'));

    await waitFor(() =>
      expect(screen.getByLabelText('Back to sign in').props.accessibilityState.disabled).toBe(true),
    );
    expect(mockStackScreen).toHaveBeenCalledWith(
      expect.objectContaining({ gestureEnabled: false }),
    );

    release();
    await pressed;
  });

  it('returns to sign in', async () => {
    await render(<ForgotPasswordScreen />);

    await fireEvent.press(screen.getByLabelText('Back to sign in'));

    expect(mockRouter.replace).toHaveBeenCalledWith('/(auth)/login');
  });
});
