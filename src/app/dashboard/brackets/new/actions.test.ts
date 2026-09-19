import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const create = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { create },
  },
}));

const { createBracket, initialCreateBracketState } = await import(
  "./actions"
);

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("createBracket action", () => {
  beforeEach(() => {
    getUser.mockReset();
    create.mockReset();
    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
  });

  it("creates a DRAFT bracket owned by the current user and redirects to its edit page", async () => {
    create.mockResolvedValue({ id: "bracket-1" });

    let thrown: unknown;
    try {
      await createBracket(
        initialCreateBracketState,
        formData({
          title: "Best Sitcom",
          description: "A friendly poll.",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
        })
      );
    } catch (err) {
      thrown = err;
    }

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: {
        creatorId: "creator-1",
        title: "Best Sitcom",
        description: "A friendly poll.",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
        defaultRoundDurationMinutes: 60,
        status: "DRAFT",
      },
    });

    // next/navigation's redirect() works by throwing a special error whose
    // `digest` encodes the destination - see src/app/dashboard/actions.test.ts.
    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain(
      "/dashboard/brackets/bracket-1/edit"
    );
  });

  it("passes an optional description through as null when left blank, without touching the row shape otherwise", async () => {
    create.mockResolvedValue({ id: "bracket-2" });

    try {
      await createBracket(
        initialCreateBracketState,
        formData({
          title: "Best Movie",
          visibility: "PRIVATE",
          votingRequirement: "ACCOUNT_REQUIRED",
        })
      );
    } catch {
      // redirect() throwing is expected - assertions are on the create() call.
    }

    expect(create).toHaveBeenCalledWith({
      data: {
        creatorId: "creator-1",
        title: "Best Movie",
        description: null,
        visibility: "PRIVATE",
        votingRequirement: "ACCOUNT_REQUIRED",
        defaultRoundDurationMinutes: 60,
        status: "DRAFT",
      },
    });
  });

  it("returns a validation error and creates no row when the title is missing", async () => {
    const result = await createBracket(
      initialCreateBracketState,
      formData({
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({ error: "Title is required." });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a validation error and creates no row when the title is whitespace-only", async () => {
    const result = await createBracket(
      initialCreateBracketState,
      formData({
        title: "   ",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({ error: "Title is required." });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a validation error and creates no row when visibility is missing/invalid", async () => {
    const result = await createBracket(
      initialCreateBracketState,
      formData({
        title: "Best Sitcom",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({
      error: "Choose a visibility: Public or Private.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a validation error and creates no row when voting requirement is missing/invalid", async () => {
    const result = await createBracket(
      initialCreateBracketState,
      formData({
        title: "Best Sitcom",
        visibility: "PUBLIC",
      })
    );

    expect(result).toEqual({
      error: "Choose whether voting requires an account.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("redirects to /login and creates no row when there is no signed-in user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    let thrown: unknown;
    try {
      await createBracket(
        initialCreateBracketState,
        formData({
          title: "Best Sitcom",
          visibility: "PUBLIC",
          votingRequirement: "ANONYMOUS_ALLOWED",
        })
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/login");
    expect(create).not.toHaveBeenCalled();
  });
});
