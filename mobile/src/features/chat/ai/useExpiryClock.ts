import { useEffect, useState } from 'react';
import type { AIActionDraft } from './drafts';
import { getAIActionDraftExpiry } from './expiry';
import { sharedAIExpiryDeadlineClock } from './expiryClock';

export function useAIActionDraftExpiry(
  draft: Pick<AIActionDraft, 'status' | 'expires_at'>,
  nowOverrideMs?: number,
) {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const expiresAtMs = Date.parse(draft.expires_at);
  const renderedClockMs = nowOverrideMs ?? clockMs;
  const projection = getAIActionDraftExpiry(draft, renderedClockMs);
  const activeStatus = draft.status === 'NEEDS_INFO' || draft.status === 'READY';

  useEffect(() => {
    if (
      nowOverrideMs !== undefined ||
      !activeStatus ||
      projection.isExpired
    ) {
      return undefined;
    }
    return sharedAIExpiryDeadlineClock.subscribe(expiresAtMs, setClockMs);
  }, [activeStatus, expiresAtMs, nowOverrideMs, projection.isExpired]);

  return projection;
}
