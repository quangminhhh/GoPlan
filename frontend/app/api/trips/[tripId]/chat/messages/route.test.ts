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
  return new Request(
    `http://localhost/api/trips/${TRIP_ID}/chat/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify(body),
    },
  );
}

function buildGetRequest(query = ""): {
  headers: Headers;
  nextUrl: URL;
} {
  return {
    headers: new Headers({ Authorization: "Bearer t" }),
    nextUrl: new URL(
      `http://localhost/api/trips/${TRIP_ID}/chat/messages${query}`,
    ),
  };
}

describe("BFF /api/trips/[tripId]/chat/messages", () => {
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

  it("forwards 201 from upstream when POST creates a new message", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    const created = {
      message: {
        id: "msg-1",
        trip_id: TRIP_ID,
        sender: { id: "u-1", display_name: "A", identify_tag: null },
        content: "hi",
        client_message_id: "client-1",
        created_at: "2026-05-08T10:00:00Z",
      },
    };

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: created,
      status: 201,
    });

    const response = await POST(
      buildPostRequest({ content: "hi", client_message_id: "client-1" }) as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(created);
  });

  it("forwards 200 from upstream when POST is an idempotent retry", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: { message: { id: "msg-1" } },
      status: 200,
    });

    const response = await POST(
      buildPostRequest({ content: "hi", client_message_id: "client-1" }) as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(response.status).toBe(200);
  });

  it("propagates upstream failure response unchanged on POST", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: false,
      response: Response.json(
        { detail: "Trip not found.", error_code: "TRIP_NOT_FOUND" },
        { status: 404 },
      ),
    });

    const response = await POST(buildPostRequest({ content: "hi" }) as never, {
      params: Promise.resolve({ tripId: TRIP_ID }),
    });

    expect(response.status).toBe(404);
  });

  it("forwards cursor and limit query params on GET history", async () => {
    const { GET } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: { results: [], next_cursor: null },
      status: 200,
    });

    await GET(
      buildGetRequest("?cursor=abc&limit=20") as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: `/api/trips/${TRIP_ID}/chat/messages`,
        query: "cursor=abc&limit=20",
      }),
    );
  });

  it("forwards since param on GET gap-fill", async () => {
    const { GET } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: { results: [], has_more: false },
      status: 200,
    });

    await GET(
      buildGetRequest("?since=msg-9&limit=100") as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "since=msg-9&limit=100",
      }),
    );
  });

  it("passes AI_BUSY from upstream without changing status or payload", async () => {
    const { POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: false,
      response: Response.json(
        {
          detail: "GoPlanAI is already replying.",
          error_code: "AI_BUSY",
        },
        { status: 409 },
      ),
    });

    const response = await POST(
      buildPostRequest({
        content: "@GoPlanAI hello",
        client_message_id: "11111111-1111-4111-8111-111111111111",
      }) as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      detail: "GoPlanAI is already replying.",
      error_code: "AI_BUSY",
    });
  });

  it("forwards changed_since sequence params for mutation sync", async () => {
    const { GET } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );
    const lastMessageId = "00000000-0000-4000-8000-000000000123";

    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: { results: [], has_more: false },
      status: 200,
    });

    await GET(
      buildGetRequest(
        `?changed_since=42&changed_since_id=${lastMessageId}&limit=100`,
      ) as never,
      { params: Promise.resolve({ tripId: TRIP_ID }) },
    );

    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: `changed_since=42&changed_since_id=${lastMessageId}&limit=100`,
      }),
    );
  });

  it("canonicalizes uppercase trip UUIDs before calling Django", async () => {
    const { GET } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );
    protectedUpstreamMock.protectedUpstreamCall.mockResolvedValue({
      ok: true,
      data: { results: [], next_cursor: null },
      status: 200,
    });

    await GET(buildGetRequest() as never, {
      params: Promise.resolve({ tripId: TRIP_ID.toUpperCase() }),
    });

    expect(protectedUpstreamMock.protectedUpstreamCall).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/api/trips/${TRIP_ID}/chat/messages` }),
    );
  });

  it("rejects malformed trip IDs without issuing an upstream request", async () => {
    const { GET, POST } = await import(
      "@/app/api/trips/[tripId]/chat/messages/route"
    );

    const getResponse = await GET(buildGetRequest() as never, {
      params: Promise.resolve({ tripId: "not-a-uuid" }),
    });
    const postResponse = await POST(buildPostRequest({ content: "hi" }) as never, {
      params: Promise.resolve({ tripId: "" }),
    });

    expect(getResponse.status).toBe(400);
    expect(postResponse.status).toBe(400);
    await expect(getResponse.json()).resolves.toEqual({
      detail: "Trip ID is invalid.",
      error_code: "INVALID_TRIP_ID",
    });
    expect(protectedUpstreamMock.protectedUpstreamCall).not.toHaveBeenCalled();
  });
});
