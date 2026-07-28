const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const mockSignOut = jest.fn();
const mockUseSession = jest.fn();
jest.mock('../session', () => ({ useSession: () => mockUseSession() }));

// Widened explicitly: the tests reassign `status` and `error`, which a bare
// object literal would have narrowed to 'idle' and null.
const mockAvatarUpdate: {
  status: 'idle' | 'picking' | 'uploading' | 'removing';
  error: string | null;
  changeAvatar: jest.Mock;
  removeAvatar: jest.Mock;
  dismissError: jest.Mock;
} = { status: 'idle', error: null, changeAvatar: jest.fn(), removeAvatar: jest.fn(), dismissError: jest.fn() };
jest.mock('../hooks/useAvatarUpdate', () => ({ useAvatarUpdate: () => mockAvatarUpdate }));

// eslint-disable-next-line import/first
import { Alert } from 'react-native';
// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ProfileScreen } from '../screens/ProfileScreen';

const user = {
  id: 'u1',
  email: 'a@b.com',
  display_name: 'Quang Minh',
  identify_tag: 'quangminh#1234',
  avatar_url: '/media/avatars/u1.webp',
};

describe('ProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAvatarUpdate.status = 'idle';
    mockAvatarUpdate.error = null;
    mockUseSession.mockReturnValue({ user, signOut: mockSignOut });
  });

  it('shows the identity block with a read-only identify tag', async () => {
    await render(<ProfileScreen />);

    expect(screen.getByText('Quang Minh')).toBeTruthy();
    expect(screen.getByText('a@b.com')).toBeTruthy();
    expect(screen.getByText('quangminh#1234')).toBeTruthy();
    expect(screen.queryByLabelText('Edit identify tag')).toBeNull();
  });

  it('starts the avatar picker from Change photo', async () => {
    await render(<ProfileScreen />);

    await fireEvent.press(screen.getByLabelText('Change photo'));

    expect(mockAvatarUpdate.changeAvatar).toHaveBeenCalledTimes(1);
  });

  it('hides Remove photo when the user has no avatar', async () => {
    mockUseSession.mockReturnValue({ user: { ...user, avatar_url: null }, signOut: mockSignOut });

    await render(<ProfileScreen />);

    expect(screen.queryByLabelText('Remove photo')).toBeNull();
  });

  it('confirms before removing the avatar', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    await render(<ProfileScreen />);
    await fireEvent.press(screen.getByLabelText('Remove photo'));

    expect(mockAvatarUpdate.removeAvatar).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2];
    const destructive = buttons?.find((button) => button.style === 'destructive');
    expect(destructive?.text).toBe('Remove');
    destructive?.onPress?.();
    expect(mockAvatarUpdate.removeAvatar).toHaveBeenCalledTimes(1);
  });

  it('renders the avatar error state', async () => {
    mockAvatarUpdate.error = 'Avatar file exceeds 500KB limit.';

    await render(<ProfileScreen />);

    expect(screen.getByText('Avatar file exceeds 500KB limit.')).toBeTruthy();
  });

  it('disables both avatar controls while an upload is in flight', async () => {
    mockAvatarUpdate.status = 'uploading';

    await render(<ProfileScreen />);

    // The active control announces its progress; the other keeps its idle label.
    expect(screen.getByLabelText('Uploading…').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText('Remove photo').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByLabelText('Change photo')).toBeNull();
  });

  it('disables both avatar controls while a removal is in flight', async () => {
    mockAvatarUpdate.status = 'removing';

    await render(<ProfileScreen />);

    expect(screen.getByLabelText('Removing…').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText('Change photo').props.accessibilityState.disabled).toBe(true);
  });

  it('navigates to the account sub-screens', async () => {
    await render(<ProfileScreen />);

    await fireEvent.press(screen.getByLabelText('Edit name'));
    expect(mockRouter.push).toHaveBeenCalledWith('/account/name');

    await fireEvent.press(screen.getByLabelText('Change password'));
    expect(mockRouter.push).toHaveBeenCalledWith('/account/password');
  });

  it('signs the user out', async () => {
    await render(<ProfileScreen />);

    await fireEvent.press(screen.getByLabelText('Log out'));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
