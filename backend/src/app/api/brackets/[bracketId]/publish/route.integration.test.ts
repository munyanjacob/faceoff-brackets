import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateFirstRound } from "@/lib/bracket/generate-first-round";

// Exercises POST /brackets/{bracketId}/publish end-to-end against the real,
// disposable Supabase/Postgres project configured in `.env.local`: seeds
// real Profile + Bracket (+ BracketItem) rows, calls the real (unmocked)
// `POST` handler, and asserts the real persisted `Bracket` row *and* the
// real `Round`/`Matchup` rows the transaction created, then cleans
// everything up. Same disposable-test-data / live-DB pattern as
// `../../../../dashboard/brackets/[id]/edit/publish-actions.integration.test.ts`
// (the Server Action this route wraps) and
// `../../route.integration.test.ts` (this REST API's own convention).
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked (no way to
// mint a real Supabase JWT here) - everything else, including
// `buildRoundOnePlan`/`generateFirstRound`, is real, unmocked code.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    getAuthenticatedUserId: vi.fn(async () => currentUserId ?? null),
  };
});

// See ../../../../dashboard/dashboard-query.integration.test.ts for why
// DATABASE_URL needs re-reading directly from .env.local rather than
// trusting Vite's ($-mangled) copy of it, and why this must happen before
// @/lib/prisma is ever imported.
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

const FUTURE = new Date("2999-01-01T09:00:00.000Z");

