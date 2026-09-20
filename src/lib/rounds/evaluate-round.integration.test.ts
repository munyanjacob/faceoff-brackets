import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #20's `evaluateRound` end-to-end against the real,
// disposable Supabase/Postgres project configured in `.env.local`: seeds
// real `Profile`/`Bracket`/`BracketItem`/`Round`/`Matchup`/`Vote` rows via
// `prisma`, calls the real (unmocked) `evaluateRound`, asserts on the
// resulting rows, then cleans everything up. Same live-database pattern as
// `../../app/dashboard/brackets/[id]/edit/publish-actions.integration.test.ts`
// (#18) and `./find-expired-rounds.integration.test.ts` (#26) - see those
// for the fuller rationale on why this needs a real database rather than a
// mock (in particular: proving the `itemA.createdAt`-based bracket-order
// query actually reconstructs bracket order against real rows, and that the
// `$transaction`-wrapped round-closing writes actually commit together).
//
// `@prisma/adapter-pg` is a real, committed dependency on this branch (see
// `src/lib/prisma.ts`), so - like the two suites above - the only gate here
// is live database credentials, not a `pg`-availability check.
function fixDatabaseUrlFromEnvFile(): string | undefined {
  delete process.env.DATABASE_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DATABASE_URL left unset, same as prisma7.config.ts.
  }
  return process.env.DATABASE_URL;
}

const hasLiveDatabase = Boolean(fixDatabaseUrlFromEnvFile());

