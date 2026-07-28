import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { refreshTokens, rotateTokens, setOnRefreshFailed } from '@/shared/api/refresh';
import { clearTokens, getRefreshToken, setAccessToken, setRefreshToken } from '@/shared/api/token-store';
import { fetchMe, logoutRequest } from './api';
import type { AuthResponse, AuthUser } from './types';

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface SessionContextValue {
  status: SessionStatus;
  user: AuthUser | null;
  signIn: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  rotateSession: (auth: AuthResponse) => Promise<'rotated' | 'signedOut'>;
  updateUser: (user: AuthUser) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const access = await refreshTokens();
      if (cancelled) return;
      if (!access) {
        setStatus('signedOut');
        return;
      }
      try {
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        setStatus('signedIn');
      } catch {
        if (cancelled) return;
        await clearTokens();
        setStatus('signedOut');
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setOnRefreshFailed(() => {
      setUser(null);
      setStatus('signedOut');
    });
    return () => setOnRefreshFailed(null);
  }, []);

  const signIn = useCallback(async (auth: AuthResponse) => {
    setAccessToken(auth.tokens.access);
    await setRefreshToken(auth.tokens.refresh);
    setUser(auth.user);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    const refresh = await getRefreshToken();
    if (refresh) {
      try {
        await logoutRequest(refresh);
      } catch {
        // Best-effort revocation; local sign-out proceeds regardless.
      }
    }
    await clearTokens();
    setUser(null);
    setStatus('signedOut');
  }, []);

  /**
   * Adopt the token pair returned by an operation that revoked every previous
   * token (password change). Owns the failure policy so no screen can get it
   * wrong: the server has already invalidated this account's tokens, so a failed
   * secure write leaves nothing usable on disk and the only safe outcome is a
   * clean re-login — never a stale, already-revoked refresh token left behind.
   */
  const rotateSession = useCallback(async (auth: AuthResponse): Promise<'rotated' | 'signedOut'> => {
    try {
      await rotateTokens(auth.tokens);
    } catch {
      await clearTokens();
      setUser(null);
      setStatus('signedOut');
      return 'signedOut';
    }
    setUser(auth.user);
    return 'rotated';
  }, []);

  const updateUser = useCallback((next: AuthUser) => {
    setUser(next);
  }, []);

  const value = useMemo(
    () => ({ status, user, signIn, signOut, rotateSession, updateUser }),
    [status, user, signIn, signOut, rotateSession, updateUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return context;
}
