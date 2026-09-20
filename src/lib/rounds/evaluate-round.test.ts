import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked Prisma client, same shape/convention as
// `../../app/dashboard/brackets/[id]/edit/publish-actions.test.ts`: every
// method `evaluateRound` calls is its own `vi.fn()`, and `$transaction` runs
// its callback against a `tx` client built from the same mocks, so
// assertions can keep asserting directly against `roundUpdate`/
// `bracketUpdate`/`roundCreate`.
const roundFindUnique = vi.fn();
const voteCount = vi.fn();
const matchupUpdate = vi.fn();
const roundUpdate = vi.fn();
const bracketUpdate = vi.fn();
const roundCreate = vi.fn();

const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    round: { update: roundUpdate, create: roundCreate },
    bracket: { update: bracketUpdate },
  })
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    round: { findUnique: roundFindUnique },
    vote: { count: voteCount },
    matchup: { update: matchupUpdate },
    $transaction: transaction,
  },
}));

const { evaluateRound } = await import("./evaluate-round");

type MatchupFixture = {
  id: string;
  itemAId: string | null;
  itemBId: string | null;
  winnerItemId: string | null;
  status: "PENDING" | "ACTIVE" | "TIE_BREAKER" | "COMPLETED";
  tieBreakerEndsAt: Date | null;
};

function makeRound(opts: {
  id?: string;
  bracketId?: string;
  roundNumber?: number;
  durationMinutes?: number;
  status?: "PENDING" | "ACTIVE" | "COMPLETED";
  matchups: MatchupFixture[];
  bracket?: {
    defaultRoundDurationMinutes?: number;
    roundDurationOverrides?: unknown;
  };
}) {
  return {
    id: opts.id ?? "round-1",
    bracketId: opts.bracketId ?? "bracket-1",
    roundNumber: opts.roundNumber ?? 1,
    durationMinutes: opts.durationMinutes ?? 60,
    status: opts.status ?? "ACTIVE",
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: new Date("2026-01-01T01:00:00.000Z"),
    matchups: opts.matchups,
    bracket: {
      id: opts.bracketId ?? "bracket-1",
      defaultRoundDurationMinutes:
        opts.bracket?.defaultRoundDurationMinutes ?? 60,
      roundDurationOverrides: opts.bracket?.roundDurationOverrides ?? null,
    },
  };
}

// `voteCount` is looked up by (matchupId, itemId) pair via a simple table,
// mirroring how the real `prisma.vote.count` call is shaped in
// `evaluateRound`.
function mockVotes(table: Record<string, Record<string, number>>) {
  voteCount.mockImplementation(
    async ({ where }: { where: { matchupId: string; itemId: string } }) =>
      table[where.matchupId]?.[where.itemId] ?? 0
  );
}