describe.runIf(hasLiveDatabase)(
  "evaluateRound, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let evaluateRound: typeof import("./evaluate-round").evaluateRound;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ evaluateRound } = await import("./evaluate-round"));

      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `evaluate-round-e2e-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
        },
      });
    });

    afterAll(async () => {
      // Children before parents, per the schema's `onDelete: Restrict` FKs.
      await prisma.vote.deleteMany({
        where: { matchup: { round: { bracketId: { in: bracketIds } } } },
      });
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({ where: { id: creatorId } });
      await prisma.$disconnect();
    });

    async function makeBracket(title: string, itemCount: number) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title,
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
        },
      });
      bracketIds.push(bracket.id);

      // Created one at a time, in order, so their `createdAt` values are
      // strictly ascending - the same ordering `publishBracket` relies on
      // and that `evaluateRound` reconstructs bracket order from.
      const items = [];
      for (let i = 0; i < itemCount; i++) {
        items.push(
          await prisma.bracketItem.create({
            data: { bracketId: bracket.id, title: `Item ${i + 1}` },
          })
        );
      }
      return { bracket, items };
    }

    async function makeActiveRound(
      bracketId: string,
      roundNumber: number,
      pairs: Array<{ itemAId: string; itemBId: string }>
    ) {
      const round = await prisma.round.create({
        data: {
          bracketId,
          roundNumber,
          durationMinutes: 60,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
          status: "ACTIVE",
          matchups: {
            create: pairs.map((pair) => ({
              itemAId: pair.itemAId,
              itemBId: pair.itemBId,
              status: "ACTIVE",
            })),
          },
        },
        include: { matchups: true },
      });
      return round;
    }

    async function vote(matchupId: string, itemId: string, count: number) {
      for (let i = 0; i < count; i++) {
        await prisma.vote.create({
          data: {
            matchupId,
            itemId,
            anonymousVoterIdentifier: randomUUID(),
          },
        });
      }
    }

    it("closes a round with no ties and opens round 2, pairing consecutive winners in bracket order", async () => {
      const { bracket, items } = await makeBracket(
        "Evaluate Round E2E - no ties",
        4
      );
      const round = await makeActiveRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
        { itemAId: items[2].id, itemBId: items[3].id },
      ]);
      const [m1, m2] = round.matchups;

      await vote(m1.id, items[0].id, 3);
      await vote(m1.id, items[1].id, 1);
      await vote(m2.id, items[2].id, 1);
      await vote(m2.id, items[3].id, 5);

      await evaluateRound(round.id);

      const closedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(closedRound?.status).toBe("COMPLETED");

      const decidedMatchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      expect(decidedMatchups.every((m) => m.status === "COMPLETED")).toBe(
        true
      );

      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
        include: { matchups: true },
      });
      expect(nextRound).not.toBeNull();
      expect(nextRound!.status).toBe("ACTIVE");
      expect(nextRound!.matchups).toHaveLength(1);
      // item-1 beat item-2 -> items[0]; item-3 lost to item-4 -> items[3].
      // Bracket order pairs the winner of matchup 1 with the winner of
      // matchup 2.
      expect(nextRound!.matchups[0].itemAId).toBe(items[0].id);
      expect(nextRound!.matchups[0].itemBId).toBe(items[3].id);
      expect(nextRound!.matchups[0].status).toBe("ACTIVE");
    });

    it("the final round producing a champion: completes the Bracket and creates no further round", async () => {
      const { bracket, items } = await makeBracket(
        "Evaluate Round E2E - champion",
        2
      );
      const round = await makeActiveRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
      ]);
      const [m1] = round.matchups;
      await vote(m1.id, items[0].id, 4);
      await vote(m1.id, items[1].id, 2);

      await evaluateRound(round.id);

      const closedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(closedRound?.status).toBe("COMPLETED");

      const finishedBracket = await prisma.bracket.findUnique({
        where: { id: bracket.id },
      });
      expect(finishedBracket?.status).toBe("COMPLETED");

      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
      });
      expect(nextRound).toBeNull();
    });

    it("a tied matchup moves to TIE_BREAKER and keeps the round open, while a re-evaluation after it's resolved closes the round", async () => {
      const { bracket, items } = await makeBracket(
        "Evaluate Round E2E - tie then resolve",
        4
      );
      const round = await makeActiveRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
        { itemAId: items[2].id, itemBId: items[3].id },
      ]);
      const [m1, m2] = round.matchups;

      await vote(m1.id, items[0].id, 2);
      await vote(m1.id, items[1].id, 2); // tie
      await vote(m2.id, items[2].id, 1);
      await vote(m2.id, items[3].id, 5); // clear win

      await evaluateRound(round.id);

      const afterFirstPass = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(afterFirstPass?.status).toBe("ACTIVE"); // still open

      const matchupsAfterFirstPass = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      const tieBreakerMatchup = matchupsAfterFirstPass.find(
        (m) => m.id === m1.id
      )!;
      expect(tieBreakerMatchup.status).toBe("TIE_BREAKER");
      expect(tieBreakerMatchup.winnerItemId).toBeNull();
      expect(tieBreakerMatchup.tieBreakerEndsAt).not.toBeNull();
      // Round's durationMinutes is 60 -> 25% (15 min) is below the 60-minute
      // floor, so the floor applies.
      expect(
        tieBreakerMatchup.tieBreakerEndsAt!.getTime() -
          Date.now()
      ).toBeGreaterThan(59 * 60_000);

      const clearMatchup = matchupsAfterFirstPass.find(
        (m) => m.id === m2.id
      )!;
      expect(clearMatchup.status).toBe("COMPLETED");
      expect(clearMatchup.winnerItemId).toBe(items[3].id);

      // #29 (out of scope here) would resolve the tie-breaker; simulate
      // that directly, then re-evaluate the same round.
      await prisma.matchup.update({
        where: { id: m1.id },
        data: { status: "COMPLETED", winnerItemId: items[0].id },
      });

      await evaluateRound(round.id);

      const afterSecondPass = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(afterSecondPass?.status).toBe("COMPLETED");

      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
        include: { matchups: true },
      });
      expect(nextRound).not.toBeNull();
      expect(nextRound!.matchups[0].itemAId).toBe(items[0].id);
      expect(nextRound!.matchups[0].itemBId).toBe(items[3].id);
    });

    it("is a no-op when called on an already-COMPLETED round", async () => {
      const { bracket, items } = await makeBracket(
        "Evaluate Round E2E - no-op",
        2
      );
      const round = await makeActiveRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
      ]);
      await prisma.round.update({
        where: { id: round.id },
        data: { status: "COMPLETED" },
      });
      await prisma.matchup.update({
        where: { id: round.matchups[0].id },
        data: { status: "COMPLETED", winnerItemId: items[0].id },
      });

      await evaluateRound(round.id);

      const unchangedMatchup = await prisma.matchup.findUnique({
        where: { id: round.matchups[0].id },
      });
      expect(unchangedMatchup?.winnerItemId).toBe(items[0].id);
      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
      });
      expect(nextRound).toBeNull();
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../app/dashboard/brackets/[id]/edit/publish-actions.integration.test.ts`.
  describe("evaluateRound, against the live database", () => {
    console.warn(
      "[evaluate-round.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
