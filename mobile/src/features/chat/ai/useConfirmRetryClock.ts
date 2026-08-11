import { useEffect, useState } from 'react';
import { sharedAIExpiryDeadlineClock } from './expiryClock';

export interface AIConfirmRetryProjection {
  readonly blocked: boolean;
  readonly label: string | null;
  readonly remainingMs: number;
}

function retryLabel(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  if (seconds < 60) {
    return `Confirmation available in ${seconds}s`;
  }
  return `Confirmation available in ${Math.ceil(seconds / 60)} min`;
}

export function useAIConfirmRetryClock(
  retryAtMs: number | null,
  nowOverrideMs?: number,
): AIConfirmRetryProjection {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const nowMs = nowOverrideMs ?? clockMs;
  const safeDeadline =
    retryAtMs !== null && Number.isSafeInteger(retryAtMs) ? retryAtMs : null;
  const remainingMs =
    safeDeadline === null ? 0 : Math.max(0, safeDeadline - nowMs);
  const blocked = remainingMs > 0;

  useEffect(() => {
    if (nowOverrideMs !== undefined || safeDeadline === null || !blocked) {
      return undefined;
    }
    return sharedAIExpiryDeadlineClock.subscribe(safeDeadline, setClockMs);
  }, [blocked, nowOverrideMs, safeDeadline]);

  return {
    blocked,
    label: blocked ? retryLabel(remainingMs) : null,
    remainingMs,
  };
}
