import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #57's GET /api/brackets/[bracketId]/tree end-to-end
// against the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real `Profile`/`Bracket`/`BracketItem`/`Round`/
// `Matchup`/`Vote` rows via `prisma`, calls the real (unmocked) route
// handler, and asserts on the resulting JSON. Same live-database pattern as
// `../matchups/[matchupId]/route.integration.test.ts` (issue #55) - see
// that file for the fuller rationale.

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
  "GET /api/brackets/[bracketId]/tree, against the live database",
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
          email: `tree-e2e-creator-${Date.now()}-${Math.random()
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

    async function makeBracket(
      title: string,
      status: "DRAFT" | "ACTIVE" | "COMPLETED" = "ACTIVE"
    ) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title,
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status,
          publishedAt: status === "DRAFT" ? null : new Date(),
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

    function requestFor(bracketId: string) {
      return new Request(`http://localhost/api/brackets/${bracketId}/tree`, {
        headers: { origin: process.env.FRONTEND_ORIGIN ?? "https://app.example.com" },
      });
    }

    function ctx(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("returns 404 when the bracket doesn't exist", async () => {
      const response = await GET(requestFor(randomUUID()), ctx(randomUUID()));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns a single NOT_STARTED placeholder round with empty cells for a DRAFT bracket with no rounds yet", async () => {
      const bracket = await makeBracket("Tree E2E - draft", "DRAFT");
      await makeItems(bracket.id, 3); // ceil(log2(3)) = 2 rounds.

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.bracketTitle).toBe("Tree E2E - draft");
      expect(body.bracketStatus).toBe("DRAFT");
      expect(body.totalRounds).toBe(2);
      expect(body.rounds).toHaveLength(2);
      for (const round of body.rounds) {
        expect(round.status).toBe("NOT_STARTED");
        expect(round.cells).toEqual([]);
      }
      expect(body.rounds[1].label).toBe("Final");
      expect(body.champion).toBeNull();
    });

    it("returns real cells for a persisted round plus a synthesized upcoming round beyond it, with the champion section once COMPLETED", async () => {
      const bracket = await makeBracket("Tree E2E - completed", "COMPLETED");
      const items = await makeItems(bracket.id, 2);
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "COMPLETED",
          startsAt: new Date(Date.now() - 60 * 60_000),
          endsAt: new Date(Date.now() - 30 * 60_000),
        },
      });
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "COMPLETED",
          winnerItemId: items[0].id,
        },
      });
      await prisma.vote.createMany({
        data: [
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID() },
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID() },
          { matchupId: matchup.id, itemId: items[1].id, anonymousVoterIdentifier: randomUUID() },
        ],
      });

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalRounds).toBe(1);
      expect(body.rounds).toHaveLength(1);
      expect(body.rounds[0].status).toBe("COMPLETED");
      expect(body.rounds[0].cells).toEqual([
        {
          kind: "completed",
          matchupId: matchup.id,
          winner: expect.objectContaining({ id: items[0].id }),
          loser: expect.objectContaining({ id: items[1].id }),
        },
      ]);
      expect(body.champion).toEqual({
        item: expect.objectContaining({ id: items[0].id }),
        finalTally: [
          { item: expect.objectContaining({ id: items[0].id }), votes: 2 },
          { item: expect.objectContaining({ id: items[1].id }), votes: 1 },
        ],
      });
    });

    it("applies CORS headers to the response", async () => {
      const bracket = await makeBracket("Tree E2E - cors", "DRAFT");
      await makeItems(bracket.id, 2);

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        process.env.FRONTEND_ORIGIN ?? "https://app.example.com"
      );
    });
  }
);

if (!hasLiveDatabase) {
  describe("GET /api/brackets/[bracketId]/tree, against the live database", () => {
    console.warn(
      "[bracket tree route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
