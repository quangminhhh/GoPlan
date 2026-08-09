const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function canonicalizeChatTripId(tripId: unknown): string | null {
  if (typeof tripId !== "string") return null;
  const canonical = tripId.trim().toLowerCase();
  return UUID_PATTERN.test(canonical) ? canonical : null;
}

export function requireCanonicalChatTripId(tripId: unknown): string {
  const canonical = canonicalizeChatTripId(tripId);
  if (canonical === null) {
    throw new Error("Invalid chat trip UUID.");
  }
  return canonical;
}
