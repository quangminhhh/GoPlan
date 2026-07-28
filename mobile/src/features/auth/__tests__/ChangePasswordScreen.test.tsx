const mockRouter = { back: jest.fn(), replace: jest.fn() };
const mockStackScreen = jest.fn();
jest.mock('expo-router', () => {
  function MockStackScreen({ options }: { options: { gestureEnabled?: boolean } }) {
    mockStackScreen(options);
    return null;
  }
  return { useRouter: () => mockRouter, Stack: { Screen: MockStackScreen } };
});

const mockRotateSession = jest.fn();
jest.mock('../session', () => ({ useSession: () => ({ rotateSession: mockRotateSession }) }));
jest.mock('../api', () => ({ changePasswordRequest: jest.fn() }));

// eslint-disable-next-line import/first
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { axiosError } from '@test/axiosError';
// eslint-disable-next-line import/first
import { changePasswordRequest } from '../api';
// eslint-disable-next-line import/first
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';

const mockChange = changePasswordRequest as jest.MockedFunction<typeof changePasswordRequest>;

const payload = {
  user: { id: 'u1' },
  tokens: { access: 'new-access', refresh: 'new-refresh', token_type: 'Bearer' },
};

async function fillForm(current: string, next: string, confirm: string) {
  await fireEvent.changeText(screen.getByLabelText('Current password'), current);
  await fireEvent.changeText(screen.getByLabelText('New password'), next);
  await fireEvent.changeText(screen.getByLabelText('Confirm new password'), confirm);
}

describe('ChangePasswordScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRotateSession.mockResolvedValue('rotated');
  });

  it('rejects a mismatched confirmation without contacting the server', async () => {
    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'new-secret-1', 'new-secret-2');
    await fireEvent.press(screen.getByLabelText('Change password'));

    expect(mockChange).not.toHaveBeenCalled();
    expect(screen.getByText('New passwords do not match.')).toBeTruthy();
  });

  it('adopts the rotated token pair and leaves the screen on success', async () => {
    mockChange.mockResolvedValue(payload as never);

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'new-secret-1', 'new-secret-1');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() => expect(mockRotateSession).toHaveBeenCalledWith(payload));
    expect(mockChange).toHaveBeenCalledWith({ current_password: 'old-secret', new_password: 'new-secret-1' });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('stays put when the rotation forces a sign-out, letting the stack guard redirect', async () => {
    mockChange.mockResolvedValue(payload as never);
    mockRotateSession.mockResolvedValue('signedOut');

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'new-secret-1', 'new-secret-1');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() => expect(mockRotateSession).toHaveBeenCalled());
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('places a wrong current password on its own input and rotates nothing', async () => {
    mockChange.mockRejectedValue(
      axiosError(400, { detail: 'Current password is incorrect.', error_code: 'INVALID_CURRENT_PASSWORD' }),
    );

    await render(<ChangePasswordScreen />);
    await fillForm('wrong', 'new-secret-1', 'new-secret-1');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() => expect(screen.getByText('Current password is incorrect.')).toBeTruthy());
    expect(mockRotateSession).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('places a weak new password on the new password input', async () => {
    mockChange.mockRejectedValue(
      axiosError(400, { detail: 'This password is too common.', error_code: 'WEAK_PASSWORD' }),
    );

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'password', 'password');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() => expect(screen.getByText('This password is too common.')).toBeTruthy());
  });

  it('handles the DRF field-keyed minimum-length rejection', async () => {
    mockChange.mockRejectedValue(
      axiosError(400, { new_password: ['Ensure this field has at least 8 characters.'] }),
    );

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'short', 'short');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() =>
      expect(screen.getByText('Ensure this field has at least 8 characters.')).toBeTruthy(),
    );
  });

  it('surfaces the 5/hour throttle as its own state', async () => {
    mockChange.mockRejectedValue(axiosError(429, {}));

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'new-secret-1', 'new-secret-1');
    await fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() =>
      expect(screen.getByText('Too many attempts. Please wait a moment and try again.')).toBeTruthy(),
    );
  });

  it('blocks the swipe-to-dismiss gesture while the request is in flight', async () => {
    // The press stays un-awaited until the request settles: React's act() awaits
    // the promise the async onPress returns, so awaiting a request that never
    // resolves would hang the test instead of observing the in-flight state.
    let release: () => void = () => undefined;
    mockChange.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(payload as never); }),
    );

    await render(<ChangePasswordScreen />);
    await fillForm('old-secret', 'new-secret-1', 'new-secret-1');
    const pressed = fireEvent.press(screen.getByLabelText('Change password'));

    await waitFor(() => expect(mockStackScreen).toHaveBeenCalledWith(expect.objectContaining({ gestureEnabled: false })));

    release();
    await pressed;
  });
});
