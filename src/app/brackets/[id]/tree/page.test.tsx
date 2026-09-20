import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique },
  },
}));

// `next/navigation`'s real `notFound()` is used unmocked, same as
// `../page.test.tsx` - it throws a special error (with a `digest`
// containing "404") without needing a real Next.js request context.
const { default: BracketTreePage } = await import("./page");

function params(id: string) {
  return Promise.resolve({ id });
}

function item(id: string) {
  return { id, title: `Item ${id}`, description: null, imageUrl: null };
}

describe("/brackets/[id]/tree page", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("queries the bracket by id with every round (oldest first) and each round's matchups in bracket order", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [],
    });

    await BracketTreePage({ params: params("b1") });

    expect(findUnique).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      include: {
        rounds: {
          orderBy: { roundNumber: "asc" },
          include: {
            matchups: {
              orderBy: { itemA: { createdAt: "asc" } },
              include: { itemA: true, itemB: true },
            },
          },
        },
      },
    });
  });

  it("404s when the bracket doesn't exist", async () => {
    findUnique.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await BracketTreePage({ params: params("missing") });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
  });

  it("shows a not-published message for a DRAFT bracket (no rounds yet) instead of a broken empty tree", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [],
    });

    const result = await BracketTreePage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Best Movie");
    expect(html).toContain("hasn't been published yet");
  });

  it("renders every round as its own column for an ACTIVE bracket, with a placeholder Final column for the round not created yet", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [
        {
          roundNumber: 1,
          matchups: [
            { id: "m1", status: "ACTIVE", itemA: item("a"), itemB: item("b"), winnerItemId: null },
            { id: "m2", status: "ACTIVE", itemA: item("c"), itemB: item("d"), winnerItemId: null },
          ],
        },
      ],
    });

    const result = await BracketTreePage({ params: params("b1") });
    const html = JSON.stringify(result);

    // A 4-item bracket's round 1 is the semifinal round (see the
    // view-model's own test for why); round 2 is the final.
    expect(html).toContain("Semifinal");
    expect(html).toContain("Final");
    expect(html).toContain("Item a");
    expect(html).toContain("Item b");
    expect(html).toContain("Active matchup");
    expect(html).toContain("Not yet reached");
  });

  it("renders a round-1 bye as an automatic advance rather than a played matchup", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [
        {
          roundNumber: 1,
          matchups: [
            { id: "bye-1", status: "COMPLETED", itemA: item("a"), itemB: null, winnerItemId: "a" },
            { id: "m1", status: "ACTIVE", itemA: item("b"), itemB: item("c"), winnerItemId: null },
          ],
        },
      ],
    });

    const result = await BracketTreePage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Item a advances on a bye");
    expect(html).toContain("advances automatically");
  });

  it("shows a completed matchup's winner distinctly from its loser", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [
        {
          roundNumber: 1,
          matchups: [
            { id: "m1", status: "COMPLETED", itemA: item("a"), itemB: item("b"), winnerItemId: "b" },
          ],
        },
      ],
    });

    const result = await BracketTreePage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Completed matchup");
    expect(html).toContain("font-semibold text-green-700");
    expect(html.indexOf("Item b")).toBeLessThan(html.indexOf("Item a"));
    expect(html).toContain("line-through");
  });

  it("renders a completed bracket (every round already persisted) with no leftover placeholder columns", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      rounds: [
        {
          roundNumber: 1,
          matchups: [
            { id: "m1", status: "COMPLETED", itemA: item("a"), itemB: item("b"), winnerItemId: "a" },
            { id: "m2", status: "COMPLETED", itemA: item("c"), itemB: item("d"), winnerItemId: "d" },
          ],
        },
        {
          roundNumber: 2,
          matchups: [
            { id: "m3", status: "COMPLETED", itemA: item("a"), itemB: item("d"), winnerItemId: "a" },
          ],
        },
      ],
    });

    const result = await BracketTreePage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).not.toContain("Not yet reached");
    expect((html.match(/Completed matchup/g) ?? []).length).toBe(3);
  });
});
