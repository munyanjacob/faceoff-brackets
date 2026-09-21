import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises GET /brackets/{bracketId} end-to-end against the real,
// disposable Supabase/Postgres project configured in `.env.local`: seeds a
// real Profile/Bracket, calls the real (unmocked) `GET` handler, and
// asserts on the resulting JSON.
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason `../mine/route.integration.test.ts` mocks it. Unlike that route,
// most cases here don't need the mock overridden at all: this endpoint is
// public, and a request with no `Authorization` header resolves
// `getAuthenticatedUserId` to `null` without ever needing a real token
// (see `../../../lib/api/auth.ts`) - only the "authenticated as the owner"
// and "authenticated as a different user" cases below set `currentUserId`.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    getAuthenticatedUserId: vi.fn(async (request: Request) => {
      // Mirrors the real function's own contract: no Authorization header
      // at all still resolves to null, exercised for real (not mocked)
      // wherever a test below sends no header.
      if (!request.headers.get("authorization")) return null;
      return currentUserId ?? null;
    }),
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
  "GET /brackets/{bracketId}, against the live database",
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
            email: `bracket-detail-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
            displayName: "The Owner",
          },
          {
            id: otherId,
            email: `bracket-detail-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
    });

    afterAll(async () => {
      if (bracketIds.length > 0) {
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
      return new Request(`http://localhost/brackets/${bracketId}`, {
        headers,
      });
    }

    function paramsFor(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("returns 404 for a bracket id that doesn't exist", async () => {
      const response = await GET(
        request(randomUUID()),
        paramsFor(randomUUID())
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("is reachable by anyone with the id, including a PRIVATE bracket, with no auth required", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Private Bracket",
          visibility: "PRIVATE",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      const response = await GET(request(bracket.id), paramsFor(bracket.id));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Private Bracket");
      expect(body.viewerIsOwner).toBe(false);
      expect(body.creator).toEqual({ displayName: "The Owner" });
    });

    it("returns viewerIsOwner: true only when authenticated as this bracket's own creator", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Owned Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      currentUserId = ownerId;
      const ownerResponse = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );
      expect((await ownerResponse.json()).viewerIsOwner).toBe(true);

      currentUserId = otherId;
      const otherResponse = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );
      expect((await otherResponse.json()).viewerIsOwner).toBe(false);

      const anonymousResponse = await GET(
        request(bracket.id),
        paramsFor(bracket.id)
      );
      expect((await anonymousResponse.json()).viewerIsOwner).toBe(false);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../dashboard/dashboard-query.integration.test.ts.
  describe("GET /brackets/{bracketId}, against the live database", () => {
    console.warn(
      "[brackets/[bracketId] route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
