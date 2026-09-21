import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises POST /brackets end-to-end against the real, disposable
// Supabase/Postgres project configured in `.env.local`: calls the real
// (unmocked) `POST` handler - real `validateCreateBracketForm`, real
// `prisma.bracket.create()` - and asserts on the resulting row, then cleans
// up. Same disposable-test-data pattern as
// `../../dashboard/brackets/new/actions.integration.test.ts` (#10), which
// this route wraps.
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason `./mine/route.integration.test.ts` mocks it (no way to mint a real
// Supabase JWT here) - everything else is real, unmocked code.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    getAuthenticatedUserId: vi.fn(async () => currentUserId ?? null),
  };
});

// See ../../dashboard/dashboard-query.integration.test.ts for why
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
  "POST /brackets, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let POST: typeof import("./route").POST;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ POST } = await import("./route"));

      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `create-bracket-route-e2e-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
        },
      });
    });

    afterAll(async () => {
      if (bracketIds.length > 0) {
        await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      }
      await prisma.profile.delete({ where: { id: creatorId } });
      await prisma.$disconnect();
    });

    function request(body: unknown, authorization?: string) {
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request("http://localhost/brackets", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }

    it("creates a real DRAFT Bracket row owned by the caller", async () => {
      currentUserId = creatorId;

      const response = await POST(
        request(
          {
            title: "Best Sitcom (route e2e)",
            description: "A friendly poll.",
            visibility: "PUBLIC",
            votingRequirement: "ANONYMOUS_ALLOWED",
          },
          "Bearer token"
        )
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      bracketIds.push(body.id);

      expect(body.status).toBe("DRAFT");
      expect(body.creatorId).toBe(creatorId);
      expect(body.defaultRoundDurationMinutes).toBe(60);

      const created = await prisma.bracket.findUnique({
        where: { id: body.id },
      });
      expect(created).not.toBeNull();
      expect(created?.title).toBe("Best Sitcom (route e2e)");
      expect(created?.description).toBe("A friendly poll.");
    });

    it("creates no row and returns 401 when there's no authenticated caller", async () => {
      currentUserId = undefined;

      const before = await prisma.bracket.count({ where: { creatorId } });

      const response = await POST(
        request({
          title: "Should Not Exist",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
        })
      );

      expect(response.status).toBe(401);
      const after = await prisma.bracket.count({ where: { creatorId } });
      expect(after).toBe(before);
    });

    it("creates no row when the title is missing", async () => {
      currentUserId = creatorId;

      const before = await prisma.bracket.count({ where: { creatorId } });

      const response = await POST(
        request(
          { visibility: "PUBLIC", votingRequirement: "ANONYMOUS_ALLOWED" },
          "Bearer token"
        )
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "VALIDATION_ERROR",
        message: "Title is required.",
      });

      const after = await prisma.bracket.count({ where: { creatorId } });
      expect(after).toBe(before);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../dashboard/dashboard-query.integration.test.ts.
  describe("POST /brackets, against the live database", () => {
    console.warn(
      "[brackets route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
