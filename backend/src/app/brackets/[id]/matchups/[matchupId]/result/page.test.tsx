import { describe, expect, it, vi, beforeEach } from "vitest";

const matchupFindUnique = vi.fn();
const voteCount = vi.fn();
const voteFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findUnique: matchupFindUnique },
    vote: { count: voteCount, findMany: voteFindMany },
  },
}));

// `next/navigation`'s real `notFound()`/`redirect()` are used unmocked, same
// as `../page.test.tsx` - both throw a special error (with a `digest`
// containing "404" or the redirect destination) without needing a real
// Next.js request context.
const { default: MatchupResultPage } = await import("./page");

function params(id: string, matchupId: string) {
  return Promise.resolve({ id, matchupId });
}

function item(id: string) {
  return {
    id,
    title: `Item ${id}`,
    description: null,
    imageUrl: null,
  };
}

function decidedMatchup(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    status: "COMPLETED",
    itemAId: "item-a",
    itemBId: "item-b",
    itemA: item("item-a"),
    itemB: item("item-b"),
    winnerItemId: "item-a",
    tieBreakerEndsAt: null,
    round: { bracketId: "b1", bracket: { title: "Best Movie" } },
    ...overrides,
  };
}

describe("/brackets/[id]/matchups/[matchupId]/result page", () => {
  beforeEach(() => {
    matchupFindUnique.mockReset();
    voteCount.mockReset();
    voteFindMany.mockReset();
    voteCount.mockResolvedValue(0);
    voteFindMany.mockResolvedValue([]);
  });

  it("queries the matchup by id with its items and round/bracket", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup());
    voteCount.mockResolvedValueOnce(3).mockResolvedValueOnce(7);

    await MatchupResultPage({ params: params("b1", "m1") });

    expect(matchupFindUnique).toHaveBeenCalledWith({
      where: { id: "m1" },
      include: {
        itemA: true,
        itemB: true,
        round: { include: { bracket: true } },
      },
    });
  });

  it("404s when the matchup doesn't exist", async () => {
    matchupFindUnique.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await MatchupResultPage({ params: params("b1", "missing") });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { digest?: string }).digest).toContain("404");
  });

  it("404s when the matchup belongs to a different bracket than the one in the URL", async () => {
    matchupFindUnique.mockResolvedValue(
      decidedMatchup({ round: { bracketId: "some-other-bracket", bracket: { title: "Other" } } })
    );

    let thrown: unknown;
    try {
      await MatchupResultPage({ params: params("b1", "m1") });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { digest?: string }).digest).toContain("404");
  });

  it("redirects to the voting page when the matchup isn't COMPLETED yet", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup({ status: "ACTIVE" }));

    let thrown: unknown;
    try {
      await MatchupResultPage({ params: params("b1", "m1") });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { digest?: string }).digest).toContain("/brackets/b1/matchups/m1");
    expect(voteCount).not.toHaveBeenCalled();
  });

  it("shows both items, the winner marked distinctly, and each side's final vote count", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup({ winnerItemId: "item-a" }));
    voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
      where.itemId === "item-a" ? 9 : 4
    );

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Best Movie");
    expect(html).toContain("Item item-a");
    expect(html).toContain("Item item-b");
    expect(html).toContain("Winner");
    expect(html).toContain("9 votes");
    expect(html).toContain("4 votes");
    expect(voteCount).toHaveBeenCalledWith({ where: { matchupId: "m1", itemId: "item-a" } });
    expect(voteCount).toHaveBeenCalledWith({ where: { matchupId: "m1", itemId: "item-b" } });
  });

  it("lists comments left with votes on the matchup", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup());
    voteFindMany.mockResolvedValue([
      {
        id: "vote-1",
        itemId: "item-a",
        comment: "Should have been closer.",
        createdAt: new Date("2026-01-01"),
      },
    ]);

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Should have been closer.");
    expect(voteFindMany).toHaveBeenCalledWith({
      where: { matchupId: "m1", comment: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, itemId: true, comment: true, createdAt: true },
    });
  });

  it("shows a no-comments message when nothing was left", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup());

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("No comments were left on this matchup.");
  });

  it("shows a bye as a bye, with no vote tally or comment lookup at all", async () => {
    matchupFindUnique.mockResolvedValue(
      decidedMatchup({ itemBId: null, itemB: null, winnerItemId: "item-a" })
    );

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Decided by bye");
    expect(html).toContain("Advanced automatically");
    expect(html).not.toContain("votes");
    expect(voteCount).not.toHaveBeenCalled();
    expect(voteFindMany).not.toHaveBeenCalled();
  });

  it("labels a matchup decided by a tie-breaker, not identically to a clean majority win", async () => {
    matchupFindUnique.mockResolvedValue(
      decidedMatchup({ tieBreakerEndsAt: new Date("2026-01-01T00:00:00.000Z") })
    );

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("tie-breaker");
  });

  it("does not label a plain majority decision as a tie-breaker", async () => {
    matchupFindUnique.mockResolvedValue(decidedMatchup({ tieBreakerEndsAt: null }));

    const result = await MatchupResultPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).not.toContain("tie-breaker");
  });
});
