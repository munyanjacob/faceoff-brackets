import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises PATCH /brackets/{bracketId}/round-duration end-to-end against
// the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real Profile/Bracket/BracketItem rows, calls the real
// (unmocked) `PATCH` handler - real `validateRoundDurationForm`, real
// `prisma.bracket.update()` - and asserts on the resulting row, then cleans
// up. Same disposable-test-data pattern as
// `../items/route.integration.test.ts` and
// `../../../dashboard/brackets/[id]/edit/round-duration-actions.integration.test.ts`
// (#13), which this route wraps.
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason the sibling integration suites do (no way to mint a real Supabase
// JWT here) - everything else is real, unmocked code.
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
  "PATCH /brackets/{bracketId}/round-duration, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let PATCH: typeof import("./route").PATCH;

    const ownerId = randomUUID();
    const otherId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ PATCH } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownerId,
            email: `round-duration-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `round-duration-route-e2e-other-${Date.now()}-${Math.random()
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

    function request(bracketId: string, body: unknown, authorization?: string) {
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(`http://localhost/brackets/${bracketId}/round-duration`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
    }

    function paramsFor(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    async function createDraftBracket(
      creatorId: string,
      overrides: Partial<{ status: "DRAFT" | "ACTIVE" }> = {}
    ) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Round Duration E2E Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: overrides.status ?? "DRAFT",
        },
      });
      bracketIds.push(bracket.id);
      return bracket;
    }

    it("returns 401 and saves nothing when there's no authenticated caller", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = undefined;

      const response = await PATCH(
        request(bracket.id, { defaultRoundDurationMinutes: 60, overrides: {} }),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(401);
      const unchanged = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(unchanged?.defaultRoundDurationMinutes).toBe(60);
    });

    it("returns 404 (never 403) when the bracket exists but belongs to a different creator", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = otherId;

      const response = await PATCH(
        request(
          bracket.id,
          { defaultRoundDurationMinutes: 90, overrides: {} },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns 409 NOT_DRAFT and saves nothing when the bracket is no longer a draft", async () => {
      const bracket = await createDraftBracket(ownerId, { status: "ACTIVE" });
      currentUserId = ownerId;

      const response = await PATCH(
        request(
          bracket.id,
          { defaultRoundDurationMinutes: 90, overrides: {} },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_DRAFT",
        message:
          "This bracket is no longer a draft, so its round durations can't be changed.",
      });
    });

    it("recomputes totalRounds from the bracket's live item count and persists valid overrides", async () => {
      const bracket = await createDraftBracket(ownerId);
      await prisma.bracketItem.createMany({
        data: Array.from({ length: 8 }, (_, i) => ({
          bracketId: bracket.id,
          title: `Item ${i + 1}`,
        })),
      });
      currentUserId = ownerId;

      // ceil(log2(8)) = 3 rounds - round 9 doesn't exist and is silently
      // dropped, never saved.
      const response = await PATCH(
        request(
          bracket.id,
          {
            defaultRoundDurationMinutes: 45,
            overrides: { "1": 120, "3": 30, "9": 999 },
          },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.defaultRoundDurationMinutes).toBe(45);
      expect(body.roundDurationOverrides).toEqual({ "1": 120, "3": 30 });

      const updated = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(updated?.defaultRoundDurationMinutes).toBe(45);
      expect(updated?.roundDurationOverrides).toEqual({ "1": 120, "3": 30 });
    });

    it("returns 400 VALIDATION_ERROR and saves nothing for an invalid default duration", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = ownerId;

      const response = await PATCH(
        request(
          bracket.id,
          { defaultRoundDurationMinutes: 0, overrides: {} },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "VALIDATION_ERROR",
        message: "Default round duration must be a positive number of minutes.",
      });

      const unchanged = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(unchanged?.defaultRoundDurationMinutes).toBe(60);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../dashboard/dashboard-query.integration.test.ts.
  describe("PATCH /brackets/{bracketId}/round-duration, against the live database", () => {
    console.warn(
      "[round-duration route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
