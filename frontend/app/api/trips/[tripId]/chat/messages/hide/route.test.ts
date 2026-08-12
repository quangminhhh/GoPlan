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

function buildPostRequest(body: unknown): Request {
  return new Request(`http://localhost/api/trips/${TRIP_ID}/chat/messages/hide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

describe("BFF /api/trips/[tripId]/chat/messages/hide", () => {
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

  it("forwards bulk hide body to upstream", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/hide/route"
    );
    const payload = { hidden_message_ids: ["msg-1", "msg-2"] };
    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: payload,
      status: 200,
    });

    const response = await POST(
      buildPostRequest({ message_ids: ["msg-1", "msg-2"] }) as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/trips/${TRIP_ID}/chat/messages/hide`,
        method: "POST",
        body: JSON.stringify({ message_ids: ["msg-1", "msg-2"] }),
        authorization: "Bearer t",
      }),
    );
  });

  it("rejects malformed trip IDs without forwarding bulk hide", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/hide/route"
    );

    const response = await POST(
      buildPostRequest({ message_ids: ["msg-1"] }) as never,
      { params: Promise.resolve({ tripId: "invalid" }) },
    );

    expect(response.status).toBe(400);
    expect(protectedUpstreamMock.protectedUpstreamCall).not.toHaveBeenCalled();
  });
});
