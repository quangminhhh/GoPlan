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
import {
  activateAuthSession,
  beginAuthSessionOpening,
  beginCredentialActivity,
  captureAuthTicket,
  getAuthSnapshot,
  isAuthTicketCurrent,
  publishAuthPair,
  requestAuthSessionClose,
  setAuthCloseEffects,
  subscribeAuthLifecycle,
  waitForAuthClose,
} from '@/shared/api/authSessionLifecycle';
import { refreshTokens, rotateTokens } from '@/shared/api/refresh';
import { setRefreshToken } from '@/shared/api/token-store';
import {
  beginPrivateMediaShutdown,
  flushPrivateMediaPurge,
  isPrivateMediaSessionOpen,
  resumePrivateMediaSession,
  startPrivateMediaSession,
  suspendPrivateMediaSession,
  waitForPrivateNetworkIdle,
} from '@/shared/media/privateMediaLifecycle';
import { registerDefaultPrivateMediaPurgers } from '@/shared/media/privateMediaPurgers';
import { photoSaveTempCoordinator } from '@/shared/media/photoSaveTempStore';
import { changePasswordRequest, fetchMe, logoutRequest } from './api';
import type { AuthResponse, AuthUser, ChangePasswordInput } from './types';

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface SessionContextValue {
  status: SessionStatus;
  user: AuthUser | null;
  signIn: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<'rotated' | 'signedOut'>;
  updateUser: (user: AuthUser) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

// Expo Router evaluates photo routes lazily. Register their general protected
// namespaces from the auth root so cold restore purges crash-left files.
registerDefaultPrivateMediaPurgers();

function appAllowsPrivateMedia(): boolean {
  return AppState.currentState !== 'background';
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [user, setUser] = useState<AuthUser | null>(null);

  /**
   * Auth close owns the synchronous UI/general-media boundary and a low-level
   * revoke transport. Refresh failures and user sign-out therefore join the
   * same workflow instead of running competing effects.
   */
  useEffect(() => {
    setAuthCloseEffects({
      onClosing: () => {
        beginPrivateMediaShutdown();
      },
      onClosingPublished: () => {
        setUser(null);
        setStatus('signedOut');
      },
      // Dedicated PhotoKit commit work is deliberately absent from the general
      // network registry. This waits only for aborted private HTTP/native upload
      // work to release request-body leases before server revocation proceeds.
      beforeRevoke: async () => {
        await waitForPrivateNetworkIdle();
      },
      revoke: async (pair) => {
        await logoutRequest(pair);
      },
    });
    return () => setAuthCloseEffects(null);
  }, []);

  /**
   * The PhotoKit handoff has a dedicated fence. Auth publication never awaits
   * it: the coordinator itself prevents session B from staging until session A
   * has released its exact current file.
   */
  useEffect(() => {
    void photoSaveTempCoordinator.bootstrap();

    const syncPhotoSaveSession = (snapshot: ReturnType<typeof getAuthSnapshot>) => {
      if (snapshot.phase === 'active') {
        photoSaveTempCoordinator.activateSession(
          snapshot.sessionGeneration,
          appAllowsPrivateMedia(),
        );
      } else if (snapshot.phase === 'closing' || snapshot.phase === 'signedOut') {
        photoSaveTempCoordinator.suspend('signOut');
      }
    };

    const unsubscribe = subscribeAuthLifecycle(syncPhotoSaveSession);
    // Close or activation can happen between render and effect registration.
    // The immediate atomic re-check makes subscription timing irrelevant.
    syncPhotoSaveSession(getAuthSnapshot());
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      let ticket;
      try {
        ticket = await beginAuthSessionOpening();
      } catch {
        if (!cancelled) setStatus('signedOut');
        return;
      }

      // Cleanup of general protected media finishes before restore can issue a
      // request or render a protected route.
      await startPrivateMediaSession(appAllowsPrivateMedia());
      if (cancelled || !isAuthTicketCurrent(ticket) || !isPrivateMediaSessionOpen()) {
        if (isAuthTicketCurrent(ticket)) {
          await requestAuthSessionClose('restoreFailure');
        }
        return;
      }

      const access = await refreshTokens(ticket);
      if (cancelled || !isAuthTicketCurrent(ticket)) {
        if (cancelled && isAuthTicketCurrent(ticket)) {
          void requestAuthSessionClose('restoreFailure');
        }
        return;
      }
      if (access === null) {
        await requestAuthSessionClose('restoreFailure');
        return;
      }

      try {
        const me = await fetchMe();
        if (
          cancelled ||
          !isAuthTicketCurrent(ticket) ||
          !isPrivateMediaSessionOpen() ||
          !activateAuthSession(ticket)
        ) {
          if (isAuthTicketCurrent(ticket)) {
            void requestAuthSessionClose('restoreFailure');
          }
          return;
        }
        setUser(me);
        setStatus('signedIn');
      } catch {
        if (!cancelled && isAuthTicketCurrent(ticket)) {
          await requestAuthSessionClose('restoreFailure');
        }
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void resumePrivateMediaSession();
        const snapshot = getAuthSnapshot();
        if (snapshot.phase === 'active') {
          photoSaveTempCoordinator.resume(snapshot.sessionGeneration);
        }
      } else if (nextState === 'background') {
        // Both invalidations are synchronous; neither waits for React render or
        // route unmount before refusing new work.
        suspendPrivateMediaSession();
        photoSaveTempCoordinator.suspend('background');
      }
    });
    return () => subscription.remove();
  }, []);

  const signIn = useCallback(async (auth: AuthResponse) => {
    const ticket = await beginAuthSessionOpening();
    const activity = beginCredentialActivity(ticket);
    if (activity === null) {
      await waitForAuthClose();
      return;
    }

    const pair = { access: auth.tokens.access, refresh: auth.tokens.refresh };
    activity.recordCandidate(pair);
    let published = false;
    try {
      await setRefreshToken(pair.refresh);
      if (isAuthTicketCurrent(ticket)) {
        published = publishAuthPair(ticket, pair);
      }
    } catch (error) {
      activity.finish();
      await requestAuthSessionClose('credentialFailure');
      throw error;
    } finally {
      activity.finish();
    }

    if (!published || !isAuthTicketCurrent(ticket)) {
      await waitForAuthClose();
      return;
    }

    await startPrivateMediaSession(appAllowsPrivateMedia());
    if (
      !isAuthTicketCurrent(ticket) ||
      !isPrivateMediaSessionOpen() ||
      !activateAuthSession(ticket)
    ) {
      if (isAuthTicketCurrent(ticket)) {
        await requestAuthSessionClose('credentialFailure');
      } else {
        await waitForAuthClose();
      }
      return;
    }

    setUser(auth.user);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await requestAuthSessionClose('user');
    await flushPrivateMediaPurge();
  }, []);

  /**
   * The context captures/registers the ticket before the HTTP call, so close
   * waits for the actual password request as well as its SecureStore adoption.
   */
  const changePassword = useCallback(
    async (input: ChangePasswordInput): Promise<'rotated' | 'signedOut'> => {
      const source = captureAuthTicket();
      if (source === null || getAuthSnapshot().phase !== 'active') {
        return 'signedOut';
      }
      const activity = beginCredentialActivity(source);
      if (activity === null) return 'signedOut';

      let auth: AuthResponse;
      try {
        auth = await changePasswordRequest(input);
      } catch (error) {
        activity.finish();
        if (!isAuthTicketCurrent(source)) {
          await waitForAuthClose();
          return 'signedOut';
        }
        throw error;
      }

      // Record through the outer activity immediately. rotateTokens advances
      // the revision and records the same pair again before persistence.
      activity.recordCandidate({
        access: auth.tokens.access,
        refresh: auth.tokens.refresh,
      });

      let rotated: boolean;
      try {
        rotated = await rotateTokens(auth.tokens, source);
      } catch {
        activity.finish();
        await requestAuthSessionClose('credentialFailure');
        await flushPrivateMediaPurge();
        return 'signedOut';
      } finally {
        activity.finish();
      }

      if (!rotated) {
        await waitForAuthClose();
        return 'signedOut';
      }

      const snapshot = getAuthSnapshot();
      if (
        snapshot.phase !== 'active' ||
        snapshot.sessionGeneration !== source.sessionGeneration ||
        snapshot.access !== auth.tokens.access
      ) {
        return 'signedOut';
      }

      setUser(auth.user);
      return 'rotated';
    },
    [],
  );

  const updateUser = useCallback((next: AuthUser) => {
    setUser(next);
  }, []);

  const value = useMemo(
    () => ({ status, user, signIn, signOut, changePassword, updateUser }),
    [status, user, signIn, signOut, changePassword, updateUser],
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
