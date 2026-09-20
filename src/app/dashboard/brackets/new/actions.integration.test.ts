import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #10's `createBracket` Server Action end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds a real `Profile` row, calls the real (unmocked) action, asserts the
// resulting `Bracket` row, then cleans both up. Same disposable-test-data
// pattern as `../../dashboard-query.integration.test.ts` (#8) and
// `../../../signup/profile-sync.integration.test.ts` (#7) - see those for
// the fuller rationale.
//
// Only `@/lib/supabase/server` is mocked (it needs a real Next.js request
// scope for `next/headers`'s `cookies()`, which Vitest doesn't provide);
// everything downstream - validation, `prisma.bracket.create()`, and the
// redirect - is the real, unmocked code from `./actions.ts`.
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

// See ../../dashboard-query.integration.test.ts for why DATABASE_URL needs
// re-reading directly from .env.local rather than trusting Vite's
// (`$`-mangled) copy of it, and why this must happen before `@/lib/prisma`
// is ever imported.
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

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe.runIf(hasLiveDatabase)(
  "createBracket action, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let createBracket: typeof import("./actions").createBracket;
    let initialCreateBracketState: typeof import("./actions").initialCreateBracketState;

    const creatorId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ createBracket, initialCreateBracketState } = await import(
        "./actions"
      ));

      // Disposable test creator - never a real signed-up user.
      await prisma.profile.create({
        data: {
          id: creatorId,
          email: `create-bracket-e2e-${Date.now()}-${Math.random()
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

    it("creates a real DRAFT Bracket row owned by the signed-in creator, then redirects", async () => {
      currentUserId = creatorId;

      let thrown: unknown;
      try {
        await createBracket(
          initialCreateBracketState,
          formData({
            title: "Best Sitcom (e2e)",
            description: "A friendly poll.",
            visibility: "PUBLIC",
            votingRequirement: "ANONYMOUS_ALLOWED",
          })
        );
      } catch (err) {
        thrown = err;
      }

      expect((thrown as { digest?: string } | undefined)?.digest).toMatch(
        /^NEXT_REDIRECT.*\/dashboard\/brackets\/.+\/edit/
      );

      const created = await prisma.bracket.findFirst({
        where: { creatorId, title: "Best Sitcom (e2e)" },
      });
      expect(created).not.toBeNull();
      if (created) {
        bracketIds.push(created.id);
        expect(created.status).toBe("DRAFT");
        expect(created.creatorId).toBe(creatorId);
        expect(created.visibility).toBe("PUBLIC");
        expect(created.votingRequirement).toBe("ANONYMOUS_ALLOWED");
        expect(created.description).toBe("A friendly poll.");
      }
    });

    it("creates no row when the title is missing", async () => {
      currentUserId = creatorId;

      const result = await createBracket(
        initialCreateBracketState,
        formData({
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
        })
      );

      expect(result).toEqual({ error: "Title is required." });

      const rows = await prisma.bracket.findMany({ where: { creatorId } });
      expect(rows).toHaveLength(bracketIds.length);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../dashboard-query.integration.test.ts`.
  describe("createBracket action, against the live database", () => {
    console.warn(
      "[create-bracket actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
