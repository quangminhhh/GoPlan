export interface AuthUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  identify_name: string | null;
  identify_code: string | null;
  identify_tag: string | null;
  avatar_url: string | null;
  email_verified: boolean;
  is_profile_completed: boolean;
  requires_profile_setup: boolean;
}

export interface AuthTokens {
  access: string;
  refresh: string;
  token_type: 'Bearer';
}

export interface AuthResponse {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface ProfileNameInput {
  first_name: string;
  last_name: string;
}

export interface ChangePasswordInput {
  current_password: string;
  new_password: string;
}
