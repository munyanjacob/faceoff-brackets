import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Exercises PATCH/DELETE /brackets/{bracketId}/items/{itemId} end-to-end
// against the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds real Profile/Bracket/BracketItem rows, calls the real
// (unmocked) `PATCH`/`DELETE` handlers - including a real
// `uploadBracketItemImage` Storage upload - and asserts on both the
// response and the resulting database rows, then cleans up. Same
// disposable-test-data + real-Storage pattern as
// `../route.integration.test.ts`'s `POST` suite and
// `../../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts`,
// which this file's handlers wrap (`updateItem`/`removeItem`).
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason every other REST integration suite in this API surface mocks it
// (no way to mint a real Supabase JWT here).
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

// See ../../../../../dashboard/dashboard-query.integration.test.ts for why
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

// A real, valid 1x1 transparent PNG - same fixture as
// ../route.integration.test.ts and
// ../../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "poster.png"): File {
  return new File([Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")], name, {
    type: "image/png",
  });
}

describe.runIf(hasLiveDatabase)(
  "PATCH/DELETE /brackets/{bracketId}/items/{itemId}, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let PATCH: typeof import("./route").PATCH;
    let DELETE: typeof import("./route").DELETE;

    const ownerId = randomUUID();
    const otherId = randomUUID();
    const bracketIds: string[] = [];

    let draftBracketId: string;
    let activeBracketId: string;
    let otherOwnerBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ PATCH, DELETE } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownerId,
            email: `item-id-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `item-id-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      const draftBracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Draft Bracket (item-id e2e)",
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
          creatorId: ownerId,
          title: "Active Bracket (item-id e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
        },
      });
      activeBracketId = activeBracket.id;
      bracketIds.push(activeBracketId);

      const otherOwnerBracket = await prisma.bracket.create({
        data: {
          creatorId: otherId,
          title: "Someone Else's Draft (item-id e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      otherOwnerBracketId = otherOwnerBracket.id;
      bracketIds.push(otherOwnerBracketId);
    });

    afterAll(async () => {
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({
        where: { id: { in: [ownerId, otherId] } },
      });
      await prisma.$disconnect();

      // Clean up anything this suite actually uploaded to the live
      // `bracket-item-images` bucket - same reasoning as
      // ../../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts's
      // identical cleanup block.
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

    function patchRequest(
      bracketId: string,
      itemId: string,
      fields: Record<string, string | File>,
      authorization?: string
    ) {
      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        formData.set(key, value);
      }
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(
        `http://localhost/brackets/${bracketId}/items/${itemId}`,
        { method: "PATCH", headers, body: formData }
      );
    }

    function deleteRequest(
      bracketId: string,
      itemId: string,
      authorization?: string
    ) {
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(
        `http://localhost/brackets/${bracketId}/items/${itemId}`,
        { method: "DELETE", headers }
      );
    }

    function paramsFor(bracketId: string, itemId: string) {
      return { params: Promise.resolve({ bracketId, itemId }) };
    }

    it("updates a real BracketItem's title/description and returns 200 with the updated row", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: draftBracketId, title: "Cheers" },
      });

      const response = await PATCH(
        patchRequest(
          draftBracketId,
          item.id,
          { title: "Cheers (renamed)", description: "A bar in Boston." },
          "Bearer token"
        ),
        paramsFor(draftBracketId, item.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Cheers (renamed)");
      expect(body.description).toBe("A bar in Boston.");

      const updated = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(updated?.title).toBe("Cheers (renamed)");
    });

    it("keeps an item's existing imageUrl unchanged when PATCH omits the image field (no accidental clear)", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: draftBracketId, title: "Breaking Bad" },
      });

      const withImage = await PATCH(
        patchRequest(
          draftBracketId,
          item.id,
          { title: "Breaking Bad", image: pngFile() },
          "Bearer token"
        ),
        paramsFor(draftBracketId, item.id)
      );
      expect(withImage.status).toBe(200);
      const withImageBody = await withImage.json();
      const originalImageUrl = withImageBody.imageUrl;
      expect(originalImageUrl).not.toBeNull();

      const titleOnlyUpdate = await PATCH(
        patchRequest(
          draftBracketId,
          item.id,
          { title: "Breaking Bad (renamed)" },
          "Bearer token"
        ),
        paramsFor(draftBracketId, item.id)
      );
      expect(titleOnlyUpdate.status).toBe(200);
      const titleOnlyBody = await titleOnlyUpdate.json();
      expect(titleOnlyBody.imageUrl).toBe(originalImageUrl);

      const persisted = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(persisted?.imageUrl).toBe(originalImageUrl);
    });

    it("replaces an item's image with a newly-uploaded file's real public URL", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: draftBracketId, title: "The Sopranos" },
      });

      const first = await PATCH(
        patchRequest(
          draftBracketId,
          item.id,
          { title: "The Sopranos", image: pngFile("original.png") },
          "Bearer token"
        ),
        paramsFor(draftBracketId, item.id)
      );
      const firstBody = await first.json();
      const originalImageUrl = firstBody.imageUrl;

      const second = await PATCH(
        patchRequest(
          draftBracketId,
          item.id,
          { title: "The Sopranos", image: pngFile("replacement.png") },
          "Bearer token"
        ),
        paramsFor(draftBracketId, item.id)
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.imageUrl).not.toBe(originalImageUrl);
      expect(secondBody.imageUrl).toMatch(
        /^https:\/\/.*\/storage\/v1\/object\/public\/bracket-item-images\//
      );

      const imageResponse = await fetch(secondBody.imageUrl);
      expect(imageResponse.status).toBe(200);
    });

    it("returns 401 and updates no row when there's no authenticated caller", async () => {
      const item = await prisma.bracketItem.create({
        data: { bracketId: draftBracketId, title: "Fargo" },
      });

      const response = await PATCH(
        patchRequest(draftBracketId, item.id, { title: "Should Not Apply" }),
        paramsFor(draftBracketId, item.id)
      );

      expect(response.status).toBe(401);
      const unchanged = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(unchanged?.title).toBe("Fargo");
    });

    it("returns 404 (never 403) for a bracket owned by a different creator", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: otherOwnerBracketId, title: "Not Yours" },
      });

      const response = await PATCH(
        patchRequest(
          otherOwnerBracketId,
          item.id,
          { title: "Should Not Apply" },
          "Bearer token"
        ),
        paramsFor(otherOwnerBracketId, item.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns 404 when the itemId belongs to a different bracket than the URL's bracketId", async () => {
      currentUserId = ownerId;
      const itemInOtherBracket = await prisma.bracketItem.create({
        data: { bracketId: activeBracketId, title: "Wrong Bracket" },
      });

      const response = await PATCH(
        patchRequest(
          draftBracketId,
          itemInOtherBracket.id,
          { title: "Should Not Apply" },
          "Bearer token"
        ),
        paramsFor(draftBracketId, itemInOtherBracket.id)
      );

      // draftBracketId is a real, owned DRAFT bracket, so this exercises the
      // item-scoped-to-bracket 404, not the bracket-ownership 404.
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This item no longer exists.",
      });
    });

    it("returns 409 NOT_DRAFT and updates no row once the bracket is no longer a draft", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: activeBracketId, title: "Too Late" },
      });

      const response = await PATCH(
        patchRequest(
          activeBracketId,
          item.id,
          { title: "Should Not Apply" },
          "Bearer token"
        ),
        paramsFor(activeBracketId, item.id)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_DRAFT",
        message:
          "This bracket is no longer a draft, so its items can't be changed.",
      });
      const unchanged = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(unchanged?.title).toBe("Too Late");
    });

    it("deletes a real BracketItem and returns 204, and the row is actually gone", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: draftBracketId, title: "Cheers 2" },
      });

      const response = await DELETE(
        deleteRequest(draftBracketId, item.id, "Bearer token"),
        paramsFor(draftBracketId, item.id)
      );

      expect(response.status).toBe(204);
      const afterDelete = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(afterDelete).toBeNull();
    });

    it("returns 409 NOT_DRAFT and deletes no row once the bracket is no longer a draft", async () => {
      currentUserId = ownerId;
      const item = await prisma.bracketItem.create({
        data: { bracketId: activeBracketId, title: "Should Survive" },
      });

      const response = await DELETE(
        deleteRequest(activeBracketId, item.id, "Bearer token"),
        paramsFor(activeBracketId, item.id)
      );

      expect(response.status).toBe(409);
      const stillThere = await prisma.bracketItem.findUnique({
        where: { id: item.id },
      });
      expect(stillThere).not.toBeNull();
    });

    it("returns 404 and deletes no row for an item id that doesn't exist", async () => {
      currentUserId = ownerId;

      const response = await DELETE(
        deleteRequest(draftBracketId, randomUUID(), "Bearer token"),
        paramsFor(draftBracketId, randomUUID())
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This item no longer exists.",
      });
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../../dashboard/dashboard-query.integration.test.ts.
  describe("PATCH/DELETE /brackets/{bracketId}/items/{itemId}, against the live database", () => {
    console.warn(
      "[items/[itemId] route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
