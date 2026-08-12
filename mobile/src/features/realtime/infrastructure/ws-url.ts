import { getServerRootUrl } from '@/shared/api/base-url';

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
}

export function resolveRealtimeWebSocketUrl(
  serverRoot: string = getServerRootUrl(),
): string {
  let url: URL;
  try {
    url = new URL(serverRoot);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid HTTP(S) URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_API_URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('EXPO_PUBLIC_API_URL must not contain credentials.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Cleartext WebSocket connections are allowed only for local development.');
  }

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/realtime';
  url.search = '';
  url.hash = '';
  return url.toString();
}
