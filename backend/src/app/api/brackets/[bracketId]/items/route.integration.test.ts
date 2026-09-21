import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Exercises GET/POST /brackets/{bracketId}/items end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds real Profile/Bracket/BracketItem rows, calls the real (unmocked)
// handlers, and asserts on the resulting JSON - same disposable-test-data
// pattern as
// `../../../../dashboard/brackets/[id]/edit/page.test.tsx`'s live-query
// sibling would use; `GET`'s lookup+query is copied from
// `../../../../dashboard/brackets/[id]/edit/page.tsx` (#11), and `POST`
// (issue #52) wraps `../../../../dashboard/brackets/[id]/edit/actions.ts`'s
// `addItem` - including its real, unmocked `uploadBracketItemImage` Storage
// upload (see the `POST` suite's own `afterAll` for the matching Storage
// cleanup, the same pattern
// `../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts`
// uses).
//
// Only `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked, for the same
// reason `../route.integration.test.ts` mocks it.
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
  "GET /brackets/{bracketId}/items, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;

    const ownerId = randomUUID();
    const otherId = randomUUID();
    const bracketIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownerId,
            email: `bracket-items-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `bracket-items-route-e2e-other-${Date.now()}-${Math.random()
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

    function request(bracketId: string, authorization?: string) {
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }
      return new Request(`http://localhost/brackets/${bracketId}/items`, {
        headers,
      });
    }

    function paramsFor(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("returns 401 when there's no authenticated caller", async () => {
      const bracketId = randomUUID();

      const response = await GET(request(bracketId), paramsFor(bracketId));

      expect(response.status).toBe(401);
    });

    it("returns 404 when the bracket doesn't exist", async () => {
      currentUserId = ownerId;

      const response = await GET(
        request(randomUUID(), "Bearer token"),
        paramsFor(randomUUID())
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns 404 (never 403) when the bracket exists but belongs to a different creator", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Owner's Bracket",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      currentUserId = otherId;
      const response = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
    });

    it("returns the owner's items in creation order", async () => {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Bracket With Items",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      bracketIds.push(bracket.id);

      const first = await prisma.bracketItem.create({
        data: { bracketId: bracket.id, title: "First Item" },
      });
      const second = await prisma.bracketItem.create({
        data: { bracketId: bracket.id, title: "Second Item" },
      });

      currentUserId = ownerId;
      const response = await GET(
        request(bracket.id, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.map((item: { id: string }) => item.id)).toEqual([
        first.id,
        second.id,
      ]);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../dashboard/dashboard-query.integration.test.ts.
  describe("GET /brackets/{bracketId}/items, against the live database", () => {
    console.warn(
      "[brackets/[bracketId]/items route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}

// A real, valid 1x1 transparent PNG - small enough to stay well under the
// 5MB limit while still being a genuine image file for the live Storage
// upload to accept. Same fixture as
// ../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "poster.png"): File {
  return new File([Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")], name, {
    type: "image/png",
  });
}

describe.runIf(hasLiveDatabase)(
  "POST /brackets/{bracketId}/items, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let POST: typeof import("./route").POST;

    const ownerId = randomUUID();
    const otherId = randomUUID();
    const bracketIds: string[] = [];

    let draftBracketId: string;
    let activeBracketId: string;
    let otherOwnerBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ POST } = await import("./route"));

      await prisma.profile.createMany({
        data: [
          {
            id: ownerId,
            email: `bracket-items-post-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `bracket-items-post-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      const draftBracket = await prisma.bracket.create({
        data: {
          creatorId: ownerId,
          title: "Draft Bracket (POST e2e)",
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
          title: "Active Bracket (POST e2e)",
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
          title: "Someone Else's Draft (POST e2e)",
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
      // ../../../../dashboard/brackets/[id]/edit/actions.integration.test.ts's
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

    function postRequest(
      bracketId: string,
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
      return new Request(`http://localhost/brackets/${bracketId}/items`, {
        method: "POST",
        headers,
        body: formData,
      });
    }

    function paramsFor(bracketId: string) {
      return { params: Promise.resolve({ bracketId }) };
    }

    it("creates a real BracketItem row, returning 201 with the created item", async () => {
      currentUserId = ownerId;

      const response = await POST(
        postRequest(
          draftBracketId,
          { title: "Seinfeld", description: "The one about nothing." },
          "Bearer token"
        ),
        paramsFor(draftBracketId)
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.title).toBe("Seinfeld");
      expect(body.description).toBe("The one about nothing.");
      expect(body.imageUrl).toBeNull();

      const created = await prisma.bracketItem.findUnique({
        where: { id: body.id },
      });
      expect(created).not.toBeNull();
    });

    it("uploads a real image to Supabase Storage and saves its public URL as imageUrl", async () => {
      currentUserId = ownerId;

      const response = await POST(
        postRequest(
          draftBracketId,
          { title: "The Wire", image: pngFile() },
          "Bearer token"
        ),
        paramsFor(draftBracketId)
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.imageUrl).toMatch(
        /^https:\/\/.*\/storage\/v1\/object\/public\/bracket-item-images\//
      );

      const imageResponse = await fetch(body.imageUrl);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
    });

    it("returns 401 and creates no row when there's no authenticated caller", async () => {
      const response = await POST(
        postRequest(draftBracketId, { title: "Should Not Exist" }),
        paramsFor(draftBracketId)
      );

      expect(response.status).toBe(401);
      const leaked = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, title: "Should Not Exist" },
      });
      expect(leaked).toBeNull();
    });

    it("returns 404 (never 403) and creates no row for a bracket owned by a different creator", async () => {
      currentUserId = ownerId;

      const response = await POST(
        postRequest(
          otherOwnerBracketId,
          { title: "Should Not Be Created" },
          "Bearer token"
        ),
        paramsFor(otherOwnerBracketId)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This bracket no longer exists.",
      });
      const leaked = await prisma.bracketItem.findFirst({
        where: { bracketId: otherOwnerBracketId, title: "Should Not Be Created" },
      });
      expect(leaked).toBeNull();
    });

    it("returns 409 NOT_DRAFT and creates no row once the bracket is no longer a draft", async () => {
      currentUserId = ownerId;

      const response = await POST(
        postRequest(activeBracketId, { title: "Too Late" }, "Bearer token"),
        paramsFor(activeBracketId)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_DRAFT",
        message:
          "This bracket is no longer a draft, so its items can't be changed.",
      });
      const leaked = await prisma.bracketItem.findFirst({
        where: { bracketId: activeBracketId, title: "Too Late" },
      });
      expect(leaked).toBeNull();
    });

    it("returns 400 and creates no row when the title is missing", async () => {
      currentUserId = ownerId;

      const response = await POST(
        postRequest(draftBracketId, { description: "No title here." }, "Bearer token"),
        paramsFor(draftBracketId)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "VALIDATION_ERROR",
        message: "Title is required.",
      });
      const leaked = await prisma.bracketItem.findFirst({
        where: { bracketId: draftBracketId, description: "No title here." },
      });
      expect(leaked).toBeNull();
    });
  }
);

if (!hasLiveDatabase) {
  describe("POST /brackets/{bracketId}/items, against the live database", () => {
    console.warn(
      "[brackets/[bracketId]/items route.integration.test] Skipping POST suite: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
