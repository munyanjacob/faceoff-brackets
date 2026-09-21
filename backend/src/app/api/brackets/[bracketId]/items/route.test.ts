import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - the auth gate, that the
// bracket lookup is scoped to `id AND creatorId` together (never `id`
// alone), that "doesn't exist" and "exists but not owned" both collapse to
// the same 404 body (spec §4.9), and the items query's ordering - without a
// live database. End-to-end behaviour against real seeded data is covered
// separately in `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst },
    bracketItem: { findMany },
  },
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
  return new Request(`http://localhost/brackets/${bracketId}/items`, {
    headers,
  });
}

function paramsFor(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

describe("GET /brackets/{bracketId}/items", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findFirst.mockReset();
    findMany.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before ever looking the bracket up", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await GET(requestFor("bracket-1"), paramsFor("bracket-1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the bracket lookup to id AND creatorId together, never id alone", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockResolvedValue([]);

    await GET(requestFor("bracket-1", "Bearer token"), paramsFor("bracket-1"));

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);

    const response = await GET(
      requestFor("missing", "Bearer token"),
      paramsFor("missing")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the exact same 404 body when the bracket exists but belongs to a different creator (indistinguishable by design)", async () => {
    getAuthenticatedUserId.mockResolvedValue("someone-else");
    // The scoped findFirst() itself returns null for a bracket owned by a
    // different creator - this route never sees "exists but not mine" as a
    // distinct case, which is the whole point of scoping the query this way.
    findFirst.mockResolvedValue(null);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("returns 200 with the bracket's items in creation order", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    const items = [
      {
        id: "item-1",
        bracketId: "bracket-1",
        title: "Item One",
        description: null,
        imageUrl: null,
        seed: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    findMany.mockResolvedValue(items);

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { ...items[0], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("applies CORS headers on the 401, 404, and 200 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await GET(
      requestFor("bracket-1"),
      paramsFor("bracket-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);
    const notFound = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockResolvedValue([]);
    const ok = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when the items query fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ id: "bracket-1", creatorId: "creator-1" });
    findMany.mockRejectedValue(new Error("connection refused"));

    const response = await GET(
      requestFor("bracket-1", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}/items", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(requestFor("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
