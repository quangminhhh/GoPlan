import type { NextRequest } from "next/server";

import {
  buildProtectedResponse,
  protectedUpstreamCall,
} from "@/app/api/_lib/protected-upstream";
import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";

type RouteContext = { params: Promise<{ tripId: string; messageId: string }> };

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { tripId, messageId } = await context.params;
  const canonicalTripId = canonicalizeChatTripId(tripId);
  if (canonicalTripId === null) {
    return Response.json(
      { detail: "Trip ID is invalid.", error_code: "INVALID_TRIP_ID" },
      { status: 400 },
    );
  }
  const authorization = request.headers.get("Authorization");
  const body = await request.text();

  const result = await protectedUpstreamCall({
    path: `/api/trips/${encodeURIComponent(canonicalTripId)}/chat/messages/${encodeURIComponent(messageId)}`,
    method: "DELETE",
    body,
    authorization,
  });

  if (!result.ok) return result.response;

  return buildProtectedResponse(
    result.data,
    result.refreshedAccessToken,
    result.status,
  );
}
