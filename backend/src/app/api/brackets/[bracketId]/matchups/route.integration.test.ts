import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #55's GET /api/brackets/[bracketId]/matchups end-to-end
// against the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real `Profile`/`Bracket`/`BracketItem`/`Round`/
// `Matchup` rows via `prisma`, calls the real (unmocked) route handler, and
// asserts on the resulting JSON. Same live-database pattern as
// `../../../../brackets/[id]/vote-actions.integration.test.ts` and
// `src/lib/rounds/evaluate-round.integration.test.ts` - see those for the
// fuller rationale on why this needs a real database rather than a mock
// (in particular: proving `listVotableMatchups` is actually called against
// real Prisma row shapes, not just a hand-shaped mock object).
//
// No identity/auth is exercised here - `VotableMatchupsResponse` carries no
// per-voter personalization (see ./route.ts's top comment), so this suite
// is pure bracket/round/matchup state -> response shape.
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
  "GET /api/brackets/[bracketId]/matchups, against the live database",
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
          email: `matchups-list-e2e-${Date.now()}-${Math.random()
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
      status: "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED",
      extra: { scheduledStartAt?: Date } = {}
    ) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title,
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status,
          ...extra,
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
      return new Request(`http://localhost/api/brackets/${bracketId}/matchups`);
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

    it("returns the scheduled-start message for a SCHEDULED bracket", async () => {
      const scheduledStartAt = new Date(Date.now() + 60 * 60_000);
      const bracket = await makeBracket("List E2E - scheduled", "SCHEDULED", {
        scheduledStartAt,
      });

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));
      const body = await response.json();

      expect(body.kind).toBe("message");
      expect(body.message).toContain("scheduled to begin at");
    });

    it("returns the completed message for a COMPLETED bracket", async () => {
      const bracket = await makeBracket("List E2E - completed", "COMPLETED");

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));

      await expect(response.json()).resolves.toEqual({
        kind: "message",
        message: "This bracket has finished. Voting is closed.",
      });
    });

    it("returns the between-rounds message for an ACTIVE bracket with no ACTIVE round", async () => {
      const bracket = await makeBracket("List E2E - between rounds", "ACTIVE");
      const items = await makeItems(bracket.id, 2);
      await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "COMPLETED",
          startsAt: new Date(Date.now() - 2 * 60 * 60_000),
          endsAt: new Date(Date.now() - 60 * 60_000),
          matchups: {
            create: [
              {
                itemAId: items[0].id,
                itemBId: items[1].id,
                status: "COMPLETED",
                winnerItemId: items[0].id,
              },
            ],
          },
        },
      });

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));

      await expect(response.json()).resolves.toEqual({
        kind: "message",
        message:
          "Voting isn't open right now - check back soon for the next round.",
      });
    });

    it("returns every votable matchup in the ACTIVE round, with full BracketItem-shaped itemA/itemB", async () => {
      const bracket = await makeBracket("List E2E - multiple matchups", "ACTIVE");
      const items = await makeItems(bracket.id, 4);
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
          matchups: {
            create: [
              { itemAId: items[0].id, itemBId: items[1].id, status: "ACTIVE" },
              { itemAId: items[2].id, itemBId: items[3].id, status: "TIE_BREAKER" },
            ],
          },
        },
        include: { matchups: true },
      });

      const response = await GET(requestFor(bracket.id), ctx(bracket.id));
      const body = await response.json();

      expect(body.kind).toBe("matchups");
      expect(body.matchups).toHaveLength(2);
      const statuses = body.matchups.map((m: { status: string }) => m.status).sort();
      expect(statuses).toEqual(["ACTIVE", "TIE_BREAKER"]);
      const firstMatchup = body.matchups.find(
        (m: { id: string }) => m.id === round.matchups[0].id
      );
      expect(firstMatchup.itemA).toMatchObject({
        id: items[0].id,
        bracketId: bracket.id,
        title: "Item 1",
      });
      expect(firstMatchup.itemB).toMatchObject({ id: items[1].id });
    });

    it("applies CORS headers to the response", async () => {
      const bracket = await makeBracket("List E2E - cors", "COMPLETED");
      const request = new Request(
        `http://localhost/api/brackets/${bracket.id}/matchups`,
        { headers: { origin: process.env.FRONTEND_ORIGIN ?? "https://app.example.com" } }
      );

      const response = await GET(request, ctx(bracket.id));

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        process.env.FRONTEND_ORIGIN ?? "https://app.example.com"
      );
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing,
  // same reasoning as ../../../../brackets/[id]/vote-actions.integration.test.ts.
  describe("GET /api/brackets/[bracketId]/matchups, against the live database", () => {
    console.warn(
      "[matchups list route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
