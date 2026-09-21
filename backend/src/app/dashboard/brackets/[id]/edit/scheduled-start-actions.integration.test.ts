import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercises issue #14's `updateScheduledStart` Server Action end-to-end
// against the real, disposable Supabase/Postgres project configured in
// `.env.local`: seeds a real `Profile` + `Bracket` rows, calls the real
// (unmocked) action, asserts the resulting `Bracket` row, then cleans
// everything up. Same disposable-test-data pattern as
// `./round-duration-actions.integration.test.ts` (#13) and
// `./actions.integration.test.ts` (#11) - see those for the fuller
// rationale.
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

// Comfortably in the future/past of whenever this suite actually runs.
const FUTURE = "2999-01-01T09:00";
const PAST = "2000-01-01T09:00";

describe.runIf(hasLiveDatabase)(
  "updateScheduledStart Server Action, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let updateScheduledStart: typeof import("./scheduled-start-actions").updateScheduledStart;
    let initialScheduledStartFormState: typeof import("./scheduled-start-form-state").initialScheduledStartFormState;

    const creatorId = randomUUID();
    const otherCreatorId = randomUUID();
    const bracketIds: string[] = [];

    let draftBracketId: string;
    let activeBracketId: string;
    let otherCreatorBracketId: string;
    let alreadyScheduledBracketId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ updateScheduledStart } = await import("./scheduled-start-actions"));
      ({ initialScheduledStartFormState } = await import(
        "./scheduled-start-form-state"
      ));

      // Disposable test creators - never real signed-up users.
      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `edit-scheduled-start-e2e-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: otherCreatorId,
            email: `edit-scheduled-start-e2e-other-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });

      const draftBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Best Sitcom (scheduled-start e2e)",
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
          title: "Best Movie (scheduled-start e2e, already active)",
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
          title: "Someone Else's Draft (scheduled-start e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          status: "DRAFT",
        },
      });
      otherCreatorBracketId = otherCreatorBracket.id;
      bracketIds.push(otherCreatorBracketId);

      // Already has a scheduled start saved, to exercise switching back to
      // "Start immediately" clearing it out to null.
      const alreadyScheduledBracket = await prisma.bracket.create({
        data: {
          creatorId,
          title: "Already Scheduled (scheduled-start e2e)",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
          defaultRoundDurationMinutes: 60,
          scheduledStartAt: new Date(FUTURE),
          status: "DRAFT",
        },
      });
      alreadyScheduledBracketId = alreadyScheduledBracket.id;
      bracketIds.push(alreadyScheduledBracketId);
    });

    afterAll(async () => {
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({
        where: { id: { in: [creatorId, otherCreatorId] } },
      });
      await prisma.$disconnect();
    });

    it("saves a future scheduledStartAt on a real Bracket row when scheduled is chosen", async () => {
      currentUserId = creatorId;

      const result = await updateScheduledStart(
        draftBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(updated?.scheduledStartAt).toEqual(new Date(FUTURE));
    });

    it("persists across a fresh read (survives a page reload of the draft)", async () => {
      currentUserId = creatorId;

      await updateScheduledStart(
        draftBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
      );

      // A brand-new read, as a page reload would do - not relying on
      // anything held in memory from the call above.
      const reread = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(reread?.scheduledStartAt).toEqual(new Date(FUTURE));
    });

    it("clears scheduledStartAt back to null when Start immediately is chosen", async () => {
      currentUserId = creatorId;

      const result = await updateScheduledStart(
        alreadyScheduledBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "immediate" })
      );

      expect(result).toEqual({ error: null });

      const updated = await prisma.bracket.findUnique({
        where: { id: alreadyScheduledBracketId },
      });
      expect(updated?.scheduledStartAt).toBeNull();
    });

    it("rejects a past scheduled date and changes nothing", async () => {
      currentUserId = creatorId;

      const before = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });

      const result = await updateScheduledStart(
        draftBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "scheduled", scheduledStartAt: PAST })
      );

      expect(result).toEqual({
        error: "The scheduled start time must be in the future.",
      });

      const after = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(after?.scheduledStartAt).toEqual(before?.scheduledStartAt);
    });

    it("rejects a missing scheduled date and changes nothing", async () => {
      currentUserId = creatorId;

      const before = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });

      const result = await updateScheduledStart(
        draftBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "scheduled" })
      );

      expect(result).toEqual({
        error: "A scheduled start requires a valid date and time.",
      });

      const after = await prisma.bracket.findUnique({
        where: { id: draftBracketId },
      });
      expect(after?.scheduledStartAt).toEqual(before?.scheduledStartAt);
    });

    it("404s instead of updating the start time on another creator's draft bracket", async () => {
      currentUserId = creatorId;

      await expect(
        updateScheduledStart(
          otherCreatorBracketId,
          initialScheduledStartFormState,
          formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
        )
      ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    });

    it("refuses to change the start time once the bracket is no longer a draft", async () => {
      currentUserId = creatorId;

      const result = await updateScheduledStart(
        activeBracketId,
        initialScheduledStartFormState,
        formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
      );

      expect(result).toEqual({
        error:
          "This bracket is no longer a draft, so its start time can't be changed.",
      });

      const unchanged = await prisma.bracket.findUnique({
        where: { id: activeBracketId },
      });
      expect(unchanged?.scheduledStartAt).toBeNull();
    });
  }
);

if (!hasLiveDatabase) {
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing, the
  // same reasoning as the skip note in
  // `../../dashboard-query.integration.test.ts`.
  describe("updateScheduledStart Server Action, against the live database", () => {
    console.warn(
      "[scheduled-start-actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
