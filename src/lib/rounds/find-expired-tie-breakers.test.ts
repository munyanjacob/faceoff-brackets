import { describe, expect, it, vi } from "vitest";
import { MatchupStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import type { MatchupModel } from "@/generated/prisma/models";
import { findExpiredTieBreakers } from "./find-expired-tie-breakers";

type FindManyArgs = {
  where: { status: MatchupStatus; tieBreakerEndsAt: { lt: Date } };
};

function fakePrisma(matchups: MatchupModel[]) {
  const findMany = vi.fn(async (_args: FindManyArgs) => matchups);
  return {
    prisma: { matchup: { findMany } } as unknown as PrismaClient,
    findMany,
  };
}

describe("findExpiredTieBreakers", () => {
  it("queries Matchup with status TIE_BREAKER and tieBreakerEndsAt before `now` in a single findMany call", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredTieBreakers(prisma, now);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: MatchupStatus.TIE_BREAKER,
        tieBreakerEndsAt: { lt: now },
      },
    });
  });

  it("defaults `now` to the current time when not provided", async () => {
    const before = new Date();
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredTieBreakers(prisma);

    const after = new Date();
    const usedNow = findMany.mock.calls[0][0].where.tieBreakerEndsAt.lt as Date;
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedNow.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does not filter or join on Round/Vote - only Matchup.status/Matchup.tieBreakerEndsAt", async () => {
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredTieBreakers(prisma, new Date());

    const args = findMany.mock.calls[0][0];
    expect(Object.keys(args.where)).toEqual(["status", "tieBreakerEndsAt"]);
    expect(args).not.toHaveProperty("include");
    expect(args).not.toHaveProperty("select");
  });

  it("returns exactly what the query resolves with (read-only passthrough)", async () => {
    const expired: MatchupModel = {
      id: "matchup-1",
      roundId: "round-1",
      itemAId: "item-1",
      itemBId: "item-2",
      winnerItemId: null,
      status: MatchupStatus.TIE_BREAKER,
      tieBreakerEndsAt: new Date("2025-12-31T01:00:00.000Z"),
    };
    const { prisma } = fakePrisma([expired]);

    const result = await findExpiredTieBreakers(prisma, new Date("2026-01-01"));

    expect(result).toEqual([expired]);
  });

  it("never calls any write method on the Prisma client", async () => {
    const now = new Date();
    const matchupWrites = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    };
    const voteWrites = {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    };
    const prisma = {
      matchup: { findMany: vi.fn(async () => []), ...matchupWrites },
      vote: voteWrites,
    } as unknown as PrismaClient;

    await findExpiredTieBreakers(prisma, now);

    for (const fn of Object.values(matchupWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(voteWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
