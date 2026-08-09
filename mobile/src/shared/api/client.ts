import { create, AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import {
  getAuthSnapshot,
  isAuthTicketCurrent,
  type AuthTicket,
} from './authSessionLifecycle';
import { getApiBaseUrl } from './base-url';
import { refreshTokens } from './refresh';
import { getAccessToken } from './token-store';

interface AuthenticatedRequestMeta extends InternalAxiosRequestConfig {
  authGeneration?: number;
  authCredentialRevision?: number;
  retriedAfterRefresh?: boolean;
  skipAuthRefresh?: boolean;
}

export const apiClient = create({
  baseURL: getApiBaseUrl(),
  timeout: 15_000,
});

function stampedTicket(config: AuthenticatedRequestMeta): AuthTicket | null {
  if (
    config.authGeneration === undefined ||
    config.authCredentialRevision === undefined
  ) {
    return null;
  }
  return {
    sessionGeneration: config.authGeneration,
    credentialRevision: config.authCredentialRevision,
  };
}

apiClient.interceptors.request.use((request) => {
  const config = request as AuthenticatedRequestMeta;
  const headers = new AxiosHeaders(config.headers);
  config.headers = headers;

  const priorTicket = stampedTicket(config);
  if (priorTicket !== null && !isAuthTicketCurrent(priorTicket)) {
    // Most importantly, this catches a replay whose close raced the final
    // response-interceptor check before Axios runs its request chain.
    throw new Error('The authenticated request belongs to a closed session.');
  }

  if (!headers.has('Authorization')) {
    const snapshot = getAuthSnapshot();
    if (
      snapshot.access !== null &&
      (snapshot.phase === 'opening' || snapshot.phase === 'active')
    ) {
      headers.set('Authorization', `Bearer ${snapshot.access}`);
      config.authGeneration = snapshot.sessionGeneration;
      config.authCredentialRevision = snapshot.credentialRevision;
    } else {
      // Compatibility for isolated unit tests and non-auth legacy callers that
      // explicitly seed the in-memory token store. Production credential paths
      // publish through the lifecycle and therefore always take the branch
      // above, with a generation stamp.
      const legacyAccess = getAccessToken();
      if (legacyAccess !== null) {
        headers.set('Authorization', `Bearer ${legacyAccess}`);
      }
    }
  }

  return config;
});

apiClient.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as AuthenticatedRequestMeta | undefined;
  const hadAuthHeader = Boolean(
    config && new AxiosHeaders(config.headers).has('Authorization'),
  );

  if (
    error.response?.status !== 401 ||
    !config ||
    config.retriedAfterRefresh ||
    config.skipAuthRefresh ||
    !hadAuthHeader
  ) {
    throw error;
  }

  const ticket = stampedTicket(config);
  if (ticket !== null && !isAuthTicketCurrent(ticket)) {
    throw error;
  }

  const newAccess = await refreshTokens(ticket ?? undefined);
  if (newAccess === null) {
    throw error;
  }
  if (ticket !== null && !isAuthTicketCurrent(ticket)) {
    throw error;
  }

  config.retriedAfterRefresh = true;
  config.headers = new AxiosHeaders(config.headers);
  config.headers.set('Authorization', `Bearer ${newAccess}`);

  // There is deliberately no await between the final generation check and
  // scheduling replay. The request interceptor repeats the same check before
  // the adapter, covering the remaining Axios microtask boundary.
  return apiClient.request(config);
});
