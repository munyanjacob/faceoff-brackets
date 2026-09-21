import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MatchupStatus, RoundStatus, BracketStatus, Visibility, VotingRequirement } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { findExpiredTieBreakers } from "./find-expired-tie-breakers";

// Same disposable-`@prisma/adapter-pg`-dependency pattern as
// `find-expired-rounds.integration.test.ts` (#26) - see that file's comment
// for the full rationale. This suite seeds a real Matchup graph (one
// TIE_BREAKER with an expired tieBreakerEndsAt, one TIE_BREAKER not yet
// expired, one already COMPLETED) and asserts only the first comes back.
const nodeRequire = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapterPg(): any {
  try {
    return nodeRequire("@prisma/adapter-pg");
  } catch {
    return undefined;
  }
}

const adapterModule = loadAdapterPg();
const adapterAvailable = adapterModule !== undefined;

function readDatabaseUrlFromEnvFile(): string | undefined {
  delete process.env.DATABASE_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DATABASE_URL left unset.
  }
  return process.env.DATABASE_URL;
}

const hasLiveCredentials = Boolean(process.env.DATABASE_URL);

describe.runIf(hasLiveCredentials && adapterAvailable)(
  "findExpiredTieBreakers, against the live database",
  () => {
    let prisma: PrismaClient;
    let creatorId: string;
    let bracketId: string;
    let expiredTieBreakerId: string;
    let notYetExpiredTieBreakerId: string;
    let completedMatchupId: string;

    beforeAll(async () => {
      const { PrismaPg } = adapterModule;
      const { PrismaClient: RealPrismaClient } = await import(
        "@/generated/prisma/client"
      );
      const adapter = new PrismaPg({
        connectionString: readDatabaseUrlFromEnvFile(),
      });
      prisma = new RealPrismaClient({ adapter });

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      creatorId = `find-expired-tie-breakers-${suffix}`;

      const creator = await prisma.profile.create({
        data: {
          id: creatorId,
          email: `find-expired-tie-breakers-${suffix}@example.test`,
        },
      });
      creatorId = creator.id;

      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: `find-expired-tie-breakers test bracket ${suffix}`,
          visibility: Visibility.PRIVATE,
          votingRequirement: VotingRequirement.ANONYMOUS_ALLOWED,
          defaultRoundDurationMinutes: 60,
          status: BracketStatus.ACTIVE,
        },
      });
      bracketId = bracket.id;

      const round = await prisma.round.create({
        data: {
          bracketId,
          roundNumber: 1,
          durationMinutes: 60,
          startsAt: new Date(Date.now() - 2 * 60 * 60_000),
          endsAt: new Date(Date.now() + 60 * 60_000),
          status: RoundStatus.ACTIVE,
        },
      });

      const [itemA, itemB] = await Promise.all([
        prisma.bracketItem.create({
          data: { bracketId, title: "Item A" },
        }),
        prisma.bracketItem.create({
          data: { bracketId, title: "Item B" },
        }),
      ]);

      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const oneHourFromNow = new Date(now + 60 * 60 * 1000);

      const [expiredTieBreaker, notYetExpiredTieBreaker, completedMatchup] =
        await Promise.all([
          prisma.matchup.create({
            data: {
              roundId: round.id,
              itemAId: itemA.id,
              itemBId: itemB.id,
              status: MatchupStatus.TIE_BREAKER,
              tieBreakerEndsAt: oneHourAgo,
            },
          }),
          prisma.matchup.create({
            data: {
              roundId: round.id,
              itemAId: itemA.id,
              itemBId: itemB.id,
              status: MatchupStatus.TIE_BREAKER,
              tieBreakerEndsAt: oneHourFromNow,
            },
          }),
          prisma.matchup.create({
            data: {
              roundId: round.id,
              itemAId: itemA.id,
              itemBId: itemB.id,
              winnerItemId: itemA.id,
              status: MatchupStatus.COMPLETED,
              tieBreakerEndsAt: oneHourAgo,
            },
          }),
        ]);
      expiredTieBreakerId = expiredTieBreaker.id;
      notYetExpiredTieBreakerId = notYetExpiredTieBreaker.id;
      completedMatchupId = completedMatchup.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      // Children before parents, per the schema's `onDelete: Restrict` FKs.
      await prisma.matchup.deleteMany({ where: { round: { bracketId } } });
      await prisma.round.deleteMany({ where: { bracketId } });
      await prisma.bracketItem.deleteMany({ where: { bracketId } });
      if (bracketId) {
        await prisma.bracket.delete({ where: { id: bracketId } });
      }
      if (creatorId) {
        await prisma.profile.delete({ where: { id: creatorId } });
      }
      await prisma.$disconnect();
    });

    it("returns only the expired TIE_BREAKER matchup out of the three seeded matchups", async () => {
      const result = await findExpiredTieBreakers(prisma);
      const seededIds = new Set([
        expiredTieBreakerId,
        notYetExpiredTieBreakerId,
        completedMatchupId,
      ]);
      const matchingSeeded = result.filter((matchup) =>
        seededIds.has(matchup.id)
      );

      expect(matchingSeeded).toHaveLength(1);
      expect(matchingSeeded[0].id).toBe(expiredTieBreakerId);
    });
  }
);

if (hasLiveCredentials && !adapterAvailable) {
  describe("findExpiredTieBreakers, against the live database", () => {
    console.warn(
      "[find-expired-tie-breakers.integration.test] Skipping: DATABASE_URL is configured, but `@prisma/adapter-pg` isn't installed. Run `npm install --no-save @prisma/adapter-pg pg` and re-run `npm test` to execute this suite locally."
    );

    it.skip("requires the `@prisma/adapter-pg` package - run `npm install --no-save @prisma/adapter-pg pg` to run this test locally", () => {});
  });
}

if (!hasLiveCredentials) {
  describe("findExpiredTieBreakers, against the live database", () => {
    console.warn(
      "[find-expired-tie-breakers.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
