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
  round: { durationMinutes: number };
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
    round: { durationMinutes: 60 },
    ...opts,
  };
}

// `voteCount` is looked up by (itemId, createdAt.gte) pair via a simple
// table, mirroring how resolveTieBreaker shapes its `prisma.vote.count`
// calls. Any call whose `createdAt.gte` doesn't match the expected
// tie-breaker-start cutoff falls through to 0, so a test can catch a wrong
// cutoff by seeding votes only "before" it and asserting the tally is 0.
function mockVotes(
  table: Record<string, number>,
  expectedGte: Date
) {
  voteCount.mockImplementation(
    async ({
      where,
    }: {
      where: { itemId: string; createdAt: { gte: Date } };
    }) => {
      if (where.createdAt.gte.getTime() !== expectedGte.getTime()) {
        return 0;
      }
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

  it("a decisive tie-breaker vote: the item with more tie-breaker-window votes wins, status becomes COMPLETED, and evaluateRound is re-run for the Matchup's round", async () => {
    const now = new Date("2026-01-01T02:00:00.000Z");
    // durationMinutes 60 -> tie-breaker window = max(15, 60) = 60 minutes,
    // so tieBreakerStartedAt = tieBreakerEndsAt - 60 minutes.
    const tieBreakerEndsAt = new Date("2026-01-01T01:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:00:00.000Z");
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 60 } })
    );
    mockVotes({ "item-a": 5, "item-b": 2 }, tieBreakerStartedAt);

    await resolveTieBreaker("matchup-1", now);

    expect(matchupFindUnique).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      include: { round: true },
    });
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });
    expect(evaluateRound).toHaveBeenCalledWith("round-1", now);
  });

  it("derives the tie-breaker start using the same 25%-of-round-duration/60-minute-floor formula evaluate-round.ts used to set tieBreakerEndsAt", async () => {
    // durationMinutes 300 -> 25% = 75 minutes, above the 60-minute floor.
    const tieBreakerEndsAt = new Date("2026-01-01T02:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:45:00.000Z"); // 75 min earlier
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 300 } })
    );
    mockVotes({ "item-a": 3, "item-b": 1 }, tieBreakerStartedAt);

    await resolveTieBreaker("matchup-1");

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });
  });

  it("excludes votes cast before the tie-breaker started from the tally", async () => {
    const tieBreakerEndsAt = new Date("2026-01-01T01:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:00:00.000Z");
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 60 } })
    );
    // Votes only exist "before" the tie-breaker window (createdAt.gte
    // wouldn't match), so both counts resolve to 0 via mockVotes' fallback -
    // simulating original-round votes being excluded rather than counted.
    mockVotes({}, tieBreakerStartedAt);

    await resolveTieBreaker("matchup-1");

    // Both calls must have used the derived tie-breaker start as their
    // cutoff - proving pre-tie-breaker votes are filtered out by construction.
    for (const call of voteCount.mock.calls) {
      const [{ where }] = call;
      expect(where.createdAt).toEqual({ gte: tieBreakerStartedAt });
      expect(where.matchupId).toBe("matchup-1");
    }
    expect(voteCount).toHaveBeenCalledTimes(2);
  });

  it("a tie-breaker that ties again falls back to a random, deterministic (mocked) pick between the two items", async () => {
    const tieBreakerEndsAt = new Date("2026-01-01T01:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:00:00.000Z");
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 60 } })
    );
    mockVotes({ "item-a": 4, "item-b": 4 }, tieBreakerStartedAt);

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

  it("a zero-zero tie-breaker tally (no votes cast during the window) also falls back to the random pick", async () => {
    const tieBreakerEndsAt = new Date("2026-01-01T01:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:00:00.000Z");
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 60 } })
    );
    mockVotes({}, tieBreakerStartedAt);

    await resolveTieBreaker("matchup-1", new Date(), () => 0.9);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "matchup-1" },
      data: { status: "COMPLETED", winnerItemId: "item-b" },
    });
  });

  it("defaults `now` to the current time and passes it through to evaluateRound", async () => {
    const before = new Date();
    const tieBreakerEndsAt = new Date("2026-01-01T01:00:00.000Z");
    const tieBreakerStartedAt = new Date("2026-01-01T00:00:00.000Z");
    matchupFindUnique.mockResolvedValue(
      makeMatchup({ tieBreakerEndsAt, round: { durationMinutes: 60 } })
    );
    mockVotes({ "item-a": 1, "item-b": 0 }, tieBreakerStartedAt);

    await resolveTieBreaker("matchup-1");

    const after = new Date();
    const usedNow = evaluateRound.mock.calls[0][1] as Date;
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedNow.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
