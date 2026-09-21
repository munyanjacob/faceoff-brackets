import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/prisma` is mocked so this suite can assert on the
// route's own orchestration (the bracket lookup, delegating to
// `listVotableMatchups`, shaping `VotableMatchupsResponse`, CORS/error
// wiring) without a live database. `listVotableMatchups` itself is *not*
// mocked - its own not-started/between-rounds/completed/votable rules are
// already covered by `../../../../brackets/[id]/voting-view-model.test.ts`;
// this suite only needs to prove this route calls it correctly and shapes
// the result per docs/openapi.yaml. End-to-end behaviour against real
// seeded data is covered separately in route.integration.test.ts, the same
// split already used by src/app/api/cron/advance-rounds.
const findUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: { bracket: { findUnique } } }));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(bracketId: string, origin: string = ALLOWED_ORIGIN) {
  return new Request(
    `http://localhost/api/brackets/${bracketId}/matchups`,
    { headers: { origin } }
  );
}

function ctx(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

function item(id: string) {
  return {
    id,
    bracketId: "bracket-1",
    title: `Item ${id}`,
    description: null,
    imageUrl: null,
    seed: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("GET /api/brackets/[bracketId]/matchups", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("returns 404 NOT_FOUND when the bracket doesn't exist", async () => {
    findUnique.mockResolvedValue(null);

    const response = await GET(requestFor("missing"), ctx("missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("queries only the ACTIVE round(s), with matchups and their items", async () => {
    findUnique.mockResolvedValue({ status: "DRAFT", rounds: [] });

    await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      include: {
        rounds: {
          where: { status: "ACTIVE" },
          include: {
            matchups: {
              orderBy: { id: "asc" },
              include: { itemA: true, itemB: true },
            },
          },
        },
      },
    });
  });

  it("returns the not-started message for a DRAFT bracket", async () => {
    findUnique.mockResolvedValue({ status: "DRAFT", rounds: [] });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    await expect(response.json()).resolves.toEqual({
      kind: "message",
      message:
        "This bracket hasn't started voting yet. Check back once it opens.",
    });
  });

  it("states the scheduled start time for a SCHEDULED bracket with scheduledStartAt", async () => {
    findUnique.mockResolvedValue({
      status: "SCHEDULED",
      scheduledStartAt: new Date("2026-03-01T15:00:00.000Z"),
      rounds: [],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.kind).toBe("message");
    expect(body.message).toContain("scheduled to begin at");
  });

  it("returns the between-rounds message when ACTIVE but no ACTIVE round exists", async () => {
    findUnique.mockResolvedValue({ status: "ACTIVE", rounds: [] });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    await expect(response.json()).resolves.toEqual({
      kind: "message",
      message:
        "Voting isn't open right now - check back soon for the next round.",
    });
  });

  it("returns the between-rounds message when the ACTIVE round has no votable matchup", async () => {
    findUnique.mockResolvedValue({
      status: "ACTIVE",
      rounds: [{ status: "ACTIVE", matchups: [] }],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    await expect(response.json()).resolves.toEqual({
      kind: "message",
      message:
        "Voting isn't open right now - check back soon for the next round.",
    });
  });

  it("returns the completed message for a COMPLETED bracket", async () => {
    findUnique.mockResolvedValue({ status: "COMPLETED", rounds: [] });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    await expect(response.json()).resolves.toEqual({
      kind: "message",
      message: "This bracket has finished. Voting is closed.",
    });
  });

  it("returns kind:matchups with every votable matchup's full MatchupSummary shape", async () => {
    const itemA = item("item-a");
    const itemB = item("item-b");
    findUnique.mockResolvedValue({
      status: "ACTIVE",
      rounds: [
        {
          status: "ACTIVE",
          matchups: [
            { id: "matchup-1", status: "ACTIVE", itemA, itemB },
            { id: "matchup-2", status: "TIE_BREAKER", itemA: item("item-c"), itemB: item("item-d") },
          ],
        },
      ],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.kind).toBe("matchups");
    expect(body.matchups).toHaveLength(2);
    expect(body.matchups[0]).toEqual({
      id: "matchup-1",
      status: "ACTIVE",
      itemA: { ...itemA, createdAt: itemA.createdAt.toISOString() },
      itemB: { ...itemB, createdAt: itemB.createdAt.toISOString() },
    });
    expect(body.matchups[1].id).toBe("matchup-2");
  });

  it("excludes a bye (itemB null) or otherwise-incomplete matchup from the list", async () => {
    findUnique.mockResolvedValue({
      status: "ACTIVE",
      rounds: [
        {
          status: "ACTIVE",
          matchups: [
            { id: "bye-matchup", status: "ACTIVE", itemA: item("item-a"), itemB: null },
            { id: "pending-matchup", status: "PENDING", itemA: item("item-b"), itemB: item("item-c") },
          ],
        },
      ],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body).toEqual({
      kind: "message",
      message:
        "Voting isn't open right now - check back soon for the next round.",
    });
  });

  it("applies CORS headers to a success response", async () => {
    findUnique.mockResolvedValue({ status: "DRAFT", rounds: [] });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
  });

  it("applies CORS headers to a 404 error response", async () => {
    findUnique.mockResolvedValue(null);

    const response = await GET(requestFor("missing"), ctx("missing"));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns the generic UNEXPECTED 500, with CORS headers, when the lookup throws", async () => {
    findUnique.mockRejectedValue(new Error("db exploded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

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

describe("OPTIONS /api/brackets/[bracketId]/matchups", () => {
  it("returns a 204 CORS preflight response", async () => {
    const response = OPTIONS(requestFor("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(await response.text()).toBe("");
  });
});
