import type { NextRequest } from "next/server";

import {
  buildProtectedResponse,
  protectedUpstreamCall,
} from "@/app/api/_lib/protected-upstream";
import { canonicalizeChatTripId } from "@/features/chat/domain/trip-id";

type RouteContext = { params: Promise<{ tripId: string }> };

function buildQuery(searchParams: URLSearchParams): string | undefined {
  const allowed = ["cursor", "since", "changed_since", "changed_since_id", "limit"];
  const out = new URLSearchParams();
  for (const key of allowed) {
    const value = searchParams.get(key);
    if (value) out.set(key, value);
  }
  const serialized = out.toString();
  return serialized.length > 0 ? serialized : undefined;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { tripId } = await context.params;
  const canonicalTripId = canonicalizeChatTripId(tripId);
  if (canonicalTripId === null) {
    return Response.json(
      { detail: "Trip ID is invalid.", error_code: "INVALID_TRIP_ID" },
      { status: 400 },
    );
  }
  const authorization = request.headers.get("Authorization");

  const result = await protectedUpstreamCall({
    path: `/api/trips/${encodeURIComponent(canonicalTripId)}/chat/messages`,
    method: "GET",
    query: buildQuery(request.nextUrl.searchParams),
    authorization,
  });

  if (!result.ok) return result.response;

  // Backend already returns opaque cursor / has_more — pass through unchanged.
  return buildProtectedResponse(
    result.data,
    result.refreshedAccessToken,
    result.status,
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { tripId } = await context.params;
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
    path: `/api/trips/${encodeURIComponent(canonicalTripId)}/chat/messages`,
    method: "POST",
    body,
    authorization,
  });

  if (!result.ok) return result.response;

  // Preserve 201 (new) vs 200 (idempotent retry on duplicate client_message_id).
  return buildProtectedResponse(
    result.data,
    result.refreshedAccessToken,
    result.status,
  );
}
