import { describe, expect, it } from "vitest";

import {
  canonicalizeChatTripId,
  requireCanonicalChatTripId,
} from "@/features/chat/domain/trip-id";

const TRIP_ID = "a0b1c2d3-e4f5-4678-9abc-def012345678";

describe("chat trip UUID canonicalization", () => {
  it("trims and canonicalizes uppercase UUIDs to lowercase", () => {
    expect(canonicalizeChatTripId(`  ${TRIP_ID.toUpperCase()}  `)).toBe(TRIP_ID);
  });

  it.each(["", "trip-1", "a0b1c2d3e4f546789abcdef012345678", `${TRIP_ID}/messages`])(
    "rejects malformed trip identity %j",
    (value) => {
      expect(canonicalizeChatTripId(value)).toBeNull();
      expect(() => requireCanonicalChatTripId(value)).toThrow(
        "Invalid chat trip UUID.",
      );
    },
  );

  it.each([null, undefined, 42, {}, []])(
    "rejects non-string trip identity %j",
    (value) => {
      expect(canonicalizeChatTripId(value)).toBeNull();
    },
  );
});
