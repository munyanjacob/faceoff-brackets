import { describe, expect, it, vi } from "vitest";
import { RoundStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import type { RoundModel } from "@/generated/prisma/models";
import { findExpiredRounds } from "./find-expired-rounds";

type FindManyArgs = {
  where: { status: RoundStatus; endsAt: { lt: Date } };
};

function fakePrisma(rounds: RoundModel[]) {
  const findMany = vi.fn(async (_args: FindManyArgs) => rounds);
  return {
    prisma: { round: { findMany } } as unknown as PrismaClient,
    findMany,
  };
}

describe("findExpiredRounds", () => {
  it("queries Round with status ACTIVE and endsAt before `now` in a single findMany call", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredRounds(prisma, now);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: RoundStatus.ACTIVE,
        endsAt: { lt: now },
      },
    });
  });

  it("defaults `now` to the current time when not provided", async () => {
    const before = new Date();
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredRounds(prisma);

    const after = new Date();
    const usedNow = findMany.mock.calls[0][0].where.endsAt.lt as Date;
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedNow.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does not filter or join on Matchup - only Round.status/Round.endsAt", async () => {
    const { prisma, findMany } = fakePrisma([]);

    await findExpiredRounds(prisma, new Date());

    const args = findMany.mock.calls[0][0];
    expect(Object.keys(args.where)).toEqual(["status", "endsAt"]);
    expect(args).not.toHaveProperty("include");
    expect(args).not.toHaveProperty("select");
  });

  it("returns exactly what the query resolves with (read-only passthrough)", async () => {
    const expired: RoundModel = {
      id: "round-1",
      bracketId: "bracket-1",
      roundNumber: 1,
      durationMinutes: 60,
      startsAt: new Date("2025-12-31T00:00:00.000Z"),
      endsAt: new Date("2025-12-31T01:00:00.000Z"),
      status: RoundStatus.ACTIVE,
    };
    const { prisma } = fakePrisma([expired]);

    const result = await findExpiredRounds(prisma, new Date("2026-01-01"));

    expect(result).toEqual([expired]);
  });

  it("never calls any write method on the Prisma client", async () => {
    const now = new Date();
    const roundWrites = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    };
    const matchupWrites = {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    };
    const prisma = {
      round: { findMany: vi.fn(async () => []), ...roundWrites },
      matchup: matchupWrites,
    } as unknown as PrismaClient;

    await findExpiredRounds(prisma, now);

    for (const fn of Object.values(roundWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(matchupWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
