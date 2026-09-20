import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #27's wiring end-to-end against the real, disposable
// Supabase/Postgres project configured in `.env.local`: seeds a real
// Profile/Bracket/BracketItem/Round/Matchup/Vote graph via `prisma`, calls
// the real (unmocked) `GET` handler, and asserts on the resulting rows -
// same live-database pattern as `../../../../lib/rounds/evaluate-round.integration.test.ts`
// (#20) and `../../../../lib/rounds/find-expired-rounds.integration.test.ts`
// (#26), which this endpoint composes.
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
  "GET /api/cron/advance-rounds, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];
    const cronSecret = "route-integration-test-secret";
    const originalSecret = process.env.CRON_SECRET;

    beforeAll(async () => {
      process.env.CRON_SECRET = cronSecret;
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `advance-rounds-route-e2e-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
        },
      });
    });

    afterAll(async () => {
      process.env.CRON_SECRET = originalSecret;
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
      // strictly ascending - the ordering `evaluateRound` relies on to
      // reconstruct bracket order.
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

    async function makeExpiredRound(
      bracketId: string,
      roundNumber: number,
      pairs: Array<{ itemAId: string; itemBId: string }>
    ) {
      const now = Date.now();
      const round = await prisma.round.create({
        data: {
          bracketId,
          roundNumber,
          durationMinutes: 60,
          startsAt: new Date(now - 2 * 60 * 60_000),
          // Already expired: endsAt is in the past.
          endsAt: new Date(now - 60_000),
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

    async function vote(
      matchupId: string,
      itemId: string,
      count: number,
      createdAt?: Date
    ) {
      for (let i = 0; i < count; i++) {
        await prisma.vote.create({
          data: {
            matchupId,
            itemId,
            anonymousVoterIdentifier: randomUUID(),
            ...(createdAt ? { createdAt } : {}),
          },
        });
      }
    }

    // #29: seeds a Matchup already sitting in TIE_BREAKER with an expired
    // `tieBreakerEndsAt`, on a Round whose `durationMinutes` is `60` - so
    // (matching evaluate-round.ts's formula) the tie-breaker window is
    // `max(25% of 60, 60)` = 60 minutes, and `tieBreakerStartedAt` is
    // exactly 60 minutes before `tieBreakerEndsAt`.
    async function makeExpiredTieBreaker(
      bracketId: string,
      roundNumber: number,
      itemAId: string,
      itemBId: string
    ) {
      const now = Date.now();
      const tieBreakerEndsAt = new Date(now - 60_000); // already expired
      const tieBreakerStartedAt = new Date(
        tieBreakerEndsAt.getTime() - 60 * 60_000
      );
      const round = await prisma.round.create({
        data: {
          bracketId,
          roundNumber,
          durationMinutes: 60,
          startsAt: new Date(now - 3 * 60 * 60_000),
          endsAt: new Date(now + 60 * 60_000), // round itself not expired
          status: "ACTIVE",
          matchups: {
            create: [
              {
                itemAId,
                itemBId,
                status: "TIE_BREAKER",
                tieBreakerEndsAt,
              },
            ],
          },
        },
        include: { matchups: true },
      });
      return { round, matchup: round.matchups[0], tieBreakerStartedAt };
    }

    function authedRequest() {
      return new Request("http://localhost/api/cron/advance-rounds", {
        headers: { authorization: `Bearer ${cronSecret}` },
      });
    }

    // Issue #28: seeds a SCHEDULED bracket whose scheduledStartAt is already
    // in the past, with round 1 already created PENDING (mirroring what
    // #18's buildRoundOnePlan persists at publish time for a scheduled
    // start) - a non-bye Matchup PENDING, and (when `withBye` is set) a bye
    // Matchup already COMPLETED with its winner set, exactly as
    // buildRoundOnePlan always produces a bye regardless of immediate vs.
    // scheduled start.
    async function makeDueScheduledBracket(
      itemCount: number,
      options: { durationMinutes?: number } = {}
    ) {
      const durationMinutes = options.durationMinutes ?? 60;
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - scheduled start",
        itemCount
      );
      await prisma.bracket.update({
        where: { id: bracket.id },
        data: {
          status: "SCHEDULED",
          scheduledStartAt: new Date(Date.now() - 60_000), // already due
        },
      });

      const matchupsData = [];
      for (let i = 0; i + 1 < items.length; i += 2) {
        matchupsData.push({
          itemAId: items[i].id,
          itemBId: items[i + 1].id,
          status: "PENDING" as const,
        });
      }
      if (items.length % 2 === 1) {
        const lastItem = items[items.length - 1];
        matchupsData.push({
          itemAId: lastItem.id,
          itemBId: null,
          winnerItemId: lastItem.id,
          status: "COMPLETED" as const,
        });
      }

      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes,
          status: "PENDING",
          startsAt: null,
          endsAt: null,
          matchups: { create: matchupsData },
        },
        include: { matchups: true },
      });

      return { bracket, items, round };
    }

    it("returns 200 and touches nothing when no round has expired", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - nothing expired",
        2
      );
      // Round that has NOT expired yet.
      const notExpiredRound = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
          status: "ACTIVE",
          matchups: {
            create: [{ itemAId: items[0].id, itemBId: items[1].id, status: "ACTIVE" }],
          },
        },
      });

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const unchanged = await prisma.round.findUnique({
        where: { id: notExpiredRound.id },
      });
      expect(unchanged?.status).toBe("ACTIVE");
    });

    it("closes an expired round with clear results, sets winnerItemId, and opens the next round ACTIVE", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - clear results",
        4
      );
      const round = await makeExpiredRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
        { itemAId: items[2].id, itemBId: items[3].id },
      ]);
      const [m1, m2] = round.matchups;
      await vote(m1.id, items[0].id, 3);
      await vote(m1.id, items[1].id, 1);
      await vote(m2.id, items[2].id, 1);
      await vote(m2.id, items[3].id, 5);

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const closedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(closedRound?.status).toBe("COMPLETED");

      const decidedMatchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
        orderBy: { itemA: { createdAt: "asc" } },
      });
      expect(decidedMatchups.every((m) => m.status === "COMPLETED")).toBe(true);
      expect(decidedMatchups[0].winnerItemId).toBe(items[0].id);
      expect(decidedMatchups[1].winnerItemId).toBe(items[3].id);

      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
        include: { matchups: true },
      });
      expect(nextRound).not.toBeNull();
      expect(nextRound!.status).toBe("ACTIVE");
      expect(nextRound!.matchups).toHaveLength(1);
      expect(nextRound!.matchups[0].itemAId).toBe(items[0].id);
      expect(nextRound!.matchups[0].itemBId).toBe(items[3].id);
    });

    it("leaves a tied matchup TIE_BREAKER and keeps the round ACTIVE rather than closing it", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - tie",
        2
      );
      const round = await makeExpiredRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
      ]);
      const [m1] = round.matchups;
      await vote(m1.id, items[0].id, 2);
      await vote(m1.id, items[1].id, 2); // tie

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const stillOpenRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(stillOpenRound?.status).toBe("ACTIVE");

      const tieBreakerMatchup = await prisma.matchup.findUnique({
        where: { id: m1.id },
      });
      expect(tieBreakerMatchup?.status).toBe("TIE_BREAKER");
      expect(tieBreakerMatchup?.winnerItemId).toBeNull();

      const nextRound = await prisma.round.findFirst({
        where: { bracketId: bracket.id, roundNumber: 2 },
      });
      expect(nextRound).toBeNull();
    });

    it("handles multiple expired rounds across different brackets in a single invocation", async () => {
      const { bracket: bracketA, items: itemsA } = await makeBracket(
        "Advance Rounds Route E2E - multi A",
        2
      );
      const { bracket: bracketB, items: itemsB } = await makeBracket(
        "Advance Rounds Route E2E - multi B",
        2
      );
      const roundA = await makeExpiredRound(bracketA.id, 1, [
        { itemAId: itemsA[0].id, itemBId: itemsA[1].id },
      ]);
      const roundB = await makeExpiredRound(bracketB.id, 1, [
        { itemAId: itemsB[0].id, itemBId: itemsB[1].id },
      ]);
      await vote(roundA.matchups[0].id, itemsA[0].id, 5);
      await vote(roundB.matchups[0].id, itemsB[1].id, 5);

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const closedA = await prisma.round.findUnique({ where: { id: roundA.id } });
      const closedB = await prisma.round.findUnique({ where: { id: roundB.id } });
      expect(closedA?.status).toBe("COMPLETED");
      expect(closedB?.status).toBe("COMPLETED");
    });

    it("resolves an expired tie-breaker using only votes cast during the tie-breaker window, and closes the round around it", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - tie-breaker resolves",
        2
      );
      const { round, matchup, tieBreakerStartedAt } =
        await makeExpiredTieBreaker(bracket.id, 1, items[0].id, items[1].id);

      // Votes cast during the original round, BEFORE the tie-breaker
      // started - must be excluded from the tie-breaker tally. Heavily
      // favors item B, so if these leaked into the tally item B would win
      // instead of item A.
      await vote(
        matchup.id,
        items[1].id,
        5,
        new Date(tieBreakerStartedAt.getTime() - 60_000)
      );

      // Votes cast during the tie-breaker window - item A decisively wins
      // these.
      await vote(
        matchup.id,
        items[0].id,
        3,
        new Date(tieBreakerStartedAt.getTime() + 60_000)
      );
      await vote(
        matchup.id,
        items[1].id,
        1,
        new Date(tieBreakerStartedAt.getTime() + 60_000)
      );

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const resolvedMatchup = await prisma.matchup.findUnique({
        where: { id: matchup.id },
      });
      expect(resolvedMatchup?.status).toBe("COMPLETED");
      expect(resolvedMatchup?.winnerItemId).toBe(items[0].id);

      // Resolving the only open matchup was the last thing blocking this
      // (single-matchup) round from closing - evaluateRound should have
      // been re-run and closed it, completing the bracket (only 2 items).
      const closedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(closedRound?.status).toBe("COMPLETED");

      const closedBracket = await prisma.bracket.findUnique({
        where: { id: bracket.id },
      });
      expect(closedBracket?.status).toBe("COMPLETED");
    });

    it("a tie-breaker that ties again still resolves to one of the two items (random fallback) rather than staying open", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - tie-breaker ties again",
        2
      );
      const { matchup, tieBreakerStartedAt } = await makeExpiredTieBreaker(
        bracket.id,
        1,
        items[0].id,
        items[1].id
      );
      await vote(
        matchup.id,
        items[0].id,
        2,
        new Date(tieBreakerStartedAt.getTime() + 60_000)
      );
      await vote(
        matchup.id,
        items[1].id,
        2,
        new Date(tieBreakerStartedAt.getTime() + 60_000)
      );

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const resolvedMatchup = await prisma.matchup.findUnique({
        where: { id: matchup.id },
      });
      expect(resolvedMatchup?.status).toBe("COMPLETED");
      expect([items[0].id, items[1].id]).toContain(
        resolvedMatchup?.winnerItemId
      );
    });

    it("returns 401 and evaluates nothing when the bearer token is wrong", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - unauthorized",
        2
      );
      const round = await makeExpiredRound(bracket.id, 1, [
        { itemAId: items[0].id, itemBId: items[1].id },
      ]);
      await vote(round.matchups[0].id, items[0].id, 3);

      const response = await GET(
        new Request("http://localhost/api/cron/advance-rounds", {
          headers: { authorization: "Bearer wrong-secret" },
        })
      );
      expect(response.status).toBe(401);

      const untouchedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(untouchedRound?.status).toBe("ACTIVE");
    });

    it("starts a due SCHEDULED bracket: Bracket/Round go ACTIVE, non-bye Matchups go ACTIVE, and startsAt/endsAt are set from the transition time", async () => {
      const before = new Date();
      const { bracket, round } = await makeDueScheduledBracket(4, {
        durationMinutes: 90,
      });

      const response = await GET(authedRequest());
      const after = new Date();
      expect(response.status).toBe(200);

      const startedBracket = await prisma.bracket.findUnique({
        where: { id: bracket.id },
      });
      expect(startedBracket?.status).toBe("ACTIVE");

      const startedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(startedRound?.status).toBe("ACTIVE");
      expect(startedRound?.startsAt).not.toBeNull();
      expect(startedRound!.startsAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(startedRound!.startsAt!.getTime()).toBeLessThanOrEqual(
        after.getTime()
      );
      expect(startedRound!.endsAt!.getTime()).toBe(
        startedRound!.startsAt!.getTime() + 90 * 60_000
      );

      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      expect(matchups.every((m) => m.status === "ACTIVE")).toBe(true);
    });

    it("leaves an already-COMPLETED bye Matchup untouched when starting a due SCHEDULED bracket", async () => {
      const { round } = await makeDueScheduledBracket(3); // odd count -> one bye

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
        orderBy: { itemA: { createdAt: "asc" } },
      });
      const bye = matchups.find((m) => m.itemBId === null);
      const nonBye = matchups.filter((m) => m.itemBId !== null);

      expect(bye?.status).toBe("COMPLETED");
      expect(bye?.winnerItemId).not.toBeNull();
      expect(nonBye.every((m) => m.status === "ACTIVE")).toBe(true);
    });

    it("does not touch a SCHEDULED bracket whose scheduledStartAt is still in the future", async () => {
      const { bracket, items } = await makeBracket(
        "Advance Rounds Route E2E - not yet due",
        2
      );
      await prisma.bracket.update({
        where: { id: bracket.id },
        data: {
          status: "SCHEDULED",
          scheduledStartAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "PENDING",
          matchups: {
            create: [{ itemAId: items[0].id, itemBId: items[1].id, status: "PENDING" }],
          },
        },
      });

      const response = await GET(authedRequest());
      expect(response.status).toBe(200);

      const unchangedBracket = await prisma.bracket.findUnique({
        where: { id: bracket.id },
      });
      expect(unchangedBracket?.status).toBe("SCHEDULED");

      const unchangedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(unchangedRound?.status).toBe("PENDING");
    });

    it("does not start a SCHEDULED bracket when unauthorized", async () => {
      const { bracket, round } = await makeDueScheduledBracket(2);

      const response = await GET(
        new Request("http://localhost/api/cron/advance-rounds", {
          headers: { authorization: "Bearer wrong-secret" },
        })
      );
      expect(response.status).toBe(401);

      const untouchedBracket = await prisma.bracket.findUnique({
        where: { id: bracket.id },
      });
      expect(untouchedBracket?.status).toBe("SCHEDULED");

      const untouchedRound = await prisma.round.findUnique({
        where: { id: round.id },
      });
      expect(untouchedRound?.status).toBe("PENDING");
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../../../lib/rounds/evaluate-round.integration.test.ts`.
  describe("GET /api/cron/advance-rounds, against the live database", () => {
    console.warn(
      "[advance-rounds route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
