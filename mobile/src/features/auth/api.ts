import { apiClient } from '@/shared/api/client';
import type { UploadableFile } from '@/shared/media/types';
import { uploadFile } from '@/shared/media/uploadFile';
import type { AuthResponse, AuthUser, ChangePasswordInput, ProfileNameInput } from './types';

export interface ProfileSetupInput {
  first_name: string;
  last_name: string;
  identify_name: string;
}

export async function loginRequest(email: string, password: string): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/login', { email, password });
  return data;
}

export async function registerRequest(email: string, password: string): Promise<{ detail: string }> {
  const { data } = await apiClient.post<{ detail: string }>('/auth/register', { email, password });
  return data;
}

export async function resendVerificationRequest(email: string): Promise<{ detail: string }> {
  const { data } = await apiClient.post<{ detail: string }>('/auth/resend-verification', { email });
  return data;
}

export async function logoutRequest(refresh: string): Promise<void> {
  await apiClient.post('/auth/logout', { refresh });
}

export async function fetchMe(): Promise<AuthUser> {
  const { data } = await apiClient.get<{ user: AuthUser }>('/auth/me');
  return data.user;
}

export async function profileSetupRequest(input: ProfileSetupInput): Promise<AuthUser> {
  const { data } = await apiClient.post<{ user: AuthUser }>('/auth/profile/setup', input);
  return data.user;
}

export async function updateProfileNameRequest(input: ProfileNameInput): Promise<AuthUser> {
  const { data } = await apiClient.patch<{ user: AuthUser }>('/auth/profile/name', input);
  return data.user;
}

export async function uploadAvatarRequest(file: UploadableFile): Promise<AuthUser> {
  const data = await uploadFile<{ user: AuthUser }>('/auth/avatar', 'avatar', file, 'patch');
  return data.user;
}

export async function deleteAvatarRequest(): Promise<AuthUser> {
  const { data } = await apiClient.delete<{ user: AuthUser }>('/auth/avatar');
  return data.user;
}

/**
 * The server invalidates every existing session and returns a fresh token pair,
 * so the caller must adopt both tokens through the session's rotateSession().
 *
 * `input` holds two plaintext passwords: never log it, never fold it into an
 * error message, never store it anywhere but this request body.
 */
export async function changePasswordRequest(input: ChangePasswordInput): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/password/change', input);
  return data;
}

/**
 * The response is deliberately neutral about whether the account exists. Render
 * `detail` verbatim and never branch on it — branching would reintroduce the user
 * enumeration the backend specifically prevents.
 */
export async function requestPasswordResetRequest(email: string): Promise<{ detail: string }> {
  const { data } = await apiClient.post<{ detail: string }>('/auth/password-reset/request', { email });
  return data;
}
