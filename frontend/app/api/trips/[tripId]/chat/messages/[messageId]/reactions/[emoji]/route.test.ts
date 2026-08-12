import { beforeEach, describe, expect, it, vi } from "vitest";

const protectedUpstreamMock = vi.hoisted(() => ({
  buildProtectedResponse: vi.fn(
    (data: unknown, refreshedAccessToken?: string, status = 200) => {
      const response = Response.json(data, { status });
      if (refreshedAccessToken) {
        response.headers.set("X-Access-Token", refreshedAccessToken);
      }
      return response;
    },
  ),
  protectedUpstreamCall: vi.fn(),
}));

vi.mock("@/app/api/_lib/protected-upstream", () => protectedUpstreamMock);

const TRIP_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";

function buildDeleteRequest(): Request {
  return new Request(
    `http://localhost/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}/reactions/${encodeURIComponent("👍")}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer t" },
    },
  );
}

describe("BFF /api/trips/[tripId]/chat/messages/[messageId]/reactions/[emoji]", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    protectedUpstreamMock.buildProtectedResponse.mockImplementation(
      (data: unknown, refreshedAccessToken?: string, status = 200) => {
        const response = Response.json(data, { status });
        if (refreshedAccessToken) {
          response.headers.set("X-Access-Token", refreshedAccessToken);
        }
        return response;
      },
    );
  });

  it("re-encodes the decoded emoji segment and preserves upstream status", async () => {
    const { DELETE } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/reactions/[emoji]/route"
    );
    const payload = {
      reactions: [],
      change_sequence: 43,
      updated_at: "2026-08-10T12:01:00Z",
    };
    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: payload,
      status: 200,
    });

    const response = await DELETE(buildDeleteRequest() as never, {
      params: Promise.resolve({
        tripId: TRIP_ID,
        messageId: MESSAGE_ID,
        emoji: "👍",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}/reactions/${encodeURIComponent("👍")}`,
        method: "DELETE",
        authorization: "Bearer t",
      }),
    );
  });

  it("rejects malformed trip IDs without forwarding the reaction delete", async () => {
    const { DELETE } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/reactions/[emoji]/route"
    );

    const response = await DELETE(buildDeleteRequest() as never, {
      params: Promise.resolve({
        tripId: "invalid",
        messageId: MESSAGE_ID,
        emoji: "👍",
      }),
    });

    expect(response.status).toBe(400);
    expect(protectedUpstreamMock.protectedUpstreamCall).not.toHaveBeenCalled();
  });
});
