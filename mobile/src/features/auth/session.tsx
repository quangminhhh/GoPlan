import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { refreshTokens, rotateTokens, setOnRefreshFailed } from '@/shared/api/refresh';
import {
  beginPrivateMediaShutdown,
  flushPrivateMediaPurge,
  resumePrivateMediaSession,
  startPrivateMediaSession,
  suspendPrivateMediaSession,
  waitForPrivateNetworkIdle,
} from '@/shared/media/privateMediaLifecycle';
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
      // Cleanup of private media left by a previous process runs to completion
      // before the token restore, so no protected route can render against
      // files an earlier session staged.
      await startPrivateMediaSession();
      const access = await refreshTokens();
      if (cancelled) return;
      if (!access) {
        beginPrivateMediaShutdown();
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
        beginPrivateMediaShutdown();
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
      // Same synchronous front half a user-initiated sign-out runs, and for the
      // same reason: the session is over before the state transition is visible.
      beginPrivateMediaShutdown();
      setUser(null);
      setStatus('signedOut');
    });
    return () => setOnRefreshFailed(null);
  }, []);

  /**
   * Backgrounding purges staged private media unless a transfer still needs it;
   * returning to the foreground drains that cleanup before reopening the gate.
   *
   * Only `background` counts. iOS reports `inactive` for a notification-centre
   * pull or a share sheet, and treating those as a session boundary would delete
   * a ZIP the share sheet is about to read.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void resumePrivateMediaSession();
      } else if (nextState === 'background') {
        suspendPrivateMediaSession();
      }
    });
    return () => subscription.remove();
  }, []);

  const signIn = useCallback(async (auth: AuthResponse) => {
    setAccessToken(auth.tokens.access);
    await setRefreshToken(auth.tokens.refresh);
    // A clean epoch before any protected asset can be requested.
    await startPrivateMediaSession();
    setUser(auth.user);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    // The front half runs before the logout request, not after it. It shuts the
    // acquisition gate and aborts private-media work synchronously, and the wait
    // that follows covers every refresh already in flight — including one an
    // Axios interceptor started — so nothing can write a fresh token back into
    // the store after `clearTokens()` (D20).
    beginPrivateMediaShutdown();
    await waitForPrivateNetworkIdle();

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
    await flushPrivateMediaPurge();
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
      // The password-change endpoint already revoked the previous pair. A
      // SecureStore failure therefore ends the session just as definitively as
      // an explicit sign-out, including the private-media gate and purge.
      beginPrivateMediaShutdown();
      await waitForPrivateNetworkIdle();
      await clearTokens();
      setUser(null);
      setStatus('signedOut');
      await flushPrivateMediaPurge();
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
