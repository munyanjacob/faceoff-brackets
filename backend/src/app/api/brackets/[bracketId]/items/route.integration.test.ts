import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises GET /brackets/{bracketId}/items end-to-end against the real,
// disposable Supabase/Postgres project configured in `.env.local`: seeds
// real Profile/Bracket/BracketItem rows, calls the real (unmocked) `GET`
// handler, and asserts on the resulting JSON - same disposable-test-data
// pattern as
// `../../../../dashboard/brackets/[id]/edit/page.test.tsx`'s live-query
// sibling would use; this route's lookup+query is copied from
// `../../../../dashboard/brackets/[id]/edit/page.tsx` (#11).
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason `../route.integration.test.ts` mocks it.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    getAuthenticatedUserId: vi.fn(async (request: Request) => {
      if (!request.headers.get("authorization")) return null;
      return currentUserId ?? null;
    }),
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

describe.runIf(hasLiveDatabase)(
  "GET /brackets/{bracketId}/items, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const ownerId = randomUUID();
    const otherId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownerId,
            email: `bracket-items-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `bracket-items-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
    });

    afterAll(async () => {
      if (bracketIds.length > 0) {
        await prisma.bracketItem.deleteMany({
          where: { bracketId: { in: bracketIds } },
        });
        await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      }
      await prisma.profile.deleteMany({
        where: { id: { in: [ownerId, otherId] } },
      });
      await prisma.$disconnect();
    });

    function request(bracketId: string, authorization?: string) {
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(`http://localhost/brackets/${bracketId}/items`, {
        headers,
      });
    }

    function paramsFor(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("returns 401 when there's no authenticated caller", async () => {
      const bracketId = randomUUID();

      const response = await GET(request(bracketId), paramsFor(bracketId));

      expect(response.status).toBe(401);
    });

    it("returns 404 when the bracket doesn't exist", async () => {
      currentUserId = ownerId;

      const response = await GET(
        request(randomUUID(), "Bearer token"),
        paramsFor(randomUUID())
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns 404 (never 403) when the bracket exists but belongs to a different creator", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Owner's Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      currentUserId = otherId;
      const response = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns the owner's items in creation order", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Bracket With Items",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      const first = await prisma.bracketItem.create({
        data: { bracketId: bracket.id, title: "First Item" },
      });
      const second = await prisma.bracketItem.create({
        data: { bracketId: bracket.id, title: "Second Item" },
      });

      currentUserId = ownerId;
      const response = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.map((item: { id: string }) => item.id)).toEqual([
        first.id,
        second.id,
      ]);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../dashboard/dashboard-query.integration.test.ts.
  describe("GET /brackets/{bracketId}/items, against the live database", () => {
    console.warn(
      "[brackets/[bracketId]/items route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
