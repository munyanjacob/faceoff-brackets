import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #8's actual query end-to-end against the real, disposable
// Supabase/Postgres project configured in `.env.local`: seeds real `Profile`
// and `Bracket` (and `Round`) rows via `prisma.bracket.create()`/friends,
// then renders the real `DashboardPage()` (only its auth layer is mocked -
// see below) and asserts on the resulting output. This is the one part of
// #8 that can't be verified with mocks: whether `prisma.bracket.findMany`
// really does scope to the signed-in creator and really does drive
// `toBracketRow`/`<BracketList>` correctly end-to-end.
//
// Unlike `../signup/profile-sync.integration.test.ts`, this suite does not
// need an ad hoc, not-installed `pg` client: `@prisma/adapter-pg` (approved
// for this issue) is now a real, committed dependency, and
// `src/lib/prisma.ts` is the app's own Prisma client - the very thing this
// query needs to run at all. So the only gate here is live database
// credentials, not a `pg`-availability check.
//
// `src/lib/supabase/server.ts`'s `createClient()` needs a real Next.js
// request scope for `next/headers`'s `cookies()`, which Vitest doesn't
// provide - mocked the same way `./page.test.tsx` and
// `./layout.test.tsx` already do, so this suite can drive the real
// `DashboardPage()` component without a real signed-in browser session.
// Everything downstream of that mock (the Prisma query, the view-model
// mapping, and `<BracketList>`'s rendering) is the real, unmocked code.
let currentUserId: string | undefined;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: currentUserId ? { id: currentUserId } : null },
        error: null,
      })),
    },
  })),
}));

// `vitest.config.ts` loads `.env.local` via Vite's `loadEnv`, which runs
// shell-style `$VAR` interpolation over every value (dotenv-expand
// semantics). This project's real `DATABASE_URL` password contains `$`
// sequences that happen to look like variable references, so Vite's copy of
// `process.env.DATABASE_URL` silently mangles the password and any real
// connection with it fails Postgres auth - the exact same issue already
// documented (for `DIRECT_URL`) in
// `../signup/profile-sync.integration.test.ts`. `src/lib/prisma.ts` reads
// `process.env.DATABASE_URL` directly, and eagerly (at module-import time),
// so it must be corrected *before* that module is ever imported below.
// `process.loadEnvFile` never overwrites a key that's already set, so
// deleting Vite's (wrong) value first forces a fresh, correctly-parsed read
// straight from the file.
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
  "/dashboard page's Bracket query, against the live database",
  () => {
    // Imported dynamically (after the env fix and the vi.mock above are
    // both in place) rather than with a static import, so module
    // evaluation order is guaranteed: `@/lib/prisma` must not construct its
    // client until `process.env.DATABASE_URL` has been corrected.
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let DashboardPage: typeof import("./page").default;

    const ownCreatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];
    const roundIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ default: DashboardPage } = await import("./page"));

      // Disposable test creators - never real signed-up users. A second,
      // "other" creator exists purely to prove this creator's own brackets
      // stay isolated from another creator's.
      await prisma.profile.createMany({
        data: [
          {
            id: ownCreatorId,
            email: `dashboard-query-e2e-own-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `dashboard-query-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
    });

    afterAll(async () => {
      // Delete children before parents (`onDelete: Restrict` throughout the
      // schema) so this suite never leaves test data behind in the one live
      // database this project has.
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

    it("renders an explicit 'none yet' message in every section for a creator with no brackets yet", async () => {
      currentUserId = ownCreatorId;

      const result = await DashboardPage();

      const html = JSON.stringify(result);
      expect(html).toContain("No drafts yet.");
      expect(html).toContain("No scheduled yet.");
      expect(html).toContain("No active yet.");
      expect(html).toContain("No completed yet.");
    });

    it("shows only the signed-in creator's own brackets, grouped by status, newest first within each group", async () => {
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

      const newerDraft = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Podcast",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
          createdAt: new Date("2026-01-15T12:00:00.000Z"),
        },
      });
      bracketIds.push(newerDraft.id);

      const scheduled = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Song",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "SCHEDULED",
          createdAt: new Date("2026-01-20T12:00:00.000Z"),
        },
      });
      bracketIds.push(scheduled.id);

      const active = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Movie",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
          createdAt: new Date("2026-02-01T12:00:00.000Z"),
        },
      });
      bracketIds.push(active.id);

      // `active`'s current round is the highest of its Round rows.
      const round = await prisma.round.create({
        data: {
          bracketId: active.id,
          roundNumber: 2,
          durationMinutes: 60,
          status: "ACTIVE",
        },
      });
      roundIds.push(round.id);

      const completed = await prisma.bracket.create({
        data: {
          creatorId: ownCreatorId,
          title: "Best Game",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "COMPLETED",
          createdAt: new Date("2026-03-01T12:00:00.000Z"),
        },
      });
      bracketIds.push(completed.id);

      // Another creator's bracket - must never appear for `ownCreatorId`.
      const otherBracket = await prisma.bracket.create({
        data: {
          creatorId: otherCreatorId,
          title: "Someone Elses Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(otherBracket.id);

      const result = await DashboardPage();
      const html = JSON.stringify(result);

      expect(html).toContain("Best Sitcom");
      expect(html).toContain("Best Podcast");
      expect(html).toContain("Best Song");
      expect(html).toContain("Best Movie");
      expect(html).toContain("Best Game");
      expect(html).not.toContain("Someone Elses Bracket");

      expect(html).toContain("DRAFT");
      expect(html).toContain("SCHEDULED");
      expect(html).toContain("ACTIVE");
      expect(html).toContain("COMPLETED");
      // `active` has a Round row (roundNumber 2); the others have none, so
      // their current round is the "-" placeholder.
      expect(html).toMatch(/"-"/);

      expect(html).toContain("January 1, 2026");
      expect(html).toContain("March 1, 2026");

      // Newest-first within the DRAFT section: "Best Podcast" (Jan 15)
      // before "Best Sitcom" (Jan 1).
      expect(html.indexOf("Best Podcast")).toBeLessThan(
        html.indexOf("Best Sitcom")
      );

      // Drafts/scheduled link to the edit flow; active/completed link to
      // the (placeholder) public bracket view.
      expect(html).toContain(`/dashboard/brackets/${older.id}/edit`);
      expect(html).toContain(`/dashboard/brackets/${scheduled.id}/edit`);
      expect(html).toContain(`/brackets/${active.id}`);
      expect(html).toContain(`/brackets/${completed.id}`);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../signup/profile-sync.integration.test.ts`.
  describe("/dashboard page's Bracket query, against the live database", () => {
    console.warn(
      "[dashboard-query.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
