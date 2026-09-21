import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #57's GET
// /api/brackets/[bracketId]/matchups/[matchupId]/result end-to-end against
// the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real `Profile`/`Bracket`/`BracketItem`/`Round`/
// `Matchup`/`Vote` rows via `prisma`, calls the real (unmocked) route
// handler, and asserts on the resulting JSON. Same live-database pattern as
// `../route.integration.test.ts` (issue #55) - see that file for the fuller
// rationale.

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
  "GET /api/brackets/[bracketId]/matchups/[matchupId]/result, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `result-e2e-creator-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
        },
      });
    });

    afterAll(async () => {
      await prisma.vote.deleteMany({
        where: { matchup: { round: { bracketId: { in: bracketIds } } } },
      });
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({ where: { bracketId: { in: bracketIds } } });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({ where: { id: creatorId } });
      await prisma.$disconnect();
    });

    async function makeBracket(title: string) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title,
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
          publishedAt: new Date(),
        },
      });
      bracketIds.push(bracket.id);
      return bracket;
    }

    async function makeItems(bracketId: string, count: number) {
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push(
          await prisma.bracketItem.create({
            data: { bracketId, title: `Item ${i + 1}` },
          })
        );
      }
      return items;
    }

    async function makeRound(bracketId: string, status: "PENDING" | "ACTIVE" | "COMPLETED" = "ACTIVE") {
      return prisma.round.create({
        data: {
          bracketId,
          roundNumber: 1,
          durationMinutes: 60,
          status,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
    }

    function requestFor(bracketId: string, matchupId: string) {
      return new Request(
        `http://localhost/api/brackets/${bracketId}/matchups/${matchupId}/result`,
        { headers: { origin: process.env.FRONTEND_ORIGIN ?? "https://app.example.com" } }
      );
    }

    function ctx(bracketId: string, matchupId: string) {
      return { params: Promise.resolve({ bracketId, matchupId }) };
    }

    it("returns 404 when the matchup doesn't belong to the given bracket", async () => {
      const bracketA = await makeBracket("Result E2E - bracket A");
      const bracketB = await makeBracket("Result E2E - bracket B");
      const itemsB = await makeItems(bracketB.id, 2);
      const roundB = await makeRound(bracketB.id);
      const matchupB = await prisma.matchup.create({
        data: {
          roundId: roundB.id,
          itemAId: itemsB[0].id,
          itemBId: itemsB[1].id,
          status: "COMPLETED",
          winnerItemId: itemsB[0].id,
        },
      });

      const response = await GET(
        requestFor(bracketA.id, matchupB.id),
        ctx(bracketA.id, matchupB.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This matchup no longer exists.",
      });
    });

    it("returns {kind: 'not_completed'} for a matchup that hasn't been decided yet", async () => {
      const bracket = await makeBracket("Result E2E - not completed");
      const items = await makeItems(bracket.id, 2);
      const round = await makeRound(bracket.id);
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "ACTIVE",
        },
      });

      const response = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ kind: "not_completed" });
    });

    it("returns the bye variant for a bye matchup, with no vote tally", async () => {
      const bracket = await makeBracket("Result E2E - bye");
      const items = await makeItems(bracket.id, 1);
      const round = await makeRound(bracket.id);
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: null,
          status: "COMPLETED",
          winnerItemId: items[0].id,
        },
      });

      const response = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.kind).toBe("bye");
      expect(body.advancingItem.id).toBe(items[0].id);
    });

    it("returns the decided variant with real, combined-phase vote counts across ORIGINAL and TIE_BREAKER votes, and real comments", async () => {
      const bracket = await makeBracket("Result E2E - decided via tie-breaker");
      const items = await makeItems(bracket.id, 2);
      const round = await makeRound(bracket.id);
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "COMPLETED",
          winnerItemId: items[0].id,
          tieBreakerEndsAt: new Date(),
        },
      });

      // ORIGINAL-phase votes (the tied round): 2-2.
      await prisma.vote.createMany({
        data: [
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID(), phase: "ORIGINAL" },
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID(), phase: "ORIGINAL" },
          { matchupId: matchup.id, itemId: items[1].id, anonymousVoterIdentifier: randomUUID(), phase: "ORIGINAL" },
          { matchupId: matchup.id, itemId: items[1].id, anonymousVoterIdentifier: randomUUID(), phase: "ORIGINAL" },
        ],
      });
      // TIE_BREAKER-phase votes: item A wins 2-1.
      await prisma.vote.createMany({
        data: [
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID(), phase: "TIE_BREAKER" },
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID(), phase: "TIE_BREAKER" },
          { matchupId: matchup.id, itemId: items[1].id, anonymousVoterIdentifier: randomUUID(), phase: "TIE_BREAKER", comment: "so close!" },
        ],
      });

      const response = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.kind).toBe("decided");
      expect(body.decidedByTieBreaker).toBe(true);
      // Combined across both phases: item A = 2 + 2 = 4, item B = 2 + 1 = 3.
      expect(body.winner.id).toBe(items[0].id);
      expect(body.winnerVoteCount).toBe(4);
      expect(body.loser.id).toBe(items[1].id);
      expect(body.loserVoteCount).toBe(3);
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0]).toMatchObject({
        itemId: items[1].id,
        comment: "so close!",
      });
      expect(body.comments[0].id).toEqual(expect.any(String));
    });

    it("applies CORS headers to the response", async () => {
      const bracket = await makeBracket("Result E2E - cors");
      const items = await makeItems(bracket.id, 2);
      const round = await makeRound(bracket.id);
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "COMPLETED",
          winnerItemId: items[0].id,
        },
      });

      const response = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        process.env.FRONTEND_ORIGIN ?? "https://app.example.com"
      );
    });
  }
);

if (!hasLiveDatabase) {
  describe("GET /api/brackets/[bracketId]/matchups/[matchupId]/result, against the live database", () => {
    console.warn(
      "[matchup result route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
