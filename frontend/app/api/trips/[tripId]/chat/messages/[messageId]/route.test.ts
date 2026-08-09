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

function buildDeleteRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify(body),
    },
  );
}

describe("BFF /api/trips/[tripId]/chat/messages/[messageId]", () => {
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

  it("forwards DELETE body and preserves upstream status", async () => {
    const { DELETE } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/route"
    );
    const payload = { message: { id: MESSAGE_ID, is_deleted_for_everyone: true } };
    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: payload,
      status: 200,
    });

    const response = await DELETE(
      buildDeleteRequest({ mode: "for_everyone" }) as never,
      { params: Promise.resolve({ tripId: TRIP_ID, messageId: MESSAGE_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/trips/${TRIP_ID}/chat/messages/${MESSAGE_ID}`,
        method: "DELETE",
        body: JSON.stringify({ mode: "for_everyone" }),
        authorization: "Bearer t",
      }),
    );
  });

  it("rejects malformed trip IDs without forwarding delete", async () => {
    const { DELETE } = await import(
      "@/app/api/trips/[tripId]/chat/messages/[messageId]/route"
    );

    const response = await DELETE(
      buildDeleteRequest({ mode: "for_everyone" }) as never,
      { params: Promise.resolve({ tripId: "invalid", messageId: MESSAGE_ID }) },
    );

    expect(response.status).toBe(400);
    expect(protectedUpstreamMock.protectedUpstreamCall).not.toHaveBeenCalled();
  });
});
