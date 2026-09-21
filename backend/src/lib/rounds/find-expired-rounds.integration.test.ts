import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoundStatus, BracketStatus, Visibility, VotingRequirement } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { findExpiredRounds } from "./find-expired-rounds";

// Issue #26's acceptance criteria require this to be "tested against seeded
// data" - a real ACTIVE+expired Round, a real ACTIVE+not-yet-expired Round,
// and a real COMPLETED Round, asserting only the first comes back. That
// needs a real, working `PrismaClient` to seed with and to query through
// `findExpiredRounds` itself.
//
// Prisma 7's generated client (`src/generated/prisma`) throws in its own
// constructor unless given a driver adapter - confirmed by hand here, same
// finding already documented on issues #7/#8. `@prisma/adapter-pg` is the
// approved adapter for a plain Postgres/Supabase connection, but it was
// only approved (and committed to package.json) on issue #8, scoped to
// `track-a-creator-flow` - it isn't installed on this branch, and #26's
// constraints don't grant the same "add exactly one new dependency"
// exception #8 got. Adding it here without asking would break AGENTS.md's
// "Do not add or upgrade a dependency without asking."
//
// Following the same disposable-dependency pattern already established by
// `src/app/signup/profile-sync.integration.test.ts` (there, for a raw `pg`
// read-back client), this suite loads `@prisma/adapter-pg` optionally via
// `createRequire`, wrapped in try/catch, and only runs when it's actually
// present. To run this locally against a live database:
//
//   npm install --no-save @prisma/adapter-pg pg
//   npm test
//   npm install   (prunes both back out; package.json/package-lock.json
//                  are never touched)
//
// Untyped (`any`) on purpose so `tsc --noEmit` stays clean whether or not
// the package is installed.
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

// `vitest.config.ts` loads `.env.local` via Vite's `loadEnv`, which runs
// shell-style `$VAR` interpolation over every value (dotenv-expand
// semantics). If this project's real `DATABASE_URL` password contains a
// `$` sequence that happens to look like a variable reference, Vite's copy
// of `process.env.DATABASE_URL` would silently mangle it - the same issue
// already documented (for `DIRECT_URL`) in
// `src/app/signup/actions.integration.test.ts`. Re-read it straight from
// the file with Node's own literal-assignment loader before constructing
// the adapter, so this suite connects with exactly what's on disk.
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
  "findExpiredRounds, against the live database",
  () => {
    let prisma: PrismaClient;
    let creatorId: string;
    let bracketId: string;
    let expiredRoundId: string;
    let notYetExpiredRoundId: string;
    let completedRoundId: string;

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
      creatorId = `find-expired-rounds-${suffix}`;

      const creator = await prisma.profile.create({
        data: {
          id: creatorId,
          email: `find-expired-rounds-${suffix}@example.test`,
        },
      });
      creatorId = creator.id;

      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: `find-expired-rounds test bracket ${suffix}`,
          visibility: Visibility.PRIVATE,
          votingRequirement: VotingRequirement.ANONYMOUS_ALLOWED,
          defaultRoundDurationMinutes: 60,
          status: BracketStatus.ACTIVE,
        },
      });
      bracketId = bracket.id;

      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const oneHourFromNow = new Date(now + 60 * 60 * 1000);
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);

      const [expiredRound, notYetExpiredRound, completedRound] =
        await Promise.all([
          prisma.round.create({
            data: {
              bracketId,
              roundNumber: 1,
              durationMinutes: 60,
              startsAt: twoHoursAgo,
              endsAt: oneHourAgo,
              status: RoundStatus.ACTIVE,
            },
          }),
          prisma.round.create({
            data: {
              bracketId,
              roundNumber: 2,
              durationMinutes: 60,
              startsAt: oneHourAgo,
              endsAt: oneHourFromNow,
              status: RoundStatus.ACTIVE,
            },
          }),
          prisma.round.create({
            data: {
              bracketId,
              roundNumber: 3,
              durationMinutes: 60,
              startsAt: twoHoursAgo,
              endsAt: oneHourAgo,
              status: RoundStatus.COMPLETED,
            },
          }),
        ]);
      expiredRoundId = expiredRound.id;
      notYetExpiredRoundId = notYetExpiredRound.id;
      completedRoundId = completedRound.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      // Children before parents, per the schema's `onDelete: Restrict` FKs.
      await prisma.round.deleteMany({ where: { bracketId } });
      if (bracketId) {
        await prisma.bracket.delete({ where: { id: bracketId } });
      }
      if (creatorId) {
        await prisma.profile.delete({ where: { id: creatorId } });
      }
      await prisma.$disconnect();
    });

    it("returns only the expired ACTIVE round out of the three seeded rounds", async () => {
      const result = await findExpiredRounds(prisma);
      const seededIds = new Set([
        expiredRoundId,
        notYetExpiredRoundId,
        completedRoundId,
      ]);
      const matchingSeeded = result.filter((round) => seededIds.has(round.id));

      expect(matchingSeeded).toHaveLength(1);
      expect(matchingSeeded[0].id).toBe(expiredRoundId);
    });
  }
);

// Live credentials are configured but the ad hoc `@prisma/adapter-pg`
// dependency isn't installed - register a clearly-explained skipped test
// (rather than silently doing nothing) so `npm test` explains why this
// file's live coverage didn't run, same reasoning as
// `profile-sync.integration.test.ts`.
if (hasLiveCredentials && !adapterAvailable) {
  describe("findExpiredRounds, against the live database", () => {
    console.warn(
      "[find-expired-rounds.integration.test] Skipping: DATABASE_URL is configured, but `@prisma/adapter-pg` isn't installed (it's only committed on the track-a-creator-flow branch, issue #8). Run `npm install --no-save @prisma/adapter-pg pg` and re-run `npm test` to execute this suite locally."
    );

    it.skip("requires the `@prisma/adapter-pg` package - run `npm install --no-save @prisma/adapter-pg pg` to run this test locally", () => {});
  });
}
