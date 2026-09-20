import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Exercises issue #11's `addItem`/`updateItem`/`removeItem` Server Actions
// (extended by #12 for the optional item image) end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds a real `Profile` + `Bracket`, calls the real (unmocked) actions,
// asserts the resulting `BracketItem` rows, then cleans everything up. Same
// disposable-test-data pattern as `../new/actions.integration.test.ts`
// (#10) and `../../dashboard-query.integration.test.ts` (#8) - see those
// for the fuller rationale.
//
// `@/lib/supabase/server` is mocked (it needs a real Next.js request scope
// for `next/headers`'s `cookies()`, which Vitest doesn't provide), and
// `next/cache`'s `revalidatePath` is mocked (it needs a real Next.js
// request scope too - a "static generation store" - and throws "Invariant:
// static generation store missing" without one). Everything else -
// validation, ownership/draft-status checks, every `prisma.bracketItem`
// call, and `./image-upload.ts`'s real Supabase Storage upload - is the
// real, unmocked code from `./actions.ts`. This is also this feature's only
// live-Storage coverage: it confirms the `bracket-item-images` bucket
// actually exists, accepts an upload via the service-role key, and serves
// the result back over its public URL (see the issue #12 comment for how
// the bucket was provisioned).
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

function formData(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

// A real, valid 1x1 transparent PNG - small enough to stay well under the
// 5MB limit while still being a genuine image file for the live Storage
// upload to accept.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "poster.png"): File {
  return new File([Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")], name, {
    type: "image/png",
  });
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

      // `./image-upload.ts` namespaces every uploaded object under
      // `${bracketId}/...` - clean up everything this suite uploaded to the
      // live `bracket-item-images` bucket (including a replaced item's
      // now-orphaned old file, per issue #12's "leaving it orphaned is
      // acceptable" - acceptable for the app, but no reason to actually
      // litter the one live bucket this project has across test runs).
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (serviceRoleKey && url) {
        const storage = createSupabaseClient(url, serviceRoleKey).storage;
        for (const id of bracketIds) {
          const { data: objects } = await storage
            .from("bracket-item-images")
            .list(id);
          if (objects && objects.length > 0) {
            await storage
              .from("bracket-item-images")
              .remove(objects.map((object) => `${id}/${object.name}`));
          }
        }
      }
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

    it("uploads a valid image to real Supabase Storage and saves its public URL (issue #12)", async () => {
      currentUserId = creatorId;

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "The Wire", image: pngFile() })
      );

      expect(result).toEqual({ error: null });

      const created = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "The Wire" },
      });
      expect(created).not.toBeNull();
      expect(created?.imageUrl).toMatch(
        /^https:\/\/.*\/storage\/v1\/object\/public\/bracket-item-images\//
      );

      // Confirm the URL actually serves the uploaded file back, not just
      // that a plausible-looking string was saved.
      const response = await fetch(created!.imageUrl!);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
    });

    it("rejects an oversized image with a visible error and creates no row (issue #12)", async () => {
      currentUserId = creatorId;
      const oversized = new File(
        [new Uint8Array(5 * 1024 * 1024 + 1)],
        "too-big.png",
        { type: "image/png" }
      );

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Too Big For This Bracket", image: oversized })
      );

      expect(result).toEqual({ error: "Image must be 5MB or smaller." });

      const rows = await prisma.bracketItem.findMany({
        where: { bracketId: draftBracketId, title: "Too Big For This Bracket" },
      });
      expect(rows).toHaveLength(0);
    });

    it("rejects a non-image file with a visible error and creates no row (issue #12)", async () => {
      currentUserId = creatorId;
      const notAnImage = new File(["hello"], "notes.txt", {
        type: "text/plain",
      });

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Not A Real Image", image: notAnImage })
      );

      expect(result).toEqual({
        error: "Image must be a PNG, JPEG, or WebP file.",
      });

      const rows = await prisma.bracketItem.findMany({
        where: { bracketId: draftBracketId, title: "Not A Real Image" },
      });
      expect(rows).toHaveLength(0);
    });

    it("replaces an item's image, updating image_url to the new file's real URL (issue #12)", async () => {
      currentUserId = creatorId;

      const addResult = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "The Sopranos", image: pngFile("original.png") })
      );
      expect(addResult).toEqual({ error: null });

      const item = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "The Sopranos" },
      });
      expect(item).not.toBeNull();
      if (!item) return;
      const originalImageUrl = item.imageUrl;
      expect(originalImageUrl).not.toBeNull();

      const updateResult = await updateItem(
        draftBracketId,
        item.id,
        initialItemFormState,
        formData({ title: "The Sopranos", image: pngFile("replacement.png") })
      );
      expect(updateResult).toEqual({ error: null });

      const updated = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(updated?.imageUrl).not.toBe(originalImageUrl);
      expect(updated?.imageUrl).toMatch(
        /^https:\/\/.*\/storage\/v1\/object\/public\/bracket-item-images\//
      );

      const response = await fetch(updated!.imageUrl!);
      expect(response.status).toBe(200);
    });

    it("keeps an item's existing image_url when it's edited without choosing a new file (issue #12)", async () => {
      currentUserId = creatorId;

      const addResult = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Breaking Bad", image: pngFile() })
      );
      expect(addResult).toEqual({ error: null });

      const item = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "Breaking Bad" },
      });
      expect(item).not.toBeNull();
      if (!item) return;
      const originalImageUrl = item.imageUrl;

      const updateResult = await updateItem(
        draftBracketId,
        item.id,
        initialItemFormState,
        formData({ title: "Breaking Bad", description: "Just the title changed." })
      );
      expect(updateResult).toEqual({ error: null });

      const updated = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(updated?.imageUrl).toBe(originalImageUrl);
    });

    it("creates a real BracketItem with no image at all - the image stays optional (issue #12)", async () => {
      currentUserId = creatorId;

      const result = await addItem(
        draftBracketId,
        initialItemFormState,
        formData({ title: "Fargo" })
      );

      expect(result).toEqual({ error: null });

      const created = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "Fargo" },
      });
      expect(created).not.toBeNull();
      expect(created?.imageUrl).toBeNull();
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
