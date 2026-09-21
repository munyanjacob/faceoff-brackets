import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - that lookup is by `id`
// alone (never creator-scoped, since this is a public endpoint), the 404
// body, and that `viewerIsOwner` is only true when the caller's resolved
// user id matches this bracket's `creatorId` - without a live database or a
// real Supabase token. End-to-end behaviour against real seeded data is
// covered separately in `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { bracket: { findUnique } },
}));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(bracketId: string, authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(`http://localhost/brackets/${bracketId}`, { headers });
}

function paramsFor(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

const BRACKET = {
  id: "bracket-1",
  creatorId: "creator-1",
  title: "Best Sitcom",
  description: null,
  visibility: "PUBLIC",
  votingRequirement: "ANONYMOUS_ALLOWED",
  defaultRoundDurationMinutes: 60,
  roundDurationOverrides: null,
  scheduledStartAt: null,
  status: "DRAFT",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: null,
  creator: { displayName: "Jane" },
};

describe("GET /brackets/{bracketId}", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findUnique.mockReset();
  });

  it("looks the bracket up by id alone - never scoped to a caller's creatorId", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue(BRACKET);

    await GET(requestFor("bracket-1"), paramsFor("bracket-1"));

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      include: { creator: { select: { displayName: true } } },
    });
  });

  it("returns 404 NOT_FOUND when the bracket doesn't exist", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue(null);

    const response = await GET(
      requestFor("missing"),
      paramsFor("missing")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("works for an anonymous caller - 200 with viewerIsOwner: false, no auth required", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue(BRACKET);

    const response = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.viewerIsOwner).toBe(false);
    expect(body.creator).toEqual({ displayName: "Jane" });
  });

  it("returns viewerIsOwner: true only when the authenticated caller is this bracket's own creator", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findUnique.mockResolvedValue(BRACKET);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    const body = await response.json();
    expect(body.viewerIsOwner).toBe(true);
  });

  it("returns viewerIsOwner: false when authenticated as a different user", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    findUnique.mockResolvedValue(BRACKET);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    const body = await response.json();
    expect(body.viewerIsOwner).toBe(false);
  });

  it("includes every Bracket field alongside creator/viewerIsOwner", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    findUnique.mockResolvedValue(BRACKET);

    const response = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));
    const body = await response.json();

    expect(body).toEqual({
      ...BRACKET,
      createdAt: "2026-01-01T00:00:00.000Z",
      viewerIsOwner: false,
    });
  });

  it("applies CORS headers on both the 200 and 404 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    findUnique.mockResolvedValue(BRACKET);
    const ok = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    findUnique.mockResolvedValue(null);
    const notFound = await GET(requestFor("missing"), paramsFor("missing"));
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when the lookup fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue(null);
    findUnique.mockRejectedValue(new Error("connection refused"));

    const response = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(requestFor("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
