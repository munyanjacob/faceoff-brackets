import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - the auth gate, that
// `validateCreateBracketForm`'s exact rules/error strings really do apply
// here unmodified, the exact `bracket.create` call, and the response
// status/CORS headers - without a live database. End-to-end behaviour
// against real seeded data is covered separately in
// `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const create = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { bracket: { create } },
}));

const { POST, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function postRequest(body: unknown, authorization?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request("http://localhost/brackets", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawBodyRequest(rawBody: string, authorization?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/brackets", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

const VALID_BODY = {
  title: "Best Sitcom",
  description: "A friendly poll.",
  visibility: "PUBLIC",
  votingRequirement: "ANONYMOUS_ALLOWED",
};

describe("POST /brackets", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    create.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await POST(postRequest(VALID_BODY));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with validateCreateBracketForm's exact string when title is missing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");

    const response = await POST(
      postRequest({
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      }, "Bearer token")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Title is required.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 with validateCreateBracketForm's exact string for an invalid visibility", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");

    const response = await POST(
      postRequest(
        {
          title: "Best Sitcom",
          visibility: "SECRET",
          votingRequirement: "ANONYMOUS_ALLOWED",
        },
        "Bearer token"
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Choose a visibility: Public or Private.",
    });
  });

  it("returns 400 with validateCreateBracketForm's exact string for an invalid votingRequirement", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");

    const response = await POST(
      postRequest(
        {
          title: "Best Sitcom",
          visibility: "PUBLIC",
          votingRequirement: "MAYBE",
        },
        "Bearer token"
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Choose whether voting requires an account.",
    });
  });

  it("treats a malformed JSON body the same as an empty one (missing-title error), rather than throwing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");

    const response = await POST(
      rawBodyRequest("{not valid json", "Bearer token")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Title is required.",
    });
  });

  it("creates a DRAFT bracket with the placeholder 60-minute round duration, owned by the caller", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    const created = {
      id: "bracket-1",
      creatorId: "creator-1",
      title: "Best Sitcom",
      description: "A friendly poll.",
      visibility: "PUBLIC",
      votingRequirement: "ANONYMOUS_ALLOWED",
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
      scheduledStartAt: null,
      status: "DRAFT",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt: null,
    };
    create.mockResolvedValue(created);

    const response = await POST(postRequest(VALID_BODY, "Bearer token"));

    expect(create).toHaveBeenCalledWith({
      data: {
        creatorId: "creator-1",
        title: "Best Sitcom",
        description: "A friendly poll.",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
        defaultRoundDurationMinutes: 60,
        status: "DRAFT",
      },
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ...created,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("trims a whitespace-only description down to null, per validateCreateBracketForm", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    create.mockResolvedValue({});

    await POST(
      postRequest(
        { ...VALID_BODY, description: "   " },
        "Bearer token"
      )
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ description: null }) })
    );
  });

  it("applies CORS headers on every response - success, validation error, and unauthorized", async () => {
    getAuthenticatedUserId.mockResolvedValueOnce(null);
    const unauthorized = await POST(postRequest(VALID_BODY));
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValueOnce("creator-1");
    const invalid = await POST(postRequest({}, "Bearer token"));
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValueOnce("creator-1");
    create.mockResolvedValueOnce({});
    const success = await POST(postRequest(VALID_BODY, "Bearer token"));
    expect(success.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when bracket creation fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    create.mockRejectedValue(new Error("connection refused"));

    const response = await POST(postRequest(VALID_BODY, "Bearer token"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(postRequest(VALID_BODY));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
