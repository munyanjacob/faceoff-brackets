import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked Prisma client, same shape/convention as `./evaluate-round.test.ts`:
// every method `startScheduledBracket` calls is its own `vi.fn()`, and
// `$transaction` runs its callback against a `tx` client built from the same
// mocks, so assertions can keep asserting directly against `bracketUpdate`/
// `roundUpdate`/`matchupUpdateMany`.
const bracketFindUnique = vi.fn();
const bracketUpdate = vi.fn();
const roundUpdate = vi.fn();
const matchupUpdateMany = vi.fn();

const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    bracket: { update: bracketUpdate },
    round: { update: roundUpdate },
    matchup: { updateMany: matchupUpdateMany },
  })
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique: bracketFindUnique },
    $transaction: transaction,
  },
}));

const { startScheduledBracket } = await import("./start-scheduled-bracket");

function makeBracket(opts: {
  id?: string;
  status?: "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";
  rounds: Array<{ id: string; roundNumber: number; durationMinutes: number }>;
}) {
  return {
    id: opts.id ?? "bracket-1",
    status: opts.status ?? "SCHEDULED",
    rounds: opts.rounds,
  };
}

describe("startScheduledBracket", () => {
  beforeEach(() => {
    bracketFindUnique.mockReset();
    bracketUpdate.mockReset();
    roundUpdate.mockReset();
    matchupUpdateMany.mockReset();
    transaction.mockClear();
  });

  it("throws when no Bracket exists for the given id", async () => {
    bracketFindUnique.mockResolvedValue(null);

    await expect(startScheduledBracket("missing-bracket")).rejects.toThrow(
      /no Bracket found/
    );
  });

  it("is a no-op when the Bracket is no longer SCHEDULED (already started)", async () => {
    bracketFindUnique.mockResolvedValue(
      makeBracket({
        status: "ACTIVE",
        rounds: [{ id: "round-1", roundNumber: 1, durationMinutes: 60 }],
      })
    );

    await startScheduledBracket("bracket-1");

    expect(transaction).not.toHaveBeenCalled();
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("throws when the Bracket is SCHEDULED but has no round 1", async () => {
    bracketFindUnique.mockResolvedValue(
      makeBracket({ status: "SCHEDULED", rounds: [] })
    );

    await expect(startScheduledBracket("bracket-1")).rejects.toThrow(
      /has no round 1/
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("flips Bracket.status to ACTIVE and Round.status to ACTIVE, setting startsAt to `now` and endsAt to now + durationMinutes", async () => {
    const now = new Date("2026-01-02T03:15:00.000Z");
    bracketFindUnique.mockResolvedValue(
      makeBracket({
        id: "bracket-1",
        status: "SCHEDULED",
        rounds: [{ id: "round-1", roundNumber: 1, durationMinutes: 90 }],
      })
    );

    await startScheduledBracket("bracket-1", now);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { status: "ACTIVE" },
    });
    expect(roundUpdate).toHaveBeenCalledWith({
      where: { id: "round-1" },
      data: {
        status: "ACTIVE",
        startsAt: now,
        endsAt: new Date(now.getTime() + 90 * 60_000),
      },
    });
  });

  it("flips only PENDING matchups in round 1 to ACTIVE, leaving already-COMPLETED byes untouched", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    bracketFindUnique.mockResolvedValue(
      makeBracket({
        rounds: [{ id: "round-1", roundNumber: 1, durationMinutes: 60 }],
      })
    );

    await startScheduledBracket("bracket-1", now);

    expect(matchupUpdateMany).toHaveBeenCalledWith({
      where: { roundId: "round-1", status: "PENDING" },
      data: { status: "ACTIVE" },
    });
  });

  it("only ever looks at round 1 (filters the rounds query), not every round of the bracket", async () => {
    bracketFindUnique.mockResolvedValue(
      makeBracket({
        rounds: [{ id: "round-1", roundNumber: 1, durationMinutes: 60 }],
      })
    );

    await startScheduledBracket("bracket-1");

    expect(bracketFindUnique).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      include: { rounds: { where: { roundNumber: 1 } } },
    });
  });

  it("defaults `now` to the current time when not provided", async () => {
    const before = new Date();
    bracketFindUnique.mockResolvedValue(
      makeBracket({
        rounds: [{ id: "round-1", roundNumber: 1, durationMinutes: 60 }],
      })
    );

    await startScheduledBracket("bracket-1");

    const after = new Date();
    const usedStartsAt = roundUpdate.mock.calls[0][0].data.startsAt as Date;
    expect(usedStartsAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedStartsAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
