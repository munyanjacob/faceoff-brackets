import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const bracketUpdate = vi.fn();
const itemCount = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst, update: bracketUpdate },
    bracketItem: { count: itemCount },
  },
}));

// See ./actions.test.ts for why `revalidatePath` and `@/lib/supabase/server`
// need a real Next.js request scope Vitest doesn't provide, and are mocked
// for that reason.
vi.mock("next/cache", () => ({ revalidatePath }));

const { publishBracket, initialPublishFormState } = await import(
  "./publish-actions"
);

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
    revalidatePath.mockReset();

    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
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

  it("publishes to ACTIVE and sets publishedAt to now when the start choice was immediate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: null,
    });
    itemCount.mockResolvedValue(2);

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
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/brackets/bracket-1/edit"
    );
    expect(result).toEqual({ error: null });
  });

  it("publishes to SCHEDULED and sets publishedAt to now when a future start time was chosen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
    });
    itemCount.mockResolvedValue(3);

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
    expect(result).toEqual({ error: null });
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
      ["initialPublishFormState", "publishBracket"].sort()
    );
  });
});
