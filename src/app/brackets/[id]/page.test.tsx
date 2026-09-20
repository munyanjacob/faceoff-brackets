import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique },
  },
}));

// `next/navigation`'s real `notFound()` is used unmocked, same as
// `../../dashboard/brackets/[id]/edit/page.test.tsx` - it throws a special
// error (with a `digest` containing "404") without needing a real Next.js
// request context, so no mock is needed here either.
const { default: BracketVotingPage } = await import("./page");

function params(id: string) {
  return Promise.resolve({ id });
}

describe("/brackets/[id] page", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("queries the bracket by id with only its ACTIVE round and that round's matchups/items", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "DRAFT",
      rounds: [],
    });

    await BracketVotingPage({ params: params("b1") });

    expect(findUnique).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      include: {
        rounds: {
          where: { status: "ACTIVE" },
          include: {
            matchups: {
              orderBy: { id: "asc" },
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
      await BracketVotingPage({ params: params("missing") });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
  });

  it("shows a not-started status message for a DRAFT bracket instead of a broken layout", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "DRAFT",
      rounds: [],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Best Movie");
    expect(html).toContain("hasn't started voting yet");
  });

  it("shows a between-rounds status message for an ACTIVE bracket with no ACTIVE round", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      rounds: [],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("isn't open right now");
  });

  it("shows a completed status message for a COMPLETED bracket", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "COMPLETED",
      rounds: [],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("has finished");
  });

  it("renders both items of the active matchup side by side, with title, description, image, and a vote action each", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      rounds: [
        {
          status: "ACTIVE",
          matchups: [
            {
              id: "m1",
              status: "ACTIVE",
              itemA: {
                id: "item-a",
                title: "The Matrix",
                description: "A hacker discovers reality is a simulation.",
                imageUrl: "https://example.com/matrix.png",
              },
              itemB: {
                id: "item-b",
                title: "Inception",
                description: null,
                imageUrl: null,
              },
            },
          ],
        },
      ],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("The Matrix");
    expect(html).toContain("A hacker discovers reality is a simulation.");
    expect(html).toContain("https://example.com/matrix.png");
    expect(html).toContain("Inception");
    // No image for Item B -> a placeholder, not a missing/broken element.
    expect(html).toContain("No image");
    // A vote action under each item - two disabled placeholder buttons.
    expect((html.match(/"Vote"/g) ?? []).length).toBe(2);
  });

  it("renders a TIE_BREAKER matchup like an ACTIVE one, with a tie-breaker note", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      rounds: [
        {
          status: "ACTIVE",
          matchups: [
            {
              id: "m1",
              status: "TIE_BREAKER",
              itemA: {
                id: "item-a",
                title: "The Matrix",
                description: null,
                imageUrl: null,
              },
              itemB: {
                id: "item-b",
                title: "Inception",
                description: null,
                imageUrl: null,
              },
            },
          ],
        },
      ],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("The Matrix");
    expect(html).toContain("Inception");
    expect(html).toContain("tie-breaker");
    expect((html.match(/"Vote"/g) ?? []).length).toBe(2);
  });
});
