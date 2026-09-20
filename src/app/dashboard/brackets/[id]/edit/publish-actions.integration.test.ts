import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #16's `publishBracket` Server Action end-to-end against
// the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real `Profile` + `Bracket` (+ `BracketItem`) rows,
// calls the real (unmocked) action, asserts the resulting `Bracket` row,
// then cleans everything up. Same disposable-test-data pattern as
// `./scheduled-start-actions.integration.test.ts` (#14) and
// `./actions.integration.test.ts` (#11) - see those for the fuller
// rationale.
//
// This also includes the strongest version of the "not just a hidden
// button" proof: publishing a real bracket via `publishBracket`, then
// calling #11's real `addItem`/`updateItem`/`removeItem` against that same,
// now-published row and asserting they're rejected - end to end, against
// the live database, with no mocked Prisma state to simulate anything.
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

const FUTURE = "2999-01-01T09:00";

describe.runIf(hasLiveDatabase)(
  "publishBracket Server Action, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let publishBracket: typeof import("./publish-actions").publishBracket;
    let initialPublishFormState: typeof import("./publish-actions").initialPublishFormState;
    let addItem: typeof import("./actions").addItem;
    let updateItem: typeof import("./actions").updateItem;
    let removeItem: typeof import("./actions").removeItem;
    let initialItemFormState: typeof import("./actions").initialItemFormState;

    const creatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];

    let readyBracketId: string;
    let scheduledReadyBracketId: string;
    let tooFewItemsBracketId: string;
    let noItemsBracketId: string;
    let otherCreatorBracketId: string;
    let alreadyActiveBracketId: string;
    let lockProofBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ publishBracket, initialPublishFormState } = await import(
        "./publish-actions"
      ));
      ({ addItem, updateItem, removeItem, initialItemFormState } =
        await import("./actions"));

      // Disposable test creators - never real signed-up users.
      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `edit-publish-e2e-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `edit-publish-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      async function makeDraftBracket(
        title: string,
        opts: { scheduledStartAt?: Date; itemCount: number; creator?: string }
      ) {
        const created = await prisma.bracket.create({
          data: {
            creatorId: opts.creator ?? creatorId,
            title,
            visibility: "PUBLIC",
            votingRequirement: "ANONYMOUS_ALLOWED",
            defaultRoundDurationMinutes: 60,
            status: "DRAFT",
            scheduledStartAt: opts.scheduledStartAt ?? null,
          },
        });
        bracketIds.push(created.id);
        for (let i = 0; i < opts.itemCount; i++) {
          await prisma.bracketItem.create({
            data: { bracketId: created.id, title: `Item ${i + 1}` },
          });
        }
        return created.id;
      }

      readyBracketId = await makeDraftBracket(
        "Best Sitcom (publish e2e, immediate)",
        { itemCount: 3 }
      );
      scheduledReadyBracketId = await makeDraftBracket(
        "Best Movie (publish e2e, scheduled)",
        { itemCount: 2, scheduledStartAt: new Date(FUTURE) }
      );
      tooFewItemsBracketId = await makeDraftBracket(
        "Too Few Items (publish e2e)",
        { itemCount: 1 }
      );
      noItemsBracketId = await makeDraftBracket("No Items (publish e2e)", {
        itemCount: 0,
      });
      otherCreatorBracketId = await makeDraftBracket(
        "Someone Else's Draft (publish e2e)",
        { itemCount: 3, creator: otherCreatorId }
      );
      lockProofBracketId = await makeDraftBracket(
        "Lock Proof (publish e2e)",
        { itemCount: 2 }
      );

      const alreadyActiveBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Already Active (publish e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
        },
      });
      alreadyActiveBracketId = alreadyActiveBracket.id;
      bracketIds.push(alreadyActiveBracketId);
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

    it("publishes to ACTIVE and sets publishedAt when the start choice was immediate", async () => {
      currentUserId = creatorId;
      const before = new Date();

      const result = await publishBracket(
        readyBracketId,
        initialPublishFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: readyBracketId },
      });
      expect(updated?.status).toBe("ACTIVE");
      expect(updated?.publishedAt).not.toBeNull();
      expect(updated!.publishedAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
    });

    it("publishes to SCHEDULED when a future start time was chosen", async () => {
      currentUserId = creatorId;

      const result = await publishBracket(
        scheduledReadyBracketId,
        initialPublishFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: scheduledReadyBracketId },
      });
      expect(updated?.status).toBe("SCHEDULED");
      expect(updated?.publishedAt).not.toBeNull();
    });

    it("blocks publishing with a clear message, not a server error, when there is only 1 item", async () => {
      currentUserId = creatorId;

      const result = await publishBracket(
        tooFewItemsBracketId,
        initialPublishFormState,
        new FormData()
      );

      expect(result).toEqual({
        error: "Add at least 2 items before publishing this bracket.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: tooFewItemsBracketId },
      });
      expect(unchanged?.status).toBe("DRAFT");
      expect(unchanged?.publishedAt).toBeNull();
    });

    it("blocks publishing with a clear message when there are 0 items", async () => {
      currentUserId = creatorId;

      const result = await publishBracket(
        noItemsBracketId,
        initialPublishFormState,
        new FormData()
      );

      expect(result).toEqual({
        error: "Add at least 2 items before publishing this bracket.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: noItemsBracketId },
      });
      expect(unchanged?.status).toBe("DRAFT");
    });

    it("404s instead of publishing another creator's draft bracket", async () => {
      currentUserId = creatorId;

      await expect(
        publishBracket(
          otherCreatorBracketId,
          initialPublishFormState,
          new FormData()
        )
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: otherCreatorBracketId },
      });
      expect(unchanged?.status).toBe("DRAFT");
    });

    it("refuses to re-publish (no unpublish/re-publish path) once the bracket is already ACTIVE", async () => {
      currentUserId = creatorId;
      const before = await prisma.bracket.findUnique({
        where: { id: alreadyActiveBracketId },
      });

      const result = await publishBracket(
        alreadyActiveBracketId,
        initialPublishFormState,
        new FormData()
      );

      expect(result).toEqual({
        error: "This bracket has already been published.",
      });

      const after = await prisma.bracket.findUnique({
        where: { id: alreadyActiveBracketId },
      });
      expect(after?.status).toBe(before?.status);
      expect(after?.publishedAt).toEqual(before?.publishedAt);
    });

    // The strongest version of #16's "not just a hidden button" criterion:
    // publish a real bracket, then call #11's real Server Actions directly
    // against it, end to end against the live database.
    it("rejects a direct addItem/updateItem/removeItem call once a bracket has actually been published", async () => {
      currentUserId = creatorId;

      const items = await prisma.bracketItem.findMany({
        where: { bracketId: lockProofBracketId },
      });
      expect(items.length).toBeGreaterThanOrEqual(2);
      const existingItem = items[0];

      const publishResult = await publishBracket(
        lockProofBracketId,
        initialPublishFormState,
        new FormData()
      );
      expect(publishResult).toEqual({ error: null });

      const publishedBracket = await prisma.bracket.findUnique({
        where: { id: lockProofBracketId },
      });
      expect(publishedBracket?.status).toBe("ACTIVE");

      const addResult = await addItem(
        lockProofBracketId,
        initialItemFormState,
        formData({ title: "Should not be added" })
      );
      expect(addResult).toEqual({
        error:
          "This bracket is no longer a draft, so its items can't be changed.",
      });

      const updateResult = await updateItem(
        lockProofBracketId,
        existingItem.id,
        initialItemFormState,
        formData({ title: "Should not be updated" })
      );
      expect(updateResult).toEqual({
        error:
          "This bracket is no longer a draft, so its items can't be changed.",
      });

      const removeResult = await removeItem(
        lockProofBracketId,
        existingItem.id,
        initialItemFormState,
        new FormData()
      );
      expect(removeResult).toEqual({
        error:
          "This bracket is no longer a draft, so its items can't be changed.",
      });

      const afterAttempts = await prisma.bracketItem.findMany({
        where: { bracketId: lockProofBracketId },
      });
      expect(afterAttempts.map((item) => item.id).sort()).toEqual(
        items.map((item) => item.id).sort()
      );
      expect(
        afterAttempts.find((item) => item.id === existingItem.id)?.title
      ).toBe(existingItem.title);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../dashboard-query.integration.test.ts`.
  describe("publishBracket Server Action, against the live database", () => {
    console.warn(
      "[publish-actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
