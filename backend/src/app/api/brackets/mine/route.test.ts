import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are both mocked so this
// suite can assert on the route's own orchestration (auth gate, the exact
// query shape, the response status/CORS headers) without a live database or
// a real Supabase token round-trip - `getAuthenticatedUserId`/`corsHeaders`
// already have their own dedicated unit suites (`../../../../lib/api/auth.test.ts`,
// `../../../../lib/api/cors.test.ts`). End-to-end behaviour against real
// seeded data is covered separately in `./route.integration.test.ts`, the
// same split already used by `../../cron/advance-rounds/route.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { bracket: { findMany } },
}));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestWithAuth(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request("http://localhost/brackets/mine", { headers });
}

describe("GET /brackets/mine", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findMany.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await GET(requestWithAuth());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries only the caller's own brackets, newest first, with the minimal rounds summary", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findMany.mockResolvedValue([]);

    await GET(requestWithAuth("Bearer token"));

    expect(findMany).toHaveBeenCalledWith({
      where: { creatorId: "creator-1" },
      orderBy: { createdAt: "desc" },
      include: { rounds: { select: { roundNumber: true } } },
    });
  });

  it("returns 200 with the brackets as the query resolves them, normalizing a null roundDurationOverrides to {}", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    const brackets = [
      {
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
        rounds: [],
      },
    ];
    findMany.mockResolvedValue(brackets);

    const response = await GET(requestWithAuth("Bearer token"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      {
        ...brackets[0],
        roundDurationOverrides: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("applies CORS headers to a successful response", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findMany.mockResolvedValue([]);

    const response = await GET(requestWithAuth("Bearer token"));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
  });

  it("applies CORS headers to the 401 response", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await GET(requestWithAuth());

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 (with CORS headers) when the query fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findMany.mockRejectedValue(new Error("connection refused"));

    const response = await GET(requestWithAuth("Bearer token"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/mine", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(requestWithAuth());

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
