import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const bracketFindFirst = vi.fn();
const bracketUpdate = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst, update: bracketUpdate },
  },
}));

// See ./actions.test.ts for why `revalidatePath` and `@/lib/supabase/server`
// are mocked - both need a real Next.js request scope Vitest doesn't
// provide.
vi.mock("next/cache", () => ({ revalidatePath }));

const { updateScheduledStart, initialScheduledStartFormState } = await import(
  "./scheduled-start-actions"
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

// Comfortably in the future/past of whenever this suite actually runs.
const FUTURE = "2999-01-01T09:00";
const PAST = "2000-01-01T09:00";

describe("updateScheduledStart", () => {
  beforeEach(() => {
    getUser.mockReset();
    bracketFindFirst.mockReset();
    bracketUpdate.mockReset();
    revalidatePath.mockReset();

    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
  });

  it("saves a null scheduledStartAt when Start immediately is chosen", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });

    const result = await updateScheduledStart(
      "bracket-1",
      initialScheduledStartFormState,
      formData({ startMode: "immediate" })
    );

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: null },
    });
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/brackets/bracket-1/edit"
    );
    expect(result).toEqual({ error: null });
  });

  it("saves the parsed future date when Schedule a start time is chosen with a valid future value", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });

    const result = await updateScheduledStart(
      "bracket-1",
      initialScheduledStartFormState,
      formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
    );

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: new Date(FUTURE) },
    });
    expect(result).toEqual({ error: null });
  });

  it("rejects a past scheduled date and saves nothing", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });

    const result = await updateScheduledStart(
      "bracket-1",
      initialScheduledStartFormState,
      formData({ startMode: "scheduled", scheduledStartAt: PAST })
    );

    expect(result).toEqual({
      error: "The scheduled start time must be in the future.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("rejects a missing scheduled date and saves nothing", async () => {
    bracketFindFirst.mockResolvedValue({
      id: "bracket-1",
      creatorId: "creator-1",
      status: "DRAFT",
    });

    const result = await updateScheduledStart(
      "bracket-1",
      initialScheduledStartFormState,
      formData({ startMode: "scheduled" })
    );

    expect(result).toEqual({
      error: "A scheduled start requires a valid date and time.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("404s instead of updating the start time on a bracket that isn't the signed-in creator's", async () => {
    bracketFindFirst.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await updateScheduledStart(
        "someone-elses-bracket",
        initialScheduledStartFormState,
        formData({ startMode: "immediate" })
      );
    } catch (err) {
      thrown = err;
    }

    expect404(thrown);
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("404s instead of updating the start time when there is no signed-in user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    let thrown: unknown;
    try {
      await updateScheduledStart(
        "bracket-1",
        initialScheduledStartFormState,
        formData({ startMode: "immediate" })
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

    const result = await updateScheduledStart(
      "bracket-1",
      initialScheduledStartFormState,
      formData({ startMode: "scheduled", scheduledStartAt: FUTURE })
    );

    expect(result).toEqual({
      error:
        "This bracket is no longer a draft, so its start time can't be changed.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });
});
