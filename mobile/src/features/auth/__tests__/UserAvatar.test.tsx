import { render, screen } from '@testing-library/react-native';
import { UserAvatar } from '../components/UserAvatar';

describe('UserAvatar', () => {
  it('falls back to initials when the user has no avatar', async () => {
    await render(<UserAvatar displayName="Quang Minh" avatarUrl={null} size={96} />);

    expect(screen.getByText('QM')).toBeTruthy();
  });

  it('renders the resolved image when an avatar exists', async () => {
    await render(<UserAvatar displayName="Quang Minh" avatarUrl="/media/avatars/u1.webp" size={96} />);

    expect(screen.queryByText('QM')).toBeNull();
    // expo-image normalises `source` into an array of sources before render.
    expect(screen.getByTestId('user-avatar-image').props.source).toEqual([
      { uri: 'http://testserver:8000/api/media/files/avatars/u1.webp' },
    ]);
  });

  it('carries an accessible label', async () => {
    await render(<UserAvatar displayName="Quang Minh" avatarUrl={null} size={96} />);

    expect(screen.getByLabelText('Your profile picture')).toBeTruthy();
  });
});
