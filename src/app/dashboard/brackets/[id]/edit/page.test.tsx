import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst },
  },
}));

const { default: EditBracketPage } = await import("./page");

describe("/dashboard/brackets/[id]/edit page", () => {
  beforeEach(() => {
    getUser.mockReset();
    findFirst.mockReset();
    getUser.mockResolvedValue({
      data: { user: { id: "creator-1" } },
      error: null,
    });
  });

  it("looks the bracket up scoped to the signed-in creator, not by id alone", async () => {
    findFirst.mockResolvedValue({ id: "bracket-1", title: "Best Sitcom" });

    await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("renders the placeholder page with the bracket's title", async () => {
    findFirst.mockResolvedValue({ id: "bracket-1", title: "Best Sitcom" });

    const result = await EditBracketPage({
      params: Promise.resolve({ id: "bracket-1" }),
      searchParams: Promise.resolve({}),
    });

    const html = JSON.stringify(result);
    expect(html).toContain("Best Sitcom");
    expect(html).toMatch(/placeholder/i);
  });

  it("404s instead of leaking a bracket that doesn't belong to the signed-in creator", async () => {
    findFirst.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await EditBracketPage({
        params: Promise.resolve({ id: "someone-elses-bracket" }),
        searchParams: Promise.resolve({}),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
  });
});
