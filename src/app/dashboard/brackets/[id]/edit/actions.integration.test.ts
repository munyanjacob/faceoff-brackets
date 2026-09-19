import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #11's `addItem`/`updateItem`/`removeItem` Server Actions
// end-to-end against the real, disposable Supabase/Postgres project
// configured in `.env.local`: seeds a real `Profile` + `Bracket`, calls the
// real (unmocked) actions, asserts the resulting `BracketItem` rows, then
// cleans everything up. Same disposable-test-data pattern as
// `../new/actions.integration.test.ts` (#10) and
// `../../dashboard-query.integration.test.ts` (#8) - see those for the
// fuller rationale.
//
// `@/lib/supabase/server` is mocked (it needs a real Next.js request scope
// for `next/headers`'s `cookies()`, which Vitest doesn't provide), and
// `next/cache`'s `revalidatePath` is mocked (it needs a real Next.js
// request scope too - a "static generation store" - and throws "Invariant:
// static generation store missing" without one). Everything else -
// validation, ownership/draft-status checks, and every `prisma.bracketItem`
// call - is the real, unmocked code from `./actions.ts`.
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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
  "BracketItem Server Actions, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let addItem: typeof import("./actions").addItem;
    let updateItem: typeof import("./actions").updateItem;
    let removeItem: typeof import("./actions").removeItem;
    let initialItemFormState: typeof import("./actions").initialItemFormState;

    const creatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];

    let draftBracketId: string;
    let activeBracketId: string;
    let otherCreatorBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ addItem, updateItem, removeItem, initialItemFormState } =
        await import("./actions"));

      // Disposable test creators - never real signed-up users.
      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `edit-items-e2e-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `edit-items-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      const draftBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Best Sitcom (e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      draftBracketId = draftBracket.id;
      bracketIds.push(draftBracketId);

      const activeBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Best Movie (e2e, already active)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
        },
      });
      activeBracketId = activeBracket.id;
      bracketIds.push(activeBracketId);

      const otherCreatorBracket = await prisma.bracket.create({
        data: {
          creatorId: otherCreatorId,
          title: "Someone Else's Draft (e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      otherCreatorBracketId = otherCreatorBracket.id;
      bracketIds.push(otherCreatorBracketId);
    });

    afterAll(async () => {
      // Delete children before parents (`onDelete: Restrict` throughout the
      // schema) so this suite never leaves test data behind in the one live
      // database this project has.
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({
        where: { id: { in: [creatorId, otherCreatorId] } },
      });
      await prisma.$disconnect();
    });

    it("creates a real BracketItem row scoped to the signed-in creator's own draft bracket", async () => {
      currentUserId = creatorId;

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Seinfeld", description: "The one about nothing." })
      );

      expect(result).toEqual({ error: null });

      const created = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "Seinfeld" },
      });
      expect(created).not.toBeNull();
      expect(created?.description).toBe("The one about nothing.");
    });

    it("creates no row when the title is missing", async () => {
      currentUserId = creatorId;

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ description: "No title here." })
      );

      expect(result).toEqual({ error: "Title is required." });

      const rows = await prisma.bracketItem.findMany({
        where: { bracketId: draftBracketId, description: "No title here." },
      });
      expect(rows).toHaveLength(0);
    });

    it("updates and then removes a real BracketItem, end to end", async () => {
      currentUserId = creatorId;

      const addResult = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Cheers" })
      );
      expect(addResult).toEqual({ error: null });

      const item = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "Cheers" },
      });
      expect(item).not.toBeNull();
      if (!item) return;

      const updateResult = await updateItem(
        draftBracketId,
        item.id,
        initialItemFormState,
        formData({ title: "Cheers (renamed)", description: "A bar in Boston." })
      );
      expect(updateResult).toEqual({ error: null });

      const updated = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(updated?.title).toBe("Cheers (renamed)");
      expect(updated?.description).toBe("A bar in Boston.");

      const removeResult = await removeItem(
        draftBracketId,
        item.id,
        initialItemFormState,
        formData({})
      );
      expect(removeResult).toEqual({ error: null });

      const afterRemoval = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(afterRemoval).toBeNull();
    });

    it("404s instead of adding/editing/removing an item on another creator's draft bracket", async () => {
      currentUserId = creatorId;

      await expect(
        addItem(
          otherCreatorBracketId,
          initialItemFormState,
          formData({ title: "Should not be created" })
        )
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });

      const leaked = await prisma.bracketItem.findFirst({
        where: {
          bracketId: otherCreatorBracketId,
          title: "Should not be created",
        },
      });
      expect(leaked).toBeNull();
    });

    it("refuses to add an item once the bracket is no longer a draft", async () => {
      currentUserId = creatorId;

      const result = await addItem(
        activeBracketId,
        initialItemFormState,
        formData({ title: "Too late" })
      );

      expect(result).toEqual({
        error: "This bracket is no longer a draft, so its items can't be changed.",
      });

      const leaked = await prisma.bracketItem.findFirst({
        where: { bracketId: activeBracketId, title: "Too late" },
      });
      expect(leaked).toBeNull();
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../dashboard-query.integration.test.ts`.
  describe("BracketItem Server Actions, against the live database", () => {
    console.warn(
      "[edit-items actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
