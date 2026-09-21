import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/prisma` is mocked so this suite can assert on the
// route's own orchestration (matchup lookup scoped to the bracket, the
// not_completed short-circuit, the vote-count/comment queries, and the
// MatchupResultState -> wire MatchupResult mapping) without a live database.
// `buildMatchupResultState` itself is *not* mocked - it's already covered by
// `.../matchups/[matchupId]/result/matchup-result-view-model.test.ts`; this
// suite only needs to prove this route calls it correctly and shapes the
// result per docs/openapi.yaml. End-to-end behaviour against real seeded
// data (including real Postgres vote rows across both vote phases) is
// covered separately in route.integration.test.ts.
const matchupFindFirst = vi.fn();
const bracketFindUnique = vi.fn();
const voteCount = vi.fn();
const voteFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findFirst: matchupFindFirst },
    bracket: { findUnique: bracketFindUnique },
    vote: { count: voteCount, findMany: voteFindMany },
  },
}));

const { GET, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(bracketId: string, matchupId: string, origin: string = ALLOWED_ORIGIN) {
  return new Request(
    `http://localhost/api/brackets/${bracketId}/matchups/${matchupId}/result`,
    { headers: { origin } }
  );
}

function ctx(bracketId: string, matchupId: string) {
  return { params: Promise.resolve({ bracketId, matchupId }) };
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

function baseMatchup(overrides: Record<string, unknown> = {}) {
  return {
    id: "matchup-1",
    status: "COMPLETED",
    itemAId: "item-a",
    itemBId: "item-b",
    winnerItemId: "item-a",
    tieBreakerEndsAt: null,
    itemA: item("item-a"),
    itemB: item("item-b"),
    ...overrides,
  };
}

describe("GET /api/brackets/[bracketId]/matchups/[matchupId]/result", () => {
  beforeEach(() => {
    matchupFindFirst.mockReset();
    bracketFindUnique.mockReset();
    voteCount.mockReset().mockResolvedValue(0);
    voteFindMany.mockReset().mockResolvedValue([]);
  });

  it("scopes the matchup lookup to the given bracketId via its round", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    await GET(requestFor("bracket-1", "matchup-1"), ctx("bracket-1", "matchup-1"));

    expect(matchupFindFirst).toHaveBeenCalledWith({
      where: { id: "matchup-1", round: { bracketId: "bracket-1" } },
      include: { itemA: true, itemB: true },
    });
  });

  it("returns 404 'This matchup no longer exists.' when the bracket exists but the matchup id doesn't match it", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue({ id: "bracket-1" });

    const response = await GET(
      requestFor("bracket-1", "missing-matchup"),
      ctx("bracket-1", "missing-matchup")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This matchup no longer exists.",
    });
  });

  it("returns 404 'This bracket no longer exists.' when the bracket itself doesn't exist", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(
      requestFor("missing-bracket", "matchup-1"),
      ctx("missing-bracket", "matchup-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it.each(["PENDING", "ACTIVE", "TIE_BREAKER"])(
    "returns {kind: 'not_completed'} for a %s matchup, without querying votes/comments",
    async (status) => {
      matchupFindFirst.mockResolvedValue(baseMatchup({ status }));

      const response = await GET(
        requestFor("bracket-1", "matchup-1"),
        ctx("bracket-1", "matchup-1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ kind: "not_completed" });
      expect(voteCount).not.toHaveBeenCalled();
      expect(voteFindMany).not.toHaveBeenCalled();
    }
  );

  it("returns the bye variant (no vote tally, no matchupId) for a COMPLETED bye matchup", async () => {
    matchupFindFirst.mockResolvedValue(
      baseMatchup({ itemBId: null, itemB: null, winnerItemId: "item-a" })
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      kind: "bye",
      advancingItem: { ...item("item-a"), createdAt: item("item-a").createdAt.toISOString() },
    });
    expect(voteCount).not.toHaveBeenCalled();
  });

  it("returns the decided variant with winner/loser and vote counts, decidedByTieBreaker false for a clean decision", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());
    voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
      where.itemId === "item-a" ? 5 : 2
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.kind).toBe("decided");
    expect(body.winner.id).toBe("item-a");
    expect(body.winnerVoteCount).toBe(5);
    expect(body.loser.id).toBe("item-b");
    expect(body.loserVoteCount).toBe(2);
    expect(body.decidedByTieBreaker).toBe(false);
    expect(body.comments).toEqual([]);
    // No matchupId on the wire MatchupResult - it's already in the URL.
    expect(body).not.toHaveProperty("matchupId");
  });

  it("marks decidedByTieBreaker true once tieBreakerEndsAt is set, but still reports the combined (unfiltered-by-phase) vote count", async () => {
    matchupFindFirst.mockResolvedValue(
      baseMatchup({ tieBreakerEndsAt: new Date("2026-03-01T00:00:00.000Z") })
    );
    voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
      where.itemId === "item-a" ? 4 : 3
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.decidedByTieBreaker).toBe(true);
    // The count query itself must not filter by phase at all - the "combined
    // total across both ORIGINAL and TIE_BREAKER phases" docs/openapi.yaml
    // requires regardless of decidedByTieBreaker.
    expect(voteCount).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", itemId: "item-a" },
    });
    expect(voteCount).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", itemId: "item-b" },
    });
    expect(body.winnerVoteCount).toBe(4);
    expect(body.loserVoteCount).toBe(3);
  });

  it("includes comments shaped as MatchupComment {id, itemId, comment, createdAt}", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());
    voteFindMany.mockResolvedValue([
      {
        id: "vote-1",
        itemId: "item-a",
        comment: "great pick",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.comments).toEqual([
      {
        id: "vote-1",
        itemId: "item-a",
        comment: "great pick",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(voteFindMany).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", comment: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, itemId: true, comment: true, createdAt: true },
    });
  });

  it("falls back to {kind: 'not_completed'} for a defensive 'unresolved' state (COMPLETED matchup missing winnerItemId)", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup({ winnerItemId: null }));

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ kind: "not_completed" });
  });

  it("applies CORS headers to a success response", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("applies CORS headers to a 404 error response", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("returns the generic UNEXPECTED 500, with CORS headers, when the lookup throws", async () => {
    matchupFindFirst.mockRejectedValue(new Error("db exploded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    consoleError.mockRestore();
  });
});

describe("OPTIONS /api/brackets/[bracketId]/matchups/[matchupId]/result", () => {
  it("returns a 204 CORS preflight response", async () => {
    const response = OPTIONS(requestFor("bracket-1", "matchup-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(await response.text()).toBe("");
  });
});
