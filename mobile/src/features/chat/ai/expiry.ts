import type { AIActionDraft, AIActionDraftStatus } from './drafts';

const ACTIVE_STATUSES = new Set<AIActionDraftStatus>([
  'NEEDS_INFO',
  'READY',
]);

export interface AIActionDraftExpiry {
  readonly isExpired: boolean;
  readonly remainingMs: number;
  readonly visualStatus: AIActionDraftStatus;
  readonly label: string;
}

export function isLocallyExpired(
  draft: Pick<AIActionDraft, 'status' | 'expires_at'>,
  nowMs: number,
): boolean {
  return (
    ACTIVE_STATUSES.has(draft.status) && Date.parse(draft.expires_at) <= nowMs
  );
}

export function getAIActionDraftExpiry(
  draft: Pick<AIActionDraft, 'status' | 'expires_at'>,
  nowMs: number,
): AIActionDraftExpiry {
  const expiresAtMs = Date.parse(draft.expires_at);
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  const localExpiry = isLocallyExpired(draft, nowMs);
  if (draft.status === 'EXPIRED' || localExpiry) {
    return {
      isExpired: true,
      remainingMs: 0,
      visualStatus: 'EXPIRED',
      label: 'Expired',
    };
  }

  if (!ACTIVE_STATUSES.has(draft.status)) {
    return {
      isExpired: false,
      remainingMs,
      visualStatus: draft.status,
      label: 'Closed',
    };
  }

  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) {
    return {
      isExpired: false,
      remainingMs,
      visualStatus: draft.status,
      label: `Expires in ${seconds}s`,
    };
  }
  const minutes = Math.ceil(seconds / 60);
  return {
    isExpired: false,
    remainingMs,
    visualStatus: draft.status,
    label: `Expires in ${minutes}m`,
  };
}
