/** First letter of the first name plus first letter of the last, uppercased. */
export function getInitials(displayName: string): string {
  const names = displayName.trim().split(/\s+/).filter(Boolean);
  if (names.length === 0) {
    return '?';
  }
  const first = Array.from(names[0])[0] ?? '';
  const last = names.length > 1 ? (Array.from(names[names.length - 1])[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase();
}
