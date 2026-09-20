import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #13's `updateRoundDuration` Server Action end-to-end
// against the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds a real `Profile` + `Bracket` (+ `BracketItem` rows, to
// drive the live total-round-count computation), calls the real (unmocked)
// action, asserts the resulting `Bracket` row, then cleans everything up.
// Same disposable-test-data pattern as `./actions.integration.test.ts`
// (#11) and `../new/actions.integration.test.ts` (#10) - see those for the
// fuller rationale.
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
  "updateRoundDuration Server Action, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let updateRoundDuration: typeof import("./round-duration-actions").updateRoundDuration;
    let initialRoundDurationFormState: typeof import("./round-duration-form-state").initialRoundDurationFormState;

    const creatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];

    let draftBracketId: string;
    let activeBracketId: string;
    let otherCreatorBracketId: string;
    let shrunkBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ updateRoundDuration } = await import("./round-duration-actions"));
      ({ initialRoundDurationFormState } = await import(
        "./round-duration-form-state"
      ));

      // Disposable test creators - never real signed-up users.
      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `edit-round-duration-e2e-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `edit-round-duration-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      const draftBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Best Sitcom (round-duration e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      draftBracketId = draftBracket.id;
      bracketIds.push(draftBracketId);
      // 4 items -> ceil(log2(4)) = 2 rounds.
      await prisma.bracketItem.createMany({
        data: [1, 2, 3, 4].map((n) => ({
          bracketId: draftBracketId,
          title: `Item ${n}`,
        })),
      });

      const activeBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Best Movie (round-duration e2e, already active)",
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
          title: "Someone Else's Draft (round-duration e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      otherCreatorBracketId = otherCreatorBracket.id;
      bracketIds.push(otherCreatorBracketId);

      // Seeded with an override for a round number that will no longer
      // exist once the item count is this low: exercises the "stale
      // override" tolerance (#18 applies it/ignores it; this issue just
      // must not crash on it) directly against the live database.
      const shrunkBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Down To One Item (round-duration e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          roundDurationOverrides: { "5": 999 },
          status: "DRAFT",
        },
      });
      shrunkBracketId = shrunkBracket.id;
      bracketIds.push(shrunkBracketId);
      await prisma.bracketItem.create({
        data: { bracketId: shrunkBracketId, title: "Only Item" },
      });
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

    it("saves the default duration and per-round overrides on a real Bracket row", async () => {
      currentUserId = creatorId;

      const result = await updateRoundDuration(
        draftBracketId,
        initialRoundDurationFormState,
        formData({
          defaultRoundDurationMinutes: "90",
          "roundOverride-2": "45",
        })
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(updated?.defaultRoundDurationMinutes).toBe(90);
      expect(updated?.roundDurationOverrides).toEqual({ "2": 45 });
    });

    it("rejects a non-positive duration and changes nothing", async () => {
      currentUserId = creatorId;

      const before = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });

      const result = await updateRoundDuration(
        draftBracketId,
        initialRoundDurationFormState,
        formData({ defaultRoundDurationMinutes: "-10" })
      );

      expect(result).toEqual({
        error: "Default round duration must be a positive number of minutes.",
      });

      const after = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(after?.defaultRoundDurationMinutes).toBe(
        before?.defaultRoundDurationMinutes
      );
    });

    it("does not crash saving a bracket whose stored overrides already contain a stale round number", async () => {
      currentUserId = creatorId;

      // Only 1 item -> 0 computed rounds, so the "5" already stored is (and
      // stays) stale; no round-override fields are submitted here.
      const result = await updateRoundDuration(
        shrunkBracketId,
        initialRoundDurationFormState,
        formData({ defaultRoundDurationMinutes: "20" })
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: shrunkBracketId },
      });
      expect(updated?.defaultRoundDurationMinutes).toBe(20);
      expect(updated?.roundDurationOverrides).toEqual({});
    });

    it("404s instead of updating round durations on another creator's draft bracket", async () => {
      currentUserId = creatorId;

      await expect(
        updateRoundDuration(
          otherCreatorBracketId,
          initialRoundDurationFormState,
          formData({ defaultRoundDurationMinutes: "45" })
        )
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    });

    it("refuses to change round durations once the bracket is no longer a draft", async () => {
      currentUserId = creatorId;

      const result = await updateRoundDuration(
        activeBracketId,
        initialRoundDurationFormState,
        formData({ defaultRoundDurationMinutes: "45" })
      );

      expect(result).toEqual({
        error:
          "This bracket is no longer a draft, so its round durations can't be changed.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: activeBracketId },
      });
      expect(unchanged?.defaultRoundDurationMinutes).toBe(60);
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../dashboard-query.integration.test.ts`.
  describe("updateRoundDuration Server Action, against the live database", () => {
    console.warn(
      "[round-duration-actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