describe("evaluateRound", () => {
  beforeEach(() => {
    roundFindUnique.mockReset();
    voteCount.mockReset();
    matchupUpdate.mockReset();
    roundUpdate.mockReset();
    bracketUpdate.mockReset();
    roundCreate.mockReset();
    transaction.mockClear();
  });

  it("is a no-op when the Round is already COMPLETED", async () => {
    roundFindUnique.mockResolvedValue(
      makeRound({ status: "COMPLETED", matchups: [] })
    );

    await evaluateRound("round-1");

    expect(voteCount).not.toHaveBeenCalled();
    expect(matchupUpdate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("throws when no Round exists for the given id", async () => {
    roundFindUnique.mockResolvedValue(null);

    await expect(evaluateRound("missing-round")).rejects.toThrow(
      /no Round found/
    );
  });

  it("normal multi-round advance with no ties: resolves both matchups, closes the round, and opens round 2 pairing the winners in bracket order", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        roundNumber: 1,
        durationMinutes: 60,
        matchups: [
          {
            id: "m1",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
          {
            id: "m2",
            itemAId: "item-3",
            itemBId: "item-4",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
        bracket: { defaultRoundDurationMinutes: 60 },
      })
    );
    mockVotes({
      m1: { "item-1": 10, "item-2": 3 }, // item-1 wins
      m2: { "item-3": 2, "item-4": 9 }, // item-4 wins
    });

    await evaluateRound("round-1", now);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { status: "COMPLETED", winnerItemId: "item-1" },
    });
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { status: "COMPLETED", winnerItemId: "item-4" },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(roundUpdate).toHaveBeenCalledWith({
      where: { id: "round-1" },
      data: { status: "COMPLETED" },
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
    expect(roundCreate).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        roundNumber: 2,
        durationMinutes: 60,
        status: "ACTIVE",
        startsAt: now,
        endsAt: new Date(now.getTime() + 60 * 60_000),
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-4",
              winnerItemId: null,
              status: "ACTIVE",
            },
          ],
        },
      },
    });
  });

  it("uses Bracket.round_duration_overrides[roundNumber] for the next round's duration when present", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        roundNumber: 1,
        matchups: [
          {
            id: "m1",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
          {
            id: "m2",
            itemAId: "item-3",
            itemBId: "item-4",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
        bracket: {
          defaultRoundDurationMinutes: 60,
          roundDurationOverrides: { "2": 20 },
        },
      })
    );
    mockVotes({
      m1: { "item-1": 5, "item-2": 1 },
      m2: { "item-3": 1, "item-4": 5 },
    });

    await evaluateRound("round-1", now);

    expect(roundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          durationMinutes: 20,
          endsAt: new Date(now.getTime() + 20 * 60_000),
        }),
      })
    );
  });

  it("the final round producing a champion: completes the Bracket instead of creating another round", async () => {
    const now = new Date("2026-01-03T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        roundNumber: 3,
        matchups: [
          {
            id: "final-matchup",
            itemAId: "item-a",
            itemBId: "item-b",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
      })
    );
    mockVotes({ "final-matchup": { "item-a": 12, "item-b": 4 } });

    await evaluateRound("round-1", now);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "final-matchup" },
      data: { status: "COMPLETED", winnerItemId: "item-a" },
    });
    expect(roundUpdate).toHaveBeenCalledWith({
      where: { id: "round-1" },
      data: { status: "COMPLETED" },
    });
    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { status: "COMPLETED" },
    });
    expect(roundCreate).not.toHaveBeenCalled();
  });

  it("a round where one matchup ties: that matchup moves to TIE_BREAKER, the round stays open, and the other matchup still closes correctly", async () => {
    const now = new Date("2026-01-04T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        durationMinutes: 300, // 25% = 75 minutes, above the 60-minute floor
        matchups: [
          {
            id: "clear-matchup",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
          {
            id: "tied-matchup",
            itemAId: "item-3",
            itemBId: "item-4",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
      })
    );
    mockVotes({
      "clear-matchup": { "item-1": 8, "item-2": 1 },
      "tied-matchup": { "item-3": 4, "item-4": 4 },
    });

    await evaluateRound("round-1", now);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "clear-matchup" },
      data: { status: "COMPLETED", winnerItemId: "item-1" },
    });
    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "tied-matchup" },
      data: {
        status: "TIE_BREAKER",
        tieBreakerEndsAt: new Date(now.getTime() + 75 * 60_000),
      },
    });

    // The round is not closed - it stays ACTIVE, awaiting the tie-breaker.
    expect(transaction).not.toHaveBeenCalled();
    expect(roundUpdate).not.toHaveBeenCalled();
    expect(roundCreate).not.toHaveBeenCalled();
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("floors the tie-breaker window at 60 minutes when 25% of the round duration is shorter", async () => {
    const now = new Date("2026-01-04T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        durationMinutes: 60, // 25% = 15 minutes, below the 60-minute floor
        matchups: [
          {
            id: "tied-matchup",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
      })
    );
    mockVotes({ "tied-matchup": { "item-1": 0, "item-2": 0 } });

    await evaluateRound("round-1", now);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "tied-matchup" },
      data: {
        status: "TIE_BREAKER",
        tieBreakerEndsAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
  });

  it("re-evaluating after the tie-breaker resolves: a Matchup already COMPLETED (from #29 resolving its tie-breaker) is left alone, and the round now closes", async () => {
    const now = new Date("2026-01-05T00:00:00.000Z");
    // Simulates the state after a prior evaluateRound call moved one
    // matchup to TIE_BREAKER and it was later resolved (by #29, out of
    // scope here) to COMPLETED with a winner - both matchups are now
    // COMPLETED before this call even starts.
    roundFindUnique.mockResolvedValue(
      makeRound({
        matchups: [
          {
            id: "already-done",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: "item-1",
            status: "COMPLETED",
            tieBreakerEndsAt: null,
          },
          {
            id: "resolved-tie-breaker",
            itemAId: "item-3",
            itemBId: "item-4",
            winnerItemId: "item-4",
            status: "COMPLETED",
            tieBreakerEndsAt: new Date("2026-01-04T00:00:00.000Z"),
          },
        ],
      })
    );

    await evaluateRound("round-1", now);

    // Neither already-COMPLETED matchup is re-evaluated by vote count.
    expect(voteCount).not.toHaveBeenCalled();
    expect(matchupUpdate).not.toHaveBeenCalled();

    // But the round itself now closes, since every Matchup is COMPLETED.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(roundUpdate).toHaveBeenCalledWith({
      where: { id: "round-1" },
      data: { status: "COMPLETED" },
    });
    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-4",
              winnerItemId: null,
              status: "ACTIVE",
            },
          ],
        },
      }),
    });
  });

  it("still leaves a Matchup still in TIE_BREAKER alone (not re-processed) and the round stays open", async () => {
    roundFindUnique.mockResolvedValue(
      makeRound({
        matchups: [
          {
            id: "still-tied",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "TIE_BREAKER",
            tieBreakerEndsAt: new Date("2026-01-04T00:00:00.000Z"),
          },
        ],
      })
    );

    await evaluateRound("round-1");

    expect(voteCount).not.toHaveBeenCalled();
    expect(matchupUpdate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not process a PENDING/ACTIVE matchup missing an item, and does not close the round around it", async () => {
    roundFindUnique.mockResolvedValue(
      makeRound({
        matchups: [
          {
            id: "malformed",
            itemAId: "item-1",
            itemBId: null,
            winnerItemId: null,
            status: "ACTIVE",
            tieBreakerEndsAt: null,
          },
        ],
      })
    );

    await evaluateRound("round-1");

    expect(voteCount).not.toHaveBeenCalled();
    expect(matchupUpdate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("treats a zero-zero vote count as a TIE (per #19), sending it to a tie-breaker rather than picking a side", async () => {
    const now = new Date("2026-01-06T00:00:00.000Z");
    roundFindUnique.mockResolvedValue(
      makeRound({
        durationMinutes: 60,
        matchups: [
          {
            id: "no-votes",
            itemAId: "item-1",
            itemBId: "item-2",
            winnerItemId: null,
            status: "PENDING",
            tieBreakerEndsAt: null,
          },
        ],
      })
    );
    mockVotes({});

    await evaluateRound("round-1", now);

    expect(matchupUpdate).toHaveBeenCalledWith({
      where: { id: "no-votes" },
      data: {
        status: "TIE_BREAKER",
        tieBreakerEndsAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
  });
});
