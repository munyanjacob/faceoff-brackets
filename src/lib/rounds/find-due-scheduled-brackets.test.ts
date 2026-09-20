import { describe, expect, it, vi } from "vitest";
import { BracketStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import type { BracketModel } from "@/generated/prisma/models";
import { findDueScheduledBrackets } from "./find-due-scheduled-brackets";

type FindManyArgs = {
  where: { status: BracketStatus; scheduledStartAt: { lt: Date } };
};

function fakePrisma(brackets: BracketModel[]) {
  const findMany = vi.fn(async (_args: FindManyArgs) => brackets);
  return {
    prisma: { bracket: { findMany } } as unknown as PrismaClient,
    findMany,
  };
}

function makeBracket(overrides: Partial<BracketModel> = {}): BracketModel {
  return {
    id: "bracket-1",
    creatorId: "creator-1",
    title: "A bracket",
    description: null,
    visibility: "PUBLIC",
    votingRequirement: "ANONYMOUS_ALLOWED",
    defaultRoundDurationMinutes: 60,
    roundDurationOverrides: null,
    scheduledStartAt: new Date("2025-12-31T00:00:00.000Z"),
    status: BracketStatus.SCHEDULED,
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
    publishedAt: new Date("2025-12-01T00:00:00.000Z"),
    ...overrides,
  } as BracketModel;
}

describe("findDueScheduledBrackets", () => {
  it("queries Bracket with status SCHEDULED and scheduledStartAt before `now` in a single findMany call", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { prisma, findMany } = fakePrisma([]);

    await findDueScheduledBrackets(prisma, now);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: BracketStatus.SCHEDULED,
        scheduledStartAt: { lt: now },
      },
    });
  });

  it("defaults `now` to the current time when not provided", async () => {
    const before = new Date();
    const { prisma, findMany } = fakePrisma([]);

    await findDueScheduledBrackets(prisma);

    const after = new Date();
    const usedNow = findMany.mock.calls[0][0].where.scheduledStartAt.lt as Date;
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedNow.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does not filter or join on Round/Matchup - only Bracket.status/Bracket.scheduledStartAt", async () => {
    const { prisma, findMany } = fakePrisma([]);

    await findDueScheduledBrackets(prisma, new Date());

    const args = findMany.mock.calls[0][0];
    expect(Object.keys(args.where)).toEqual(["status", "scheduledStartAt"]);
    expect(args).not.toHaveProperty("include");
    expect(args).not.toHaveProperty("select");
  });

  it("returns exactly what the query resolves with (read-only passthrough)", async () => {
    const due = makeBracket({ id: "due-bracket" });
    const { prisma } = fakePrisma([due]);

    const result = await findDueScheduledBrackets(prisma, new Date("2026-01-01"));

    expect(result).toEqual([due]);
  });

  it("never calls any write method on the Prisma client", async () => {
    const now = new Date();
    const bracketWrites = {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    };
    const roundWrites = {
      findMany: vi.fn(),
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
      bracket: { findMany: vi.fn(async () => []), ...bracketWrites },
      round: roundWrites,
      matchup: matchupWrites,
    } as unknown as PrismaClient;

    await findDueScheduledBrackets(prisma, now);

    for (const fn of Object.values(bracketWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(roundWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(matchupWrites)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
