const mockRouter = { back: jest.fn(), replace: jest.fn(), push: jest.fn() };
const mockStackScreen = jest.fn();
jest.mock('expo-router', () => {
  function MockStackScreen({ options }: { options: { gestureEnabled?: boolean } }) {
    mockStackScreen(options);
    return null;
  }
  return { useRouter: () => mockRouter, Stack: { Screen: MockStackScreen } };
});

const mockUpdateUser = jest.fn();
jest.mock('../session', () => ({
  useSession: () => ({
    user: { id: 'u1', first_name: 'Quang', last_name: 'Minh', display_name: 'Quang Minh' },
    updateUser: mockUpdateUser,
  }),
}));
jest.mock('../api', () => ({ updateProfileNameRequest: jest.fn() }));

// eslint-disable-next-line import/first
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { axiosError } from '@test/axiosError';
// eslint-disable-next-line import/first
import { updateProfileNameRequest } from '../api';
// eslint-disable-next-line import/first
import { EditNameScreen } from '../screens/EditNameScreen';

const mockUpdate = updateProfileNameRequest as jest.MockedFunction<typeof updateProfileNameRequest>;

describe('EditNameScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('prefills from the session user and blocks submit until something changes', async () => {
    await render(<EditNameScreen />);

    expect(screen.getByLabelText('First name').props.value).toBe('Quang');
    expect(screen.getByLabelText('Last name').props.value).toBe('Minh');
    expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
  });

  it('submits both names and replaces the session user', async () => {
    const updated = { id: 'u1', first_name: 'Minh', last_name: 'Duong' };
    mockUpdate.mockResolvedValue(updated as never);

    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Minh');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Duong');
    await fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledWith(updated));
    expect(mockUpdate).toHaveBeenCalledWith({ first_name: 'Minh', last_name: 'Duong' });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('blocks the request on a client-side validation failure', async () => {
    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Quang Minh');
    await fireEvent.press(screen.getByLabelText('Save'));

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('First name must be a single word (no spaces).')).toBeTruthy();
  });

  it('places INVALID_LAST_NAME on the last name input', async () => {
    mockUpdate.mockRejectedValue(
      axiosError(400, { detail: 'Last name contains invalid characters.', error_code: 'INVALID_LAST_NAME' }),
    );

    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Duong');
    await fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() => expect(screen.getByText('Last name contains invalid characters.')).toBeTruthy());
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('routes PROFILE_SETUP_REQUIRED to profile setup instead of showing a raw error', async () => {
    mockUpdate.mockRejectedValue(
      axiosError(409, { detail: 'Profile setup is required.', error_code: 'PROFILE_SETUP_REQUIRED' }),
    );

    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Minh');
    await fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(auth)/profile-setup'));
    expect(screen.queryByText('Profile setup is required.')).toBeNull();
  });

  it('surfaces a throttled response as its own state', async () => {
    mockUpdate.mockRejectedValue(axiosError(429, {}));

    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Minh');
    await fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() =>
      expect(screen.getByText('Too many attempts. Please wait a moment and try again.')).toBeTruthy(),
    );
  });

  it('blocks the swipe-to-dismiss gesture while the request is in flight', async () => {
    // The press must stay un-awaited until the request settles: React's act()
    // awaits the promise the async onPress returns, so awaiting a request that
    // never resolves would hang the test rather than observe the in-flight state.
    let release: () => void = () => undefined;
    mockUpdate.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({} as never); }),
    );

    await render(<EditNameScreen />);
    await fireEvent.changeText(screen.getByLabelText('First name'), 'Minh');
    const pressed = fireEvent.press(screen.getByLabelText('Save'));

    await waitFor(() => expect(mockStackScreen).toHaveBeenCalledWith(expect.objectContaining({ gestureEnabled: false })));

    release();
    await pressed;
  });
});
