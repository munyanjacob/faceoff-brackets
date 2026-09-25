import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `connection()` needs a real request scope, which calling the page
// directly doesn't provide.
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));

// Exercises issue #34's actual query end-to-end against the real,
// disposable Supabase/Postgres project configured in `.env.local`: seeds
// real `Profile` and `Bracket` rows via `prisma.bracket.create()` covering
// every `visibility`/`status` combination that matters, renders the real
// `DiscoverPage()` (no auth mocking needed - this route has none), and
// asserts only the right brackets show up in the right groups. Same
// reasoning and pattern as `../dashboard/dashboard-query.integration.test.ts`
// - this is the one part of #34 that can't be verified with mocks: whether
// `prisma.bracket.findMany`'s `where`/`orderBy` really do the right thing
// against a real database, end-to-end through `groupPublicBrackets` and
// `<DiscoveryGroups>`.
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

describe.runIf(hasLiveDatabase)(
  "/discover page's Bracket query, against the live database",
  () => {
    // Imported dynamically (after the env fix above) so module evaluation
    // order is guaranteed: `@/lib/prisma` must not construct its client
    // until `process.env.DATABASE_URL` has been corrected.
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let DiscoverPage: typeof import("./page").default;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ default: DiscoverPage } = await import("./page"));

      // A disposable test creator - never a real signed-up user.
      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `discover-e2e-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}@example.test`,
          displayName: "Discover E2E Creator",
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

    // Deliberately no "the page is empty when there's nothing" live-DB test
    // here: `/discover` is a genuinely global, unscoped query (unlike
    // `../dashboard`'s, which is scoped to one `creatorId` and so is immune
    // to this) - this project's other live-DB integration suites
    // (`../dashboard/brackets/[id]/edit/*.integration.test.ts`) create
    // their own PUBLIC/ACTIVE fixture brackets in the same shared database
    // and may run concurrently with this one, so asserting "every group is
    // empty" here would be a flaky assertion about the whole database, not
    // about this test's own behavior. The "nothing here yet" rendering
    // path is already covered, deterministically, by `./page.test.tsx`'s
    // mocked-Prisma tests. This suite instead only asserts on the specific
    // fixture brackets it creates and cleans up itself.
    it("shows only PUBLIC, non-DRAFT brackets, correctly grouped by status", async () => {
      await makeBracket({
        title: "Live Recent Bracket",
        visibility: "PUBLIC",
        status: "SCHEDULED",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
      });
      await makeBracket({
        title: "Live Active Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
      });
      await makeBracket({
        title: "Live Completed Bracket",
        visibility: "PUBLIC",
        status: "COMPLETED",
        publishedAt: new Date("2026-08-01T12:00:00.000Z"),
      });
      // Must never appear, in any grouping.
      await makeBracket({
        title: "Live Private Bracket",
        visibility: "PRIVATE",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-12T12:00:00.000Z"),
      });
      // Not published yet - must never appear.
      await makeBracket({
        title: "Live Draft Bracket",
        visibility: "PUBLIC",
        status: "DRAFT",
        publishedAt: null,
      });

      const result = await DiscoverPage();
      const html = JSON.stringify(result);

      expect(html).toContain("Live Recent Bracket");
      expect(html).toContain("Live Active Bracket");
      expect(html).toContain("Live Completed Bracket");
      expect(html).not.toContain("Live Private Bracket");
      expect(html).not.toContain("Live Draft Bracket");

      expect(html).toContain("Discover E2E Creator");
      expect(html).toContain("September 10, 2026");
      expect(html).toContain("September 5, 2026");
      expect(html).toContain("August 1, 2026");
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing,
  // same reasoning as `../dashboard/dashboard-query.integration.test.ts`.
  describe("/discover page's Bracket query, against the live database", () => {
    console.warn(
      "[discover-query.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
