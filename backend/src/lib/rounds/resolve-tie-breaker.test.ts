import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked Prisma client (matchup.findUnique/vote.count/matchup.update) and a
// mocked evaluateRound, same "every dependency is its own vi.fn()"
// convention as `evaluate-round.test.ts`. This keeps this suite unit-level:
// it asserts on resolveTieBreaker's own vote-tallying/outcome/wiring logic
// without a live database and without re-testing evaluateRound's internals
// (that's evaluate-round.test.ts's job) - resolveTieBreaker is only
// expected to *call* it correctly.
const matchupFindUnique = vi.fn();
const voteCount = vi.fn();
const matchupUpdate = vi.fn();
const evaluateRound = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findUnique: matchupFindUnique, update: matchupUpdate },
    vote: { count: voteCount },
  },
}));
vi.mock("@/lib/rounds/evaluate-round", () => ({ evaluateRound }));

const { resolveTieBreaker } = await import("./resolve-tie-breaker");

type MatchupFixture = {
  id: string;
  roundId: string;
  itemAId: string | null;
  itemBId: string | null;
  winnerItemId: string | null;
  status: "PENDING" | "ACTIVE" | "TIE_BREAKER" | "COMPLETED";
  tieBreakerEndsAt: Date | null;
};

function makeMatchup(opts: Partial<MatchupFixture> = {}): MatchupFixture {
  return {
    id: "matchup-1",
    roundId: "round-1",
    itemAId: "item-a",
    itemBId: "item-b",
    winnerItemId: null,
    status: "TIE_BREAKER",
    tieBreakerEndsAt: new Date("2026-01-01T01:00:00.000Z"),
    ...opts,
  };
}

// Issue #41: `voteCount` is looked up by (itemId, phase) pair, mirroring how
// resolveTieBreaker now shapes its `prisma.vote.count` calls - only a
// TIE_BREAKER-phase call for a given item returns its seeded tally; any
// other phase (or a call that's missing the phase filter entirely, where
// `where.phase` would be `undefined`) falls through to 0. This is what lets
// a test catch a missing/wrong phase filter by seeding votes and asserting
// the tally isn't 0.
function mockVotes(table: Record<string, number>) {
  voteCount.mockImplementation(
    async ({ where }: { where: { itemId: string; phase?: string } }) => {
      if (where.phase !== "TIE_BREAKER") return 0;
      return table[where.itemId] ?? 0;
    }
  );
}

describe("resolveTieBreaker", () => {
  beforeEach(() => {
    matchupFindUnique.mockReset();
    voteCount.mockReset();
    matchupUpdate.mockReset();
    evaluateRound.mockReset().mockResolvedValue(undefined);
  });

  it("throws when no Matchup exists for the given id", async () => {
    matchupFindUnique.mockResolvedValue(null);

    await expect(resolveTieBreaker("missing-matchup")).rejects.toThrow(
      /no Matchup found/
    );
  });

  it("is a no-op when the Matchup is no longer TIE_BREAKER (already resolved)", async () => {
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ status: "COMPLETED", winnerItemId: "item-a" })
    );

    await resolveTieBreaker("matchup-1");

    expect(voteCount).not.toHaveBeenCalled();
    expect(matchupUpdate).not.toHaveBeenCalled();
    expect(evaluateRound).not.toHaveBeenCalled();
  });

  it("throws when TIE_BREAKER but missing itemAId/itemBId/tieBreakerEndsAt", async () => {
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ itemBId: null })
    );

    await expect(resolveTieBreaker("matchup-1")).rejects.toThrow(
      /missing itemAId\/itemBId\/tieBreakerEndsAt/
    );
  });

  it("a decisive tie-breaker vote: the item with more TIE_BREAKER-phase votes wins, status becomes COMPLETED, and evaluateRound is re-run for the Matchup's round", async () => {
    const now = new Date("2026-01-01T02:00:00.000Z");
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({ "item-a": 5, "item-b": 2 });

    await resolveTieBreaker("matchup-1", now);

    expect(matchupFindUnique).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
    });
    expect(voteCount).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", itemId: "item-a", phase: "TIE_BREAKER" },
    });
    expect(voteCount).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", itemId: "item-b", phase: "TIE_BREAKER" },
    });
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });
    expect(evaluateRound).toHaveBeenCalledWith("round-1", now);
  });

  it("counts only TIE_BREAKER-phase votes for both items - a call missing that filter (or using another phase) never contributes to the tally", async () => {
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({ "item-a": 3, "item-b": 1 });

    await resolveTieBreaker("matchup-1");

    for (const call of voteCount.mock.calls) {
      const [{ where }] = call;
      expect(where.phase).toBe("TIE_BREAKER");
      expect(where.matchupId).toBe("matchup-1");
    }
    expect(voteCount).toHaveBeenCalledTimes(2);
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });
  });

  it("issue #41: tallies only the TIE_BREAKER-phase vote even when an ORIGINAL-phase vote (e.g. from a voter who revoted) favored the other item", async () => {
    // Simulates the real-world shape after #41: a voter's ORIGINAL-phase
    // vote (favoring item-a, per the plain `Vote` rows a real DB would hold)
    // stays in the table but is invisible to this tally, which only ever
    // asks the mock about TIE_BREAKER-phase counts - item-b is the seeded
    // TIE_BREAKER-phase winner here regardless of what happened in the
    // original round.
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({ "item-a": 1, "item-b": 4 });

    await resolveTieBreaker("matchup-1");

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-b" },
    });
  });

  it("a tie-breaker that ties again falls back to a random, deterministic (mocked) pick between the two items", async () => {
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({ "item-a": 4, "item-b": 4 });

    const randomLow = () => 0.1; // < 0.5 -> itemA
    await resolveTieBreaker("matchup-1", new Date(), randomLow);
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });

    matchupUpdate.mockClear();
    const randomHigh = () => 0.9; // >= 0.5 -> itemB
    await resolveTieBreaker("matchup-1", new Date(), randomHigh);
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-b" },
    });
  });

  it("a zero-zero tie-breaker tally (no TIE_BREAKER-phase votes cast) also falls back to the random pick", async () => {
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({});

    await resolveTieBreaker("matchup-1", new Date(), () => 0.9);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-b" },
    });
  });

  it("defaults `now` to the current time and passes it through to evaluateRound", async () => {
    const before = new Date();
    matchupFindUnique.mockResolvedValue(makeMatchup());
    mockVotes({ "item-a": 1, "item-b": 0 });

    await resolveTieBreaker("matchup-1");

    const after = new Date();
    const usedNow = evaluateRound.mock.calls[0][1] as Date;
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedNow.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
