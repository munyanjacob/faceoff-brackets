import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `prisma.bracket.findMany` is mocked so this suite can assert
// on the route's own orchestration (calling `groupPublicBrackets`,
// reshaping `publishedAt` back to a raw ISO string for the wire, applying
// CORS to every response, the generic-500 fallback) without a live
// database. End-to-end behaviour against real seeded data (the actual
// `where`/`orderBy` really filtering/ordering correctly) is covered
// separately in `route.integration.test.ts`, the same split already used
// by `../../discover/discover-query.integration.test.ts`.
const findMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { bracket: { findMany } },
}));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function bracket(overrides: {
  id: string;
  title: string;
  visibility: "PUBLIC" | "PRIVATE";
  status: "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";
  publishedAt: Date | null;
  displayName: string | null;
}) {
  return {
    id: overrides.id,
    title: overrides.title,
    visibility: overrides.visibility,
    status: overrides.status,
    publishedAt: overrides.publishedAt,
    creator: { displayName: overrides.displayName },
  };
}

function requestFromOrigin(origin: string = ALLOWED_ORIGIN) {
  const headers = new Headers({ origin });
  return new Request("http://localhost/api/discover", { headers });
}

describe("GET /api/discover", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("queries only PUBLIC, published brackets, ordered newest-published-first", async () => {
    findMany.mockResolvedValue([]);

    await GET(requestFromOrigin());

    expect(findMany).toHaveBeenCalledWith({
      where: {
        visibility: "PUBLIC",
        status: { in: ["SCHEDULED", "ACTIVE", "COMPLETED"] },
      },
      orderBy: { publishedAt: "desc" },
      include: { creator: { select: { displayName: true } } },
    });
  });

  it("returns 200 with empty groups when there are no public brackets", async () => {
    findMany.mockResolvedValue([]);

    const response = await GET(requestFromOrigin());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recent: [],
      active: [],
      completed: [],
    });
  });

  it("buckets a SCHEDULED bracket into 'recent' - published but voting hasn't started", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "s1",
        title: "Scheduled Bracket",
        visibility: "PUBLIC",
        status: "SCHEDULED",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
        displayName: "Jane",
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.recent).toEqual([
      {
        id: "s1",
        title: "Scheduled Bracket",
        status: "SCHEDULED",
        publishedAt: "2026-09-10T12:00:00.000Z",
        creatorName: "Jane",
      },
    ]);
    expect(body.active).toEqual([]);
    expect(body.completed).toEqual([]);
  });

  it("buckets ACTIVE and COMPLETED brackets into their own groups, never 'recent'", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "a1",
        title: "Active Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
        displayName: "Sam",
      }),
      bracket({
        id: "c1",
        title: "Completed Bracket",
        visibility: "PUBLIC",
        status: "COMPLETED",
        publishedAt: new Date("2026-08-01T12:00:00.000Z"),
        displayName: "Sam",
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.recent).toEqual([]);
    expect(body.active.map((row: { id: string }) => row.id)).toEqual(["a1"]);
    expect(body.completed.map((row: { id: string }) => row.id)).toEqual([
      "c1",
    ]);
  });

  it("never returns a PRIVATE bracket, even if its status matches a group", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "p1",
        title: "Private Bracket",
        visibility: "PRIVATE",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
        displayName: "Sam",
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.recent).toEqual([]);
    expect(body.active).toEqual([]);
    expect(body.completed).toEqual([]);
  });

  it("falls back to 'A creator' when the creator has no displayName", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "b1",
        title: "No Name Creator Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
        displayName: null,
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.active[0].creatorName).toBe("A creator");
  });

  it("returns publishedAt as a raw ISO-8601 timestamp, not a human-formatted string", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "b2",
        title: "Bracket",
        visibility: "PUBLIC",
        status: "COMPLETED",
        publishedAt: new Date("2026-01-15T12:00:00.000Z"),
        displayName: "Sam",
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.completed[0].publishedAt).toBe("2026-01-15T12:00:00.000Z");
    expect(body.completed[0].publishedAt).not.toBe("January 15, 2026");
  });

  it("returns publishedAt: null (not '-') when the bracket has no publishedAt", async () => {
    findMany.mockResolvedValue([
      bracket({
        id: "b3",
        title: "Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: null,
        displayName: "Sam",
      }),
    ]);

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(body.active[0].publishedAt).toBeNull();
  });

  it("applies CORS headers to a successful response", async () => {
    findMany.mockResolvedValue([]);

    const response = await GET(requestFromOrigin());

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
  });

  it("omits Access-Control-Allow-Origin for a non-matching origin, but still 200s", async () => {
    findMany.mockResolvedValue([]);

    const response = await GET(requestFromOrigin("https://evil.example.com"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns the generic UNEXPECTED 500, with CORS headers, when the query throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValue(new Error("connection reset"));

    const response = await GET(requestFromOrigin());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("connection reset");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    consoleSpy.mockRestore();
  });
});

describe("OPTIONS /api/discover", () => {
  it("returns a 204 preflight response with CORS headers", async () => {
    const response = OPTIONS(requestFromOrigin());

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(await response.text()).toBe("");
  });
});
