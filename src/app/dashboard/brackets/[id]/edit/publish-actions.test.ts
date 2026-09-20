import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const bracketUpdate = vi.fn();
const itemCount = vi.fn();
const itemFindMany = vi.fn();
const roundCreate = vi.fn();
const revalidatePath = vi.fn();

// `$transaction` is exercised with an interactive-transaction callback in
// `publishBracket`, the same shape Prisma itself calls with a `tx` client -
// here `tx` is just the same mocked `bracket`/`round`, so assertions below
// can keep asserting against `bracketUpdate`/`roundCreate` directly.
const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    bracket: { update: bracketUpdate },
    round: { create: roundCreate },
  })
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst, update: bracketUpdate },
    bracketItem: { count: itemCount, findMany: itemFindMany },
    round: { create: roundCreate },
    $transaction: transaction,
  },
}));

// See ./actions.test.ts for why `revalidatePath` and `@/lib/supabase/server`
// need a real Next.js request scope Vitest doesn't provide, and are mocked
// for that reason.
vi.mock("next/cache", () => ({ revalidatePath }));

const { publishBracket } = await import("./publish-actions");
const { initialPublishFormState } = await import("./publish-form-state");

function expect404(thrown: unknown) {
  expect(thrown).toBeDefined();
  expect((thrown as { digest?: string }).digest).toContain("404");
}

describe("publishBracket", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    bracketUpdate.mockReset();
    itemCount.mockReset();
    itemFindMany.mockReset();
    roundCreate.mockReset();
    transaction.mockClear();
    revalidatePath.mockReset();

    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
    // A safe default for tests that don't care about the exact round/matchup
    // shape - just needs >= 2 items so `buildRoundOnePlan` doesn't throw.
    itemFindMany.mockResolvedValue([
      { id: "item-1" },
      { id: "item-2" },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks the bracket up scoped to the signed-in creator, not by id alone", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(2);

    await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("scopes the item count to this bracket", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(2);

    await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(itemCount).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
    });
  });

  it("fetches items in the same order (createdAt ascending) the preview uses, so pairings can never disagree", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(2);

    await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(itemFindMany).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("publishes to ACTIVE and sets publishedAt to now when the start choice was immediate, creating an ACTIVE Round with ACTIVE Matchups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 45,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        status: "ACTIVE",
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(roundCreate).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        roundNumber: 1,
        durationMinutes: 45,
        status: "ACTIVE",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-01-01T00:45:00.000Z"),
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-2",
              winnerItemId: null,
              status: "ACTIVE",
            },
          ],
        },
      },
    });
    // The Bracket update and Round creation happen inside one transaction.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/brackets/bracket-1/edit"
    );
    expect(result).toEqual({ error: null });
  });

  it("publishes to SCHEDULED and sets publishedAt to now when a future start time was chosen, creating a PENDING Round with PENDING Matchups and no starts/ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        status: "SCHEDULED",
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(roundCreate).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        roundNumber: 1,
        durationMinutes: 60,
        status: "PENDING",
        startsAt: null,
        endsAt: null,
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-2",
              winnerItemId: null,
              status: "PENDING",
            },
          ],
        },
      },
    });
    expect(result).toEqual({ error: null });
  });

  it("creates a bye Matchup (item_b_id null, winner already set, COMPLETED) regardless of immediate vs. scheduled start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    // 3 items -> next power of two is 4, so 1 bye + 1 real matchup.
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockResolvedValue(3);
    itemFindMany.mockResolvedValue([
      { id: "item-1" },
      { id: "item-2" },
      { id: "item-3" },
    ]);

    await publishBracket("bracket-1", initialPublishFormState, new FormData());

    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: null,
              winnerItemId: "item-1",
              status: "COMPLETED",
            },
            {
              itemAId: "item-2",
              itemBId: "item-3",
              winnerItemId: null,
              status: "PENDING",
            },
          ],
        },
      }),
    });
  });

  it("uses Bracket.round_duration_overrides['1'] for round 1's duration when present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: { "1": 15 },
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    await publishBracket("bracket-1", initialPublishFormState, new FormData());

    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        durationMinutes: 15,
        endsAt: new Date("2026-01-01T00:15:00.000Z"),
      }),
    });
  });

  it("falls back to Bracket.default_round_duration_minutes when no round 1 override is present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 90,
      // An override for round 2 exists but round 1 has none - should still
      // fall back to the default, not accidentally pick up round 2's value.
      roundDurationOverrides: { "2": 15 },
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    await publishBracket("bracket-1", initialPublishFormState, new FormData());

    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        durationMinutes: 90,
        endsAt: new Date("2026-01-01T01:30:00.000Z"),
      }),
    });
  });

  it("blocks publishing with a clear message (not a server error) when there are fewer than 2 items", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
    });
    itemCount.mockResolvedValue(1);

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Add at least 2 items before publishing this bracket.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
    expect(itemFindMany).not.toHaveBeenCalled();
    expect(roundCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("blocks publishing with a clear message when there are zero items", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
    });
    itemCount.mockResolvedValue(0);

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Add at least 2 items before publishing this bracket.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
    expect(itemFindMany).not.toHaveBeenCalled();
    expect(roundCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns a generic user-facing error, instead of an unhandled exception, when the database is unreachable (issue #36)", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: null,
    });
    itemCount.mockRejectedValue(new Error("connection reset"));

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Something went wrong. Please try again.",
    });
  });

  it("404s instead of publishing a bracket that isn't the signed-in creator's", async () => {
    bracketFindFirst.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await publishBracket(
        "someone-elses-bracket",
        initialPublishFormState,
        new FormData()
      );
    } catch (err) {
      thrown = err;
    }

    expect404(thrown);
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("404s instead of publishing when there is no signed-in user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    let thrown: unknown;
    try {
      await publishBracket(
        "bracket-1",
        initialPublishFormState,
        new FormData()
      );
    } catch (err) {
      thrown = err;
    }

    expect404(thrown);
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns an error and publishes nothing when the bracket is already ACTIVE (no re-publish)", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "ACTIVE",
      scheduledStartAt: null,
    });

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "This bracket has already been published.",
    });
    expect(itemCount).not.toHaveBeenCalled();
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns an error and publishes nothing when the bracket is already SCHEDULED (no re-publish)", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "SCHEDULED",
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
    });

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "This bracket has already been published.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns an error and publishes nothing when the bracket is already COMPLETED", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "COMPLETED",
      scheduledStartAt: null,
    });

    const result = await publishBracket(
      "bracket-1",
      initialPublishFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "This bracket has already been published.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("exposes no unpublish action at all - publish is one-way", async () => {
    const publishActionsModule = await import("./publish-actions");
    expect(
      (publishActionsModule as Record<string, unknown>).unpublishBracket
    ).toBeUndefined();
    expect(Object.keys(publishActionsModule).sort()).toEqual(
      ["publishBracket"].sort()
    );
  });
});
