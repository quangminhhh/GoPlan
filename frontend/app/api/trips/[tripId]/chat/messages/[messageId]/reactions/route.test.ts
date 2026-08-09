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

function buildPostRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}/reactions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify(body),
    },
  );
}

describe("BFF /api/trips/[tripId]/chat/messages/[messageId]/reactions", () => {
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

  it("forwards reaction POST body and preserves upstream status", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/reactions/route"
    );
    const payload = {
      reactions: [{ emoji: "👍", count: 1, reacted_by_ids: ["u-1"] }],
      change_sequence: 42,
      updated_at: "2026-08-10T12:00:00Z",
    };
    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: payload,
      status: 201,
    });

    const response = await POST(buildPostRequest({ emoji: "👍" }) as never, {
      params: Promise.resolve({ tripId: TRIP_ID, messageId: MESSAGE_ID }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(payload);
    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}/reactions`,
        method: "POST",
        body: JSON.stringify({ emoji: "👍" }),
        authorization: "Bearer t",
      }),
    );
  });

  it("rejects malformed trip IDs without forwarding the reaction", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/reactions/route"
    );

    const response = await POST(buildPostRequest({ emoji: "👍" }) as never, {
      params: Promise.resolve({ tripId: "invalid", messageId: MESSAGE_ID }),
    });

    expect(response.status).toBe(400);
    expect(protectedUpstreamMock.protectedUpstreamCall).not.toHaveBeenCalled();
  });
});
