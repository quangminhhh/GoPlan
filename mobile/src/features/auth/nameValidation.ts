/**
 * Client mirror of the cheap half of the backend's validate_human_name
 * (backend/accounts/serializers.py), so the obvious mistakes are caught without
 * spending one of the throttled requests. The server stays the authority: it
 * also rejects separators at the edges, doubled separators, and disallowed
 * Unicode categories, reporting those as INVALID_FIRST_NAME / INVALID_LAST_NAME.
 * Copy here is kept identical to the server's so the two never contradict.
 */
export const NAME_MAX_LENGTH = 15;

export type NameFieldError = 'EMPTY' | 'TOO_LONG' | 'HAS_SPACE';

export function validateHumanName(value: string): NameFieldError | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'EMPTY';
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    return 'TOO_LONG';
  }
  if (/\s/.test(trimmed)) {
    return 'HAS_SPACE';
  }
  return null;
}

export function describeNameError(label: string, code: NameFieldError): string {
  switch (code) {
    case 'EMPTY':
      return `${label} cannot be empty.`;
    case 'TOO_LONG':
      return `${label} must be at most ${NAME_MAX_LENGTH} characters.`;
    case 'HAS_SPACE':
      return `${label} must be a single word (no spaces).`;
  }
}
