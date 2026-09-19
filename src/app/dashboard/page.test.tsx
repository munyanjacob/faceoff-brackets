import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findMany },
  },
}));

const { default: DashboardPage } = await import("./page");

describe("/dashboard page", () => {
  beforeEach(() => {
    getUser.mockReset();
    findMany.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "creator-1" } }, error: null });
  });

  it("queries only the signed-in creator's brackets, newest first, with rounds selected", async () => {
    findMany.mockResolvedValue([]);

    await DashboardPage();

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: { creatorId: "creator-1" },
      orderBy: { createdAt: "desc" },
      include: { rounds: { select: { roundNumber: true } } },
    });
  });

  it("renders the explicit empty-state message when the creator has zero brackets", async () => {
    findMany.mockResolvedValue([]);

    const result = await DashboardPage();

    const html = JSON.stringify(result);
    expect(html).toContain("You haven");
    expect(html).toMatch(/created any brackets yet/);
  });

  it("maps queried brackets through the view-model and renders them newest-first", async () => {
    findMany.mockResolvedValue([
      {
        id: "b1",
        title: "Best Sitcom",
        status: "DRAFT",
        createdAt: new Date("2026-09-19T12:00:00.000Z"),
        rounds: [],
      },
      {
        id: "b2",
        title: "Best Movie",
        status: "ACTIVE",
        createdAt: new Date("2026-09-01T12:00:00.000Z"),
        rounds: [{ roundNumber: 1 }, { roundNumber: 2 }],
      },
    ]);

    const result = await DashboardPage();

    const html = JSON.stringify(result);
    expect(html).toContain("Best Sitcom");
    expect(html).toContain("DRAFT");
    expect(html).toMatch(/"-"/); // no rounds yet -> the "-" placeholder
    expect(html).toContain("Best Movie");
    expect(html).toContain("ACTIVE");
    expect(html).toContain("September 19, 2026");
    expect(html).toContain("September 1, 2026");
  });
});
