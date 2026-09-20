import { describe, expect, it, vi, beforeEach } from "vitest";

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
// are mocked - both need a real Next.js request scope Vitest doesn't
// provide.
vi.mock("next/cache", () => ({ revalidatePath }));

const { updateRoundDuration, initialRoundDurationFormState } = await import(
  "./round-duration-actions"
);

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function expect404(thrown: unknown) {
  expect(thrown).toBeDefined();
  expect((thrown as { digest?: string }).digest).toContain("404");
}

describe("updateRoundDuration", () => {
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

  it("saves the default duration with no overrides when every round is left at the default", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    itemCount.mockResolvedValue(4); // ceil(log2(4)) = 2 rounds

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({ defaultRoundDurationMinutes: "60" })
    );

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        defaultRoundDurationMinutes: 60,
        roundDurationOverrides: {},
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/brackets/bracket-1/edit"
    );
    expect(result).toEqual({ error: null });
  });

  it("saves the default duration plus per-round overrides, keyed by round number", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    itemCount.mockResolvedValue(8); // ceil(log2(8)) = 3 rounds

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "120",
        "roundOverride-3": "30",
      })
    );

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        defaultRoundDurationMinutes: 60,
        roundDurationOverrides: { "1": 120, "3": 30 },
      },
    });
    expect(result).toEqual({ error: null });
  });

  it("rejects a zero or negative default duration and saves nothing", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    itemCount.mockResolvedValue(4);

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({ defaultRoundDurationMinutes: "0" })
    );

    expect(result).toEqual({
      error: "Default round duration must be a positive number of minutes.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("rejects a zero or negative round override and saves nothing", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    itemCount.mockResolvedValue(4);

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-2": "-5",
      })
    );

    expect(result).toEqual({
      error: "Round 2's duration must be a positive number of minutes.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("does not crash and simply ignores a submitted override for a round beyond the live item count's total", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    // Only 3 items now (e.g. items were removed since the form was opened) -
    // ceil(log2(3)) = 2 rounds, so round 5 no longer exists.
    itemCount.mockResolvedValue(3);

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "45",
        "roundOverride-5": "999",
      })
    );

    expect(result).toEqual({ error: null });
    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        defaultRoundDurationMinutes: 60,
        roundDurationOverrides: { "1": 45 },
      },
    });
  });

  it("returns a generic user-facing error, instead of an unhandled exception, when the database is unreachable (issue #36)", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });
    itemCount.mockResolvedValue(4);
    bracketUpdate.mockRejectedValue(new Error("connection reset"));

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({ defaultRoundDurationMinutes: "60" })
    );

    expect(result).toEqual({
      error: "Something went wrong. Please try again.",
    });
  });

  it("404s instead of updating round durations on a bracket that isn't the signed-in creator's", async () => {
    bracketFindFirst.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await updateRoundDuration(
        "someone-elses-bracket",
        initialRoundDurationFormState,
        formData({ defaultRoundDurationMinutes: "60" })
      );
    } catch (err) {
      thrown = err;
    }

    expect404(thrown);
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("404s instead of updating round durations when there is no signed-in user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    let thrown: unknown;
    try {
      await updateRoundDuration(
        "bracket-1",
        initialRoundDurationFormState,
        formData({ defaultRoundDurationMinutes: "60" })
      );
    } catch (err) {
      thrown = err;
    }

    expect404(thrown);
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns an error and saves nothing when the bracket is no longer a draft", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "ACTIVE",
    });

    const result = await updateRoundDuration(
      "bracket-1",
      initialRoundDurationFormState,
      formData({ defaultRoundDurationMinutes: "60" })
    );

    expect(result).toEqual({
      error:
        "This bracket is no longer a draft, so its round durations can't be changed.",
    });
    expect(itemCount).not.toHaveBeenCalled();
    expect(bracketUpdate).not.toHaveBeenCalled();
  });
});
