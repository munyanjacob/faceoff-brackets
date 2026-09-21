import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises issue #58's `GET /api/discover` route end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds real `Profile` and `Bracket` rows via `prisma.bracket.create()`
// covering every `visibility`/`status` combination that matters, calls the
// real `GET` handler, and asserts on the actual JSON response - only the
// right brackets show up in the right groups, with the raw ISO
// `publishedAt` the wire contract requires (not the HTML page's
// human-formatted string). Same reasoning and pattern as
// `../../discover/discover-query.integration.test.ts`, which this suite
// intentionally mirrors rather than duplicates unit-level assertions from
// (see `./route.test.ts` for the mocked-Prisma coverage of grouping,
// `creatorName` fallback, CORS, and the 500 fallback).
//
// See that same file's comments for why `DATABASE_URL` is re-read directly
// from `.env.local` (Vite's `loadEnv` mangles the `$`-containing password)
// before `@/lib/prisma` is ever imported.
function fixDatabaseUrlFromEnvFile(): string | undefined {
  delete process.env.DATABASE_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DATABASE_URL left unset.
  }
  return process.env.DATABASE_URL;
}

const hasLiveDatabase = Boolean(fixDatabaseUrlFromEnvFile());

// Mirrors ./cors.ts's own fallback (see ../../lib/api/cors.test.ts) so this
// suite works whether or not FRONTEND_ORIGIN is set in the environment.
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

describe.runIf(hasLiveDatabase)(
  "GET /api/discover, against the live database",
  () => {
    // Imported dynamically (after the env fix above) so module evaluation
    // order is guaranteed: `@/lib/prisma` must not construct its client
    // until `process.env.DATABASE_URL` has been corrected.
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      // A disposable test creator - never a real signed-up user.
      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `discover-api-e2e-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
          displayName: "Discover API E2E Creator",
        },
      });
    });

    afterAll(async () => {
      // Delete children before parents (`onDelete: Restrict` throughout the
      // schema) so this suite never leaves test data behind in the one live
      // database this project has.
      if (bracketIds.length > 0) {
        await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      }
      await prisma.profile.deleteMany({ where: { id: creatorId } });
      await prisma.$disconnect();
    });

    async function makeBracket(overrides: {
      title: string;
      visibility: "PUBLIC" | "PRIVATE";
      status: "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";
      publishedAt: Date | null;
    }) {
      const created = await prisma.bracket.create({
        data: {
          creatorId,
          title: overrides.title,
          visibility: overrides.visibility,
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: overrides.status,
          publishedAt: overrides.publishedAt,
        },
      });
      bracketIds.push(created.id);
      return created;
    }

    function request() {
      return new Request("http://localhost/api/discover", {
        headers: { origin: ALLOWED_ORIGIN },
      });
    }

    // Deliberately no "the response is empty when there's nothing" live-DB
    // test here: `/discover` is a genuinely global, unscoped query, so
    // asserting "every group is empty" would be a flaky assertion about the
    // whole shared database rather than about this test's own behavior -
    // same reasoning as `../../discover/discover-query.integration.test.ts`.
    // The "nothing here yet" response is already covered, deterministically,
    // by `./route.test.ts`'s mocked-Prisma test.
    it("returns only PUBLIC, non-DRAFT brackets, correctly grouped, with raw ISO publishedAt", async () => {
      const recentBracket = await makeBracket({
        title: "Live API Recent Bracket",
        visibility: "PUBLIC",
        status: "SCHEDULED",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
      });
      const activeBracket = await makeBracket({
        title: "Live API Active Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
      });
      const completedBracket = await makeBracket({
        title: "Live API Completed Bracket",
        visibility: "PUBLIC",
        status: "COMPLETED",
        publishedAt: new Date("2026-08-01T12:00:00.000Z"),
      });
      // Must never appear, in any grouping.
      await makeBracket({
        title: "Live API Private Bracket",
        visibility: "PRIVATE",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-12T12:00:00.000Z"),
      });
      // Not published yet - must never appear.
      await makeBracket({
        title: "Live API Draft Bracket",
        visibility: "PUBLIC",
        status: "DRAFT",
        publishedAt: null,
      });

      const response = await GET(request());
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.recent).toEqual([
        {
          id: recentBracket.id,
          title: "Live API Recent Bracket",
          status: "SCHEDULED",
          publishedAt: "2026-09-10T12:00:00.000Z",
          creatorName: "Discover API E2E Creator",
        },
      ]);
      expect(body.active).toEqual([
        {
          id: activeBracket.id,
          title: "Live API Active Bracket",
          status: "ACTIVE",
          publishedAt: "2026-09-05T12:00:00.000Z",
          creatorName: "Discover API E2E Creator",
        },
      ]);
      expect(body.completed).toEqual([
        {
          id: completedBracket.id,
          title: "Live API Completed Bracket",
          status: "COMPLETED",
          publishedAt: "2026-08-01T12:00:00.000Z",
          creatorName: "Discover API E2E Creator",
        },
      ]);

      const allIds = [
        ...body.recent,
        ...body.active,
        ...body.completed,
      ].map((row: { id: string }) => row.id);
      expect(allIds).not.toContain(undefined);
      const allTitles = [
        ...body.recent,
        ...body.active,
        ...body.completed,
      ].map((row: { title: string }) => row.title);
      expect(allTitles).not.toContain("Live API Private Bracket");
      expect(allTitles).not.toContain("Live API Draft Bracket");
    });

    it("applies CORS headers to the live response", async () => {
      const response = await GET(request());

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        ALLOWED_ORIGIN
      );
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing,
  // same reasoning as `../../discover/discover-query.integration.test.ts`.
  describe("GET /api/discover, against the live database", () => {
    console.warn(
      "[route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
