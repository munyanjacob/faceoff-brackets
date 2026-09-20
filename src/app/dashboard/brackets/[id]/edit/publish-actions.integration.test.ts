import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateFirstRound } from "@/lib/bracket/generate-first-round";

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
    let overrideDurationBracketId: string;

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
        opts: {
          scheduledStartAt?: Date;
          itemCount: number;
          creator?: string;
          defaultRoundDurationMinutes?: number;
          roundDurationOverrides?: Record<string, number>;
        }
      ) {
        const created = await prisma.bracket.create({
          data: {
            creatorId: opts.creator ?? creatorId,
            title,
            visibility: "PUBLIC",
            votingRequirement: "ANONYMOUS_ALLOWED",
            defaultRoundDurationMinutes: opts.defaultRoundDurationMinutes ?? 60,
            roundDurationOverrides: opts.roundDurationOverrides ?? undefined,
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
      overrideDurationBracketId = await makeDraftBracket(
        "Override Duration (publish e2e, #18)",
        {
          itemCount: 4,
          defaultRoundDurationMinutes: 60,
          roundDurationOverrides: { "1": 15 },
        }
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
      // database this project has. `Matchup` rows (#18) reference both
      // `Round` and `BracketItem`, so they must go before either.
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({
        where: { id: { in: [creatorId, otherCreatorId] } },
      });
      await prisma.$disconnect();
    });

    // Issue #18: publishing must also create round 1's real `Round` and
    // `Matchup` rows, in the exact ACTIVE/bye shape the issue specifies, and
    // those pairings must match what the preview (#15's `generateFirstRound`
    // call) would show for this same item list - proven here by calling
    // `generateFirstRound` directly on the same items and cross-checking.
    it("publishes to ACTIVE, sets publishedAt, and creates round 1's Round (ACTIVE) and Matchups (bye COMPLETED + real ACTIVE), matching the pairings generateFirstRound produces directly", async () => {
      currentUserId = creatorId;
      const before = new Date();

      // `readyBracketId` has 3 items, seeded in creation order - same order
      // publish itself reads them in (`orderBy: { createdAt: "asc" }`).
      const items = await prisma.bracketItem.findMany({
        where: { bracketId: readyBracketId },
        orderBy: { createdAt: "asc" },
      });
      const expectedPairings = generateFirstRound(items);

      const result = await publishBracket(
        readyBracketId,
        initialPublishFormState,
        new FormData()
      );
      expect(result).toEqual({ error: null });

      const updatedBracket = await prisma.bracket.findUnique({
        where: { id: readyBracketId },
      });
      expect(updatedBracket?.status).toBe("ACTIVE");
      expect(updatedBracket?.publishedAt).not.toBeNull();
      expect(updatedBracket!.publishedAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );

      const rounds = await prisma.round.findMany({
        where: { bracketId: readyBracketId },
      });
      expect(rounds).toHaveLength(1);
      const round = rounds[0];
      expect(round.roundNumber).toBe(1);
      expect(round.durationMinutes).toBe(60); // this bracket's default, no override
      expect(round.status).toBe("ACTIVE");
      expect(round.startsAt).not.toBeNull();
      expect(round.startsAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(round.endsAt).not.toBeNull();
      expect(round.endsAt!.getTime() - round.startsAt!.getTime()).toBe(
        60 * 60_000
      );

      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      // 3 items -> next power of two is 4 -> 1 bye + 1 real matchup.
      expect(matchups).toHaveLength(2);

      const byeMatchup = matchups.find((m) => m.itemBId === null);
      expect(byeMatchup).toBeDefined();
      expect(byeMatchup!.winnerItemId).toBe(byeMatchup!.itemAId);
      expect(byeMatchup!.status).toBe("COMPLETED");

      const realMatchup = matchups.find((m) => m.itemBId !== null);
      expect(realMatchup).toBeDefined();
      expect(realMatchup!.status).toBe("ACTIVE");
      expect(realMatchup!.winnerItemId).toBeNull();

      // Cross-check: the persisted (itemA, itemB) pairs match exactly what
      // generateFirstRound (#17) produces directly for the same item list -
      // proving publish and the #15 preview can never drift apart.
      const persistedPairs = matchups
        .map((m) => [m.itemAId, m.itemBId] as const)
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
      const expectedPairs = expectedPairings
        .map((p) => [p.itemA.id, p.itemB?.id ?? null] as const)
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
      expect(persistedPairs).toEqual(expectedPairs);
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

      const rounds = await prisma.round.findMany({
        where: { bracketId: scheduledReadyBracketId },
      });
      expect(rounds).toHaveLength(1);
      const round = rounds[0];
      expect(round.roundNumber).toBe(1);
      expect(round.status).toBe("PENDING");
      expect(round.startsAt).toBeNull();
      expect(round.endsAt).toBeNull();

      // 2 items -> 0 byes, 1 real matchup.
      const matchups = await prisma.matchup.findMany({
        where: { roundId: round.id },
      });
      expect(matchups).toHaveLength(1);
      expect(matchups[0].status).toBe("PENDING");
      expect(matchups[0].itemBId).not.toBeNull();
      expect(matchups[0].winnerItemId).toBeNull();
    });

    it("uses Bracket.round_duration_overrides['1'] for round 1's duration, over the bracket's default", async () => {
      currentUserId = creatorId;
      const before = new Date();

      const result = await publishBracket(
        overrideDurationBracketId,
        initialPublishFormState,
        new FormData()
      );
      expect(result).toEqual({ error: null });

      const round = await prisma.round.findFirst({
        where: { bracketId: overrideDurationBracketId },
      });
      expect(round).not.toBeNull();
      expect(round!.durationMinutes).toBe(15); // override, not the default 60
      expect(round!.status).toBe("ACTIVE");
      expect(round!.startsAt!.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(round!.endsAt!.getTime() - round!.startsAt!.getTime()).toBe(
        15 * 60_000
      );

      // 4 items -> 0 byes, 2 real matchups, both ACTIVE.
      const matchups = await prisma.matchup.findMany({
        where: { roundId: round!.id },
      });
      expect(matchups).toHaveLength(2);
      expect(matchups.every((m) => m.status === "ACTIVE")).toBe(true);
      expect(matchups.every((m) => m.itemBId !== null)).toBe(true);
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

      const rounds = await prisma.round.findMany({
        where: { bracketId: tooFewItemsBracketId },
      });
      expect(rounds).toHaveLength(0);
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
