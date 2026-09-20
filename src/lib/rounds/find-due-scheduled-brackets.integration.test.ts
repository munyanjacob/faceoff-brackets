import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BracketStatus, Visibility, VotingRequirement } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { findDueScheduledBrackets } from "./find-due-scheduled-brackets";

// Same disposable-`@prisma/adapter-pg` pattern as
// `./find-expired-rounds.integration.test.ts` (#26) - see that file's doc
// comment for the full reasoning (AGENTS.md forbids adding a dependency
// without asking, so this suite only runs when the adapter happens to be
// installed locally/CI, and skips with a clear explanation otherwise).
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
  "findDueScheduledBrackets, against the live database",
  () => {
    let prisma: PrismaClient;
    let creatorId: string;
    let dueBracketId: string;
    let notYetDueBracketId: string;
    let activeBracketId: string;

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
      creatorId = `find-due-scheduled-brackets-${suffix}`;

      const creator = await prisma.profile.create({
        data: {
          id: creatorId,
          email: `find-due-scheduled-brackets-${suffix}@example.test`,
        },
      });
      creatorId = creator.id;

      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const oneHourFromNow = new Date(now + 60 * 60 * 1000);

      const [dueBracket, notYetDueBracket, activeBracket] = await Promise.all([
        prisma.bracket.create({
          data: {
            creatorId,
            title: `find-due-scheduled-brackets due ${suffix}`,
            visibility: Visibility.PRIVATE,
            votingRequirement: VotingRequirement.ANONYMOUS_ALLOWED,
            defaultRoundDurationMinutes: 60,
            status: BracketStatus.SCHEDULED,
            scheduledStartAt: oneHourAgo,
          },
        }),
        prisma.bracket.create({
          data: {
            creatorId,
            title: `find-due-scheduled-brackets not-yet-due ${suffix}`,
            visibility: Visibility.PRIVATE,
            votingRequirement: VotingRequirement.ANONYMOUS_ALLOWED,
            defaultRoundDurationMinutes: 60,
            status: BracketStatus.SCHEDULED,
            scheduledStartAt: oneHourFromNow,
          },
        }),
        prisma.bracket.create({
          data: {
            creatorId,
            title: `find-due-scheduled-brackets already-active ${suffix}`,
            visibility: Visibility.PRIVATE,
            votingRequirement: VotingRequirement.ANONYMOUS_ALLOWED,
            defaultRoundDurationMinutes: 60,
            status: BracketStatus.ACTIVE,
          },
        }),
      ]);
      dueBracketId = dueBracket.id;
      notYetDueBracketId = notYetDueBracket.id;
      activeBracketId = activeBracket.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.bracket.deleteMany({
        where: { id: { in: [dueBracketId, notYetDueBracketId, activeBracketId] } },
      });
      if (creatorId) {
        await prisma.profile.delete({ where: { id: creatorId } });
      }
      await prisma.$disconnect();
    });

    it("returns only the due SCHEDULED bracket out of the three seeded brackets", async () => {
      const result = await findDueScheduledBrackets(prisma);
      const seededIds = new Set([
        dueBracketId,
        notYetDueBracketId,
        activeBracketId,
      ]);
      const matchingSeeded = result.filter((bracket) => seededIds.has(bracket.id));

      expect(matchingSeeded).toHaveLength(1);
      expect(matchingSeeded[0].id).toBe(dueBracketId);
    });
  }
);

if (hasLiveCredentials && !adapterAvailable) {
  describe("findDueScheduledBrackets, against the live database", () => {
    console.warn(
      "[find-due-scheduled-brackets.integration.test] Skipping: DATABASE_URL is configured, but `@prisma/adapter-pg` isn't installed (it's only committed on the track-a-creator-flow branch, issue #8). Run `npm install --no-save @prisma/adapter-pg pg` and re-run `npm test` to execute this suite locally."
    );

    it.skip("requires the `@prisma/adapter-pg` package - run `npm install --no-save @prisma/adapter-pg pg` to run this test locally", () => {});
  });
}
