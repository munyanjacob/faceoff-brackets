import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/prisma` is mocked so this suite can assert on the
// route's own orchestration (the bracket lookup, the "no rounds yet ->
// synthesize NOT_STARTED placeholders" branch, the wire-shape mapping of
// buildBracketTree's/buildChampion's output, and the round-status lookup)
// without a live database. `buildBracketTree`/`buildChampion` themselves are
// *not* mocked - their own placeholder/bye/completed/active/pending and
// champion rules are already covered by
// `.../tree/bracket-tree-view-model.test.ts` and
// `.../tree/champion-view-model.test.ts`; this suite only needs to prove
// this route calls them correctly and shapes the result per
// docs/openapi.yaml. End-to-end behaviour against real seeded data is
// covered separately in route.integration.test.ts.
const bracketFindUnique = vi.fn();
const bracketItemCount = vi.fn();
const voteCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique: bracketFindUnique },
    bracketItem: { count: bracketItemCount },
    vote: { count: voteCount },
  },
}));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(bracketId: string, origin: string = ALLOWED_ORIGIN) {
  return new Request(`http://localhost/api/brackets/${bracketId}/tree`, {
    headers: { origin },
  });
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

describe("GET /api/brackets/[bracketId]/tree", () => {
  beforeEach(() => {
    bracketFindUnique.mockReset();
    bracketItemCount.mockReset().mockResolvedValue(0);
    voteCount.mockReset().mockResolvedValue(0);
  });

  it("returns 404 NOT_FOUND when the bracket doesn't exist", async () => {
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(requestFor("missing"), ctx("missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("queries every round (not just ACTIVE), oldest-first, with matchups in bracket order", async () => {
    bracketFindUnique.mockResolvedValue({
      title: "T",
      status: "DRAFT",
      rounds: [],
    });

    await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(bracketFindUnique).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      include: {
        rounds: {
          orderBy: { roundNumber: "asc" },
          include: {
            matchups: {
              orderBy: { itemA: { createdAt: "asc" } },
              include: { itemA: true, itemB: true },
            },
          },
        },
      },
    });
  });

  it("synthesizes NOT_STARTED placeholder rounds with empty cells when no Round rows exist yet (e.g. DRAFT)", async () => {
    bracketFindUnique.mockResolvedValue({ title: "Draft Bracket", status: "DRAFT", rounds: [] });
    bracketItemCount.mockResolvedValue(4); // ceil(log2(4)) = 2 rounds.

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bracketTitle).toBe("Draft Bracket");
    expect(body.bracketStatus).toBe("DRAFT");
    expect(body.totalRounds).toBe(2);
    expect(body.rounds).toEqual([
      { roundNumber: 1, status: "NOT_STARTED", label: "Semifinal", cells: [] },
      { roundNumber: 2, status: "NOT_STARTED", label: "Final", cells: [] },
    ]);
    expect(body.champion).toBeNull();
  });

  it("synthesizes at least one placeholder round even with fewer than 2 items", async () => {
    bracketFindUnique.mockResolvedValue({ title: "Empty Draft", status: "DRAFT", rounds: [] });
    bracketItemCount.mockResolvedValue(0);

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.rounds).toEqual([
      { roundNumber: 1, status: "NOT_STARTED", label: "Final", cells: [] },
    ]);
  });

  it("maps a real round's cells to the wire MatchupCell union with matchupId, and resolves round status from the real Round row", async () => {
    bracketFindUnique.mockResolvedValue({
      title: "Live Bracket",
      status: "ACTIVE",
      rounds: [
        {
          roundNumber: 1,
          status: "COMPLETED",
          matchups: [
            { id: "m-bye", status: "COMPLETED", itemA: item("a"), itemB: null, winnerItemId: null },
            {
              id: "m-done",
              status: "COMPLETED",
              itemA: item("b"),
              itemB: item("c"),
              winnerItemId: "b",
            },
          ],
        },
        {
          roundNumber: 2,
          status: "ACTIVE",
          matchups: [
            {
              id: "m-active",
              status: "TIE_BREAKER",
              itemA: item("a"),
              itemB: item("b"),
              winnerItemId: null,
            },
          ],
        },
      ],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.totalRounds).toBe(2);
    expect(body.rounds[0].status).toBe("COMPLETED");
    expect(body.rounds[0].cells[0]).toEqual({
      kind: "bye",
      matchupId: "m-bye",
      advancingItem: { ...item("a"), createdAt: item("a").createdAt.toISOString() },
    });
    expect(body.rounds[0].cells[1]).toEqual({
      kind: "completed",
      matchupId: "m-done",
      winner: { ...item("b"), createdAt: item("b").createdAt.toISOString() },
      loser: { ...item("c"), createdAt: item("c").createdAt.toISOString() },
    });
    expect(body.rounds[1].status).toBe("ACTIVE");
    expect(body.rounds[1].cells[0]).toEqual({
      kind: "active",
      matchupId: "m-active",
      itemA: { ...item("a"), createdAt: item("a").createdAt.toISOString() },
      itemB: { ...item("b"), createdAt: item("b").createdAt.toISOString() },
      isTieBreaker: true,
    });
  });

  it("gives every synthesized 'upcoming' cell its round's own label, and marks that round NOT_STARTED", async () => {
    bracketFindUnique.mockResolvedValue({
      title: "In Progress",
      status: "ACTIVE",
      rounds: [
        {
          roundNumber: 1,
          status: "COMPLETED",
          matchups: [
            { id: "m1", status: "COMPLETED", itemA: item("a"), itemB: item("b"), winnerItemId: "a" },
            { id: "m2", status: "COMPLETED", itemA: item("c"), itemB: item("d"), winnerItemId: "c" },
          ],
        },
      ],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    // Round 1 has 2 matchups -> total rounds computed as ceil(log2(4)) = 2,
    // so round 2 is synthesized as an "upcoming"-only placeholder column.
    expect(body.rounds).toHaveLength(2);
    const round2 = body.rounds[1];
    expect(round2.status).toBe("NOT_STARTED");
    expect(round2.label).toBe("Final");
    expect(round2.cells).toEqual([{ kind: "upcoming", label: "Final" }]);
  });

  it("omits champion entirely (null) when the bracket isn't COMPLETED", async () => {
    bracketFindUnique.mockResolvedValue({
      title: "Active",
      status: "ACTIVE",
      rounds: [
        {
          roundNumber: 1,
          status: "ACTIVE",
          matchups: [{ id: "m1", status: "ACTIVE", itemA: item("a"), itemB: item("b"), winnerItemId: null }],
        },
      ],
    });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.champion).toBeNull();
    expect(voteCount).not.toHaveBeenCalled();
  });

  it("includes champion {item, finalTally} once COMPLETED, with a real vote-count query for the final matchup", async () => {
    bracketFindUnique.mockResolvedValue({
      title: "Done",
      status: "COMPLETED",
      rounds: [
        {
          roundNumber: 1,
          status: "COMPLETED",
          matchups: [{ id: "final", status: "COMPLETED", itemA: item("a"), itemB: item("b"), winnerItemId: "a" }],
        },
      ],
    });
    voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
      where.itemId === "a" ? 9 : 4
    );

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));
    const body = await response.json();

    expect(body.champion).toEqual({
      item: { ...item("a"), createdAt: item("a").createdAt.toISOString() },
      finalTally: [
        { item: { ...item("a"), createdAt: item("a").createdAt.toISOString() }, votes: 9 },
        { item: { ...item("b"), createdAt: item("b").createdAt.toISOString() }, votes: 4 },
      ],
    });
  });

  it("applies CORS headers to a success response", async () => {
    bracketFindUnique.mockResolvedValue({ title: "T", status: "DRAFT", rounds: [] });

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("applies CORS headers to a 404 error response", async () => {
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("returns the generic UNEXPECTED 500, with CORS headers, when the lookup throws", async () => {
    bracketFindUnique.mockRejectedValue(new Error("db exploded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(requestFor("bracket-1"), ctx("bracket-1"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    consoleError.mockRestore();
  });
});

describe("OPTIONS /api/brackets/[bracketId]/tree", () => {
  it("returns a 204 CORS preflight response", async () => {
    const response = OPTIONS(requestFor("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(await response.text()).toBe("");
  });
});