describe.runIf(hasLiveDatabase)(
  "POST /brackets/{bracketId}/publish, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let POST: typeof import("./route").POST;

    const creatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];

    let readyBracketId: string;
    let scheduledReadyBracketId: string;
    let tooFewItemsBracketId: string;
    let otherCreatorBracketId: string;
    let alreadyActiveBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ POST } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `publish-route-e2e-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `publish-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      async function makeDraftBracket(
        title: string,
        opts: {
          scheduledStartAt?: Date;
          itemCount: number;
          creator?: string;
        }
      ) {
        const created = await prisma.bracket.create({
          data: {
            creatorId: opts.creator ?? creatorId,
            title,
            visibility: "PUBLIC",
            votingRequirement: "ANONYMOUS_ALLOWED",
            defaultRoundDurationMinutes: 60,
            status: "DRAFT",
            scheduledStartAt: opts.scheduledStartAt ?? null,
          },
        });
        bracketIds.push(created.id);
        for (let i = 0; i < opts.itemCount; i++) {
          await prisma.bracketItem.create({
            data: { bracketId: created.id, title: `Item ${i + 1}` },
          });
        }
        return created.id;
      }

      readyBracketId = await makeDraftBracket(
        "Best Sitcom (publish route e2e, immediate)",
        { itemCount: 3 }
      );
      scheduledReadyBracketId = await makeDraftBracket(
        "Best Movie (publish route e2e, scheduled)",
        { itemCount: 2, scheduledStartAt: FUTURE }
      );
      tooFewItemsBracketId = await makeDraftBracket(
        "Too Few Items (publish route e2e)",
        { itemCount: 1 }
      );
      otherCreatorBracketId = await makeDraftBracket(
        "Someone Else's Draft (publish route e2e)",
        { itemCount: 3, creator: otherCreatorId }
      );

      const alreadyActiveBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Already Active (publish route e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
        },
      });
      alreadyActiveBracketId = alreadyActiveBracket.id;
      bracketIds.push(alreadyActiveBracketId);
    });

    afterAll(async () => {
      // Delete children before parents (`onDelete: Restrict` throughout the
      // schema) so this suite never leaves test data behind in the one live
      // database this project has.
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({ where: { bracketId: { in: bracketIds } } });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({
        where: { id: { in: [creatorId, otherCreatorId] } },
      });
      await prisma.$disconnect();
    });

    function request(bracketId: string, authorization?: string) {
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(`http://localhost/brackets/${bracketId}/publish`, {
        method: "POST",
        headers,
      });
    }

    function context(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("publishes to ACTIVE, sets publishedAt, and persists round 1's real Round (ACTIVE) and Matchups (bye COMPLETED + real ACTIVE), matching generateFirstRound's own pairings", async () => {
      currentUserId = creatorId;
      const before = new Date();

      // `readyBracketId` has 3 items, seeded in creation order - same order
      // the route itself reads them in (`orderBy: { createdAt: "asc" }`).
      const items = await prisma.bracketItem.findMany({
        where: { bracketId: readyBracketId },
        orderBy: { createdAt: "asc" },
      });
      const expectedPairings = generateFirstRound(items);

      const response = await POST(request(readyBracketId, "Bearer token"), context(readyBracketId));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("ACTIVE");
      expect(body.publishedAt).not.toBeNull();

      const updatedBracket = await prisma.bracket.findUnique({
        where: { id: readyBracketId },
      });
      expect(updatedBracket?.status).toBe("ACTIVE");
      expect(updatedBracket?.publishedAt).not.toBeNull();
      expect(updatedBracket!.publishedAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );

      const rounds = await prisma.round.findMany({
        where: { bracketId: readyBracketId },
      });
      expect(rounds).toHaveLength(1);
      const round = rounds[0];
      expect(round.roundNumber).toBe(1);
      expect(round.durationMinutes).toBe(60);
      expect(round.status).toBe("ACTIVE");
      expect(round.startsAt).not.toBeNull();
      expect(round.endsAt).not.toBeNull();
      expect(round.endsAt!.getTime() - round.startsAt!.getTime()).toBe(
        60 * 60_000
      );

      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      // 3 items -> next power of two is 4 -> 1 bye + 1 real matchup.
      expect(matchups).toHaveLength(2);

      const byeMatchup = matchups.find((m) => m.itemBId === null);
      expect(byeMatchup).toBeDefined();
      expect(byeMatchup!.winnerItemId).toBe(byeMatchup!.itemAId);
      expect(byeMatchup!.status).toBe("COMPLETED");

      const realMatchup = matchups.find((m) => m.itemBId !== null);
      expect(realMatchup).toBeDefined();
      expect(realMatchup!.status).toBe("ACTIVE");
      expect(realMatchup!.winnerItemId).toBeNull();

      // Cross-check: the persisted (itemA, itemB) pairs match exactly what
      // generateFirstRound (#17) produces directly for the same item list -
      // proving this route can never drift from the dashboard's preview or
      // the publish-actions.ts Server Action.
      const persistedPairs = matchups
        .map((m) => [m.itemAId, m.itemBId] as const)
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
      const expectedPairs = expectedPairings
        .map((p) => [p.itemA.id, p.itemB?.id ?? null] as const)
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
      expect(persistedPairs).toEqual(expectedPairs);
    });

    it("publishes to SCHEDULED with a PENDING Round/Matchup when a future start time was chosen", async () => {
      currentUserId = creatorId;

      const response = await POST(
        request(scheduledReadyBracketId, "Bearer token"),
        context(scheduledReadyBracketId)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("SCHEDULED");

      const rounds = await prisma.round.findMany({
        where: { bracketId: scheduledReadyBracketId },
      });
      expect(rounds).toHaveLength(1);
      const round = rounds[0];
      expect(round.status).toBe("PENDING");
      expect(round.startsAt).toBeNull();
      expect(round.endsAt).toBeNull();

      // 2 items -> 0 byes, 1 real matchup.
      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      expect(matchups).toHaveLength(1);
      expect(matchups[0].status).toBe("PENDING");
      expect(matchups[0].itemBId).not.toBeNull();
      expect(matchups[0].winnerItemId).toBeNull();
    });

    it("returns 409 TOO_FEW_ITEMS and persists nothing when there is only 1 item", async () => {
      currentUserId = creatorId;

      const response = await POST(
        request(tooFewItemsBracketId, "Bearer token"),
        context(tooFewItemsBracketId)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "TOO_FEW_ITEMS",
        message: "Add at least 2 items before publishing this bracket.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: tooFewItemsBracketId },
      });
      expect(unchanged?.status).toBe("DRAFT");
      expect(unchanged?.publishedAt).toBeNull();

      const rounds = await prisma.round.findMany({
        where: { bracketId: tooFewItemsBracketId },
      });
      expect(rounds).toHaveLength(0);
    });

    it("returns 404 NOT_FOUND instead of publishing another creator's draft bracket", async () => {
      currentUserId = creatorId;

      const response = await POST(
        request(otherCreatorBracketId, "Bearer token"),
        context(otherCreatorBracketId)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: otherCreatorBracketId },
      });
      expect(unchanged?.status).toBe("DRAFT");
    });

    it("returns 409 NOT_DRAFT with the exact existing message, and publishes nothing again, once the bracket is already ACTIVE", async () => {
      currentUserId = creatorId;
      const before = await prisma.bracket.findUnique({
        where: { id: alreadyActiveBracketId },
      });

      const response = await POST(
        request(alreadyActiveBracketId, "Bearer token"),
        context(alreadyActiveBracketId)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_DRAFT",
        message: "This bracket has already been published.",
      });

      const after = await prisma.bracket.findUnique({
        where: { id: alreadyActiveBracketId },
      });
      expect(after?.status).toBe(before?.status);
      expect(after?.publishedAt).toEqual(before?.publishedAt);

      const rounds = await prisma.round.findMany({
        where: { bracketId: alreadyActiveBracketId },
      });
      expect(rounds).toHaveLength(0);
    });

    it("returns 401 and persists nothing when there is no authenticated caller", async () => {
      currentUserId = undefined;

      const before = await prisma.bracket.findUnique({
        where: { id: readyBracketId },
      });

      const response = await POST(request(readyBracketId), context(readyBracketId));

      expect(response.status).toBe(401);

      const after = await prisma.bracket.findUnique({
        where: { id: readyBracketId },
      });
      expect(after?.status).toBe(before?.status);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../dashboard/dashboard-query.integration.test.ts.
  describe("POST /brackets/{bracketId}/publish, against the live database", () => {
    console.warn(
      "[publish route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
