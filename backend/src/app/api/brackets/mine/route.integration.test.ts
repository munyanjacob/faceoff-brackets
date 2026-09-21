import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises GET /brackets/mine end-to-end against the real, disposable
// Supabase/Postgres project configured in `.env.local`: seeds real
// Profile/Bracket/Round rows via `prisma`, calls the real (unmocked) `GET`
// handler, and asserts on the resulting JSON - same disposable-test-data
// pattern as `../../../dashboard/dashboard-query.integration.test.ts` (#8),
// which this route's query is copied from.
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked - it needs a
// real Supabase-issued JWT to verify against a live Supabase project, which
// this suite has no way to mint; mocking it is the same boundary
// `dashboard-query.integration.test.ts` already mocks (there,
// `@/lib/supabase/server`, for the same reason: a real Next.js
// cookie-bound session isn't available under Vitest either). Everything
// downstream - the Prisma query and the JSON it returns - is real,
// unmocked code.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    getAuthenticatedUserId: vi.fn(async () => currentUserId ?? null),
  };
});

// See ../../../dashboard/dashboard-query.integration.test.ts for why
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

describe.runIf(hasLiveDatabase)(
  "GET /brackets/mine, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const ownCreatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];
    const roundIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownCreatorId,
            email: `brackets-mine-route-e2e-own-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `brackets-mine-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
    });

    afterAll(async () => {
      if (roundIds.length > 0) {
        await prisma.round.deleteMany({ where: { id: { in: roundIds } } });
      }
      if (bracketIds.length > 0) {
        await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      }
      await prisma.profile.deleteMany({
        where: { id: { in: [ownCreatorId, otherCreatorId] } },
      });
      await prisma.$disconnect();
    });

    function request(authorization?: string) {
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request("http://localhost/brackets/mine", { headers });
    }

    it("returns 401 when there's no authenticated caller", async () => {
      currentUserId = undefined;

      const response = await GET(request());

      expect(response.status).toBe(401);
    });

    it("returns only the caller's own brackets, newest first, each with a roundNumber-only rounds summary", async () => {
      currentUserId = ownCreatorId;

      const older = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Sitcom",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
          createdAt: new Date("2026-01-01T12:00:00.000Z"),
        },
      });
      bracketIds.push(older.id);

      const newer = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Podcast",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
          createdAt: new Date("2026-01-15T12:00:00.000Z"),
        },
      });
      bracketIds.push(newer.id);

      const round = await prisma.round.create({
        data: {
          bracketId: newer.id,
          roundNumber: 2,
          durationMinutes: 60,
          status: "ACTIVE",
        },
      });
      roundIds.push(round.id);

      const otherBracket = await prisma.bracket.create({
        data: {
          creatorId: otherCreatorId,
          title: "Someone Else's Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(otherBracket.id);

      const response = await GET(request("Bearer token"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<{
        id: string;
        title: string;
        rounds: { roundNumber: number }[];
      }>;

      const titles = body.map((b) => b.title);
      expect(titles).toContain("Best Sitcom");
      expect(titles).toContain("Best Podcast");
      expect(titles).not.toContain("Someone Else's Bracket");

      // Newest first.
      expect(body.findIndex((b) => b.id === newer.id)).toBeLessThan(
        body.findIndex((b) => b.id === older.id)
      );

      const newerRow = body.find((b) => b.id === newer.id);
      expect(newerRow?.rounds).toEqual([{ roundNumber: 2 }]);
      const olderRow = body.find((b) => b.id === older.id);
      expect(olderRow?.rounds).toEqual([]);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../dashboard/dashboard-query.integration.test.ts.
  describe("GET /brackets/mine, against the live database", () => {
    console.warn(
      "[brackets/mine route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
