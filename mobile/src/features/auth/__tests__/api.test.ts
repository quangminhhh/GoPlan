 
import { apiClient } from '@/shared/api/client';
import {
  changePasswordRequest,
  deleteAvatarRequest,
  fetchMe,
  loginRequest,
  profileSetupRequest,
  requestPasswordResetRequest,
  updateProfileNameRequest,
  uploadAvatarRequest,
} from '../api';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('auth api', () => {
  afterEach(() => jest.restoreAllMocks());

  it('loginRequest posts credentials and returns the auth payload', async () => {
    const payload = { user: { id: 'u1' }, tokens: { access: 'a', refresh: 'r', token_type: 'Bearer' } };
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({ data: payload });
    await expect(loginRequest('a@b.com', 'secret')).resolves.toEqual(payload);
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'a@b.com', password: 'secret' });
  });

  it('fetchMe unwraps the user envelope', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({ data: { user: { id: 'u1' } } });
    await expect(fetchMe()).resolves.toEqual({ id: 'u1' });
  });

  it('profileSetupRequest unwraps the user envelope', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({ data: { user: { id: 'u1' } } });
    await expect(
      profileSetupRequest({ first_name: 'Quang', last_name: 'Minh', identify_name: 'quangminh' }),
    ).resolves.toEqual({ id: 'u1' });
    expect(post).toHaveBeenCalledWith('/auth/profile/setup', {
      first_name: 'Quang',
      last_name: 'Minh',
      identify_name: 'quangminh',
    });
  });

  it('updateProfileNameRequest patches the name pair and unwraps the user envelope', async () => {
    const patch = jest.spyOn(apiClient, 'patch').mockResolvedValue({ data: { user: { id: 'u1' } } });

    await expect(updateProfileNameRequest({ first_name: 'Quang', last_name: 'Minh' })).resolves.toEqual({ id: 'u1' });
    expect(patch).toHaveBeenCalledWith('/auth/profile/name', { first_name: 'Quang', last_name: 'Minh' });
  });

  it('uploadAvatarRequest posts a multipart body on the avatar field', async () => {
    const request = jest.spyOn(apiClient, 'request').mockResolvedValue({ data: { user: { id: 'u1' } } });
    const file = { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' } as const;

    await expect(uploadAvatarRequest(file)).resolves.toEqual({ id: 'u1' });

    const config = request.mock.calls[0][0];
    expect(config.url).toBe('/auth/avatar');
    expect(config.method).toBe('patch');
    expect((config.data as FormData).getAll('avatar')).toEqual([file]);
  });

  it('deleteAvatarRequest deletes and unwraps the user envelope', async () => {
    const remove = jest.spyOn(apiClient, 'delete').mockResolvedValue({ data: { user: { id: 'u1', avatar_url: null } } });

    await expect(deleteAvatarRequest()).resolves.toEqual({ id: 'u1', avatar_url: null });
    expect(remove).toHaveBeenCalledWith('/auth/avatar');
  });

  it('changePasswordRequest returns the whole user-plus-tokens payload', async () => {
    const payload = {
      user: { id: 'u1' },
      tokens: { access: 'new-access', refresh: 'new-refresh', token_type: 'Bearer' },
    };
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({ data: payload });

    await expect(changePasswordRequest({ current_password: 'old', new_password: 'new' })).resolves.toEqual(payload);
    expect(post).toHaveBeenCalledWith('/auth/password/change', { current_password: 'old', new_password: 'new' });
  });

  it('requestPasswordResetRequest posts the email and returns the neutral detail verbatim', async () => {
    const detail = 'If an account exists with that email, a password reset link has been sent.';
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({ data: { detail } });

    await expect(requestPasswordResetRequest('a@b.com')).resolves.toEqual({ detail });
    expect(post).toHaveBeenCalledWith('/auth/password-reset/request', { email: 'a@b.com' });
  });
});
