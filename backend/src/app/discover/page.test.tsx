import { describe, expect, it, vi, beforeEach } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findMany },
  },
}));

// `connection()` needs a real request scope, which calling the page
// directly doesn't provide.
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));

const { default: DiscoverPage } = await import("./page");

describe("/discover page", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("queries only PUBLIC, non-DRAFT brackets, newest-published-first, with the creator's display name", async () => {
    findMany.mockResolvedValue([]);

    await DiscoverPage();

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: {
        visibility: "PUBLIC",
        status: { in: ["SCHEDULED", "ACTIVE", "COMPLETED"] },
      },
      orderBy: { publishedAt: "desc" },
      include: { creator: { select: { displayName: true } } },
    });
  });

  it("shows an explicit 'nothing here yet' message in every group when there are no public brackets at all", async () => {
    findMany.mockResolvedValue([]);

    const result = await DiscoverPage();
    const html = JSON.stringify(result);

    expect(html).toContain("No recently published brackets yet.");
    expect(html).toContain("No active brackets yet.");
    expect(html).toContain("No completed brackets yet.");
  });

  it("shows the empty message only for the groups that truly have nothing, rendering the rest", async () => {
    findMany.mockResolvedValue([
      {
        id: "a1",
        title: "Best Movie",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-01T12:00:00.000Z"),
        creator: { displayName: "Sam" },
      },
    ]);

    const result = await DiscoverPage();
    const html = JSON.stringify(result);

    // Recent and Completed have nothing -> explicit empty messages.
    expect(html).toContain("No recently published brackets yet.");
    expect(html).toContain("No completed brackets yet.");
    // Active has one entry -> not the empty message, and the entry renders.
    expect(html).not.toContain("No active brackets yet.");
    expect(html).toContain("Best Movie");
    expect(html).toContain("Sam");
    expect(html).toContain("September 1, 2026");
  });

  it("renders brackets across all three groups from a single mixed query result", async () => {
    findMany.mockResolvedValue([
      {
        id: "s1",
        title: "Upcoming Bracket",
        visibility: "PUBLIC",
        status: "SCHEDULED",
        publishedAt: new Date("2026-09-10T12:00:00.000Z"),
        creator: { displayName: "Alex" },
      },
      {
        id: "a1",
        title: "Ongoing Bracket",
        visibility: "PUBLIC",
        status: "ACTIVE",
        publishedAt: new Date("2026-09-05T12:00:00.000Z"),
        creator: { displayName: "Sam" },
      },
      {
        id: "c1",
        title: "Finished Bracket",
        visibility: "PUBLIC",
        status: "COMPLETED",
        publishedAt: new Date("2026-08-01T12:00:00.000Z"),
        creator: { displayName: "Jo" },
      },
    ]);

    const result = await DiscoverPage();
    const html = JSON.stringify(result);

    expect(html).toContain("Upcoming Bracket");
    expect(html).toContain("Ongoing Bracket");
    expect(html).toContain("Finished Bracket");
    expect(html).not.toContain("No recently published brackets yet.");
    expect(html).not.toContain("No active brackets yet.");
    expect(html).not.toContain("No completed brackets yet.");
  });
});
