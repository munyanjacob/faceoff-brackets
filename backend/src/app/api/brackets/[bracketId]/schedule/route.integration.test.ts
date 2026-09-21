import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises PATCH /brackets/{bracketId}/schedule end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds real Profile/Bracket rows, calls the real (unmocked) `PATCH`
// handler - real `validateScheduleRequest`, real `prisma.bracket.update()`
// - and asserts on the resulting row, then cleans up. Same disposable-
// test-data pattern as `../round-duration/route.integration.test.ts` and
// `../../../dashboard/brackets/[id]/edit/scheduled-start-actions.integration.test.ts`
// (#14), which this route wraps - except for the datetime parsing itself,
// which is the deliberate issue #53 behavior change (spec §9.4): this
// suite includes a dedicated case proving a real ISO-8601 offset string is
// parsed to the correct UTC instant, not the old naive local-time
// datetime-local parsing.
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
  "PATCH /brackets/{bracketId}/schedule, against the live database",
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
            email: `schedule-route-e2e-owner-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherId,
            email: `schedule-route-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
    });

    afterAll(async () => {
      if (bracketIds.length > 0) {
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
      return new Request(`http://localhost/brackets/${bracketId}/schedule`, {
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
          title: "Schedule E2E Bracket",
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
        request(bracket.id, { startMode: "immediate" }),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(401);
      const unchanged = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(unchanged?.scheduledStartAt).toBeNull();
    });

    it("returns 404 (never 403) when the bracket exists but belongs to a different creator", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = otherId;

      const response = await PATCH(
        request(bracket.id, { startMode: "immediate" }, "Bearer token"),
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
        request(bracket.id, { startMode: "immediate" }, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_DRAFT",
        message: "This bracket is no longer a draft, so its start time can't be changed.",
      });
    });

    it("returns 400 VALIDATION_ERROR and saves nothing for a past scheduledStartAt", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = ownerId;

      const response = await PATCH(
        request(
          bracket.id,
          { startMode: "scheduled", scheduledStartAt: "2000-01-01T00:00:00.000Z" },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "VALIDATION_ERROR",
        message: "The scheduled start time must be in the future.",
      });

      const unchanged = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(unchanged?.scheduledStartAt).toBeNull();
    });

    it("persists a future UTC scheduledStartAt and returns it on the updated bracket", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = ownerId;

      const response = await PATCH(
        request(
          bracket.id,
          { startMode: "scheduled", scheduledStartAt: "2999-01-01T00:00:00.000Z" },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.scheduledStartAt).toBe("2999-01-01T00:00:00.000Z");

      const updated = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(updated?.scheduledStartAt?.toISOString()).toBe(
        "2999-01-01T00:00:00.000Z"
      );
    });

    // *** The behavior-change proof (issue #53 / spec §9.4) - end-to-end ***
    // A real ISO-8601 string carrying a non-UTC offset is resolved to its
    // correct UTC instant and persisted as such, proving the whole request
    // path (route -> validateScheduleRequest -> parseIsoDatetimeValue ->
    // Prisma) honors the offset rather than reinterpreting the clock-face
    // numbers as this server process's own local time.
    it("correctly parses and persists a real ISO-8601 string with a non-UTC offset as its exact UTC instant", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = ownerId;

      // "2999-06-15T09:00:00-04:00" is exactly "2999-06-15T13:00:00.000Z".
      const response = await PATCH(
        request(
          bracket.id,
          {
            startMode: "scheduled",
            scheduledStartAt: "2999-06-15T09:00:00-04:00",
          },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.scheduledStartAt).toBe("2999-06-15T13:00:00.000Z");

      const updated = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(updated?.scheduledStartAt?.toISOString()).toBe(
        "2999-06-15T13:00:00.000Z"
      );
    });

    it("clears scheduledStartAt back to null when switching to immediate", async () => {
      const bracket = await createDraftBracket(ownerId);
      currentUserId = ownerId;

      await PATCH(
        request(
          bracket.id,
          { startMode: "scheduled", scheduledStartAt: "2999-01-01T00:00:00.000Z" },
          "Bearer token"
        ),
        paramsFor(bracket.id)
      );

      const response = await PATCH(
        request(bracket.id, { startMode: "immediate" }, "Bearer token"),
        paramsFor(bracket.id)
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.scheduledStartAt).toBeNull();

      const updated = await prisma.bracket.findUnique({ where: { id: bracket.id } });
      expect(updated?.scheduledStartAt).toBeNull();
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // .env.local) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // ../../../../dashboard/dashboard-query.integration.test.ts.
  describe("PATCH /brackets/{bracketId}/schedule, against the live database", () => {
    console.warn(
      "[schedule route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
