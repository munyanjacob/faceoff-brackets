import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique },
  },
}));

// `next/navigation`'s real `notFound()`/`redirect()` are used unmocked,
// same as `../../dashboard/brackets/[id]/edit/page.test.tsx` and
// `../../dashboard/layout.test.tsx` - both throw a special error (with a
// `digest` encoding "404" or the destination) without needing a real
// Next.js request context, so no mock is needed here either.
const { default: BracketVotingPage } = await import("./page");

function params(id: string) {
  return Promise.resolve({ id });
}

function matchup(id: string, status = "ACTIVE") {
  return {
    id,
    status,
    itemA: {
      id: `${id}-item-a`,
      title: `${id} Item A`,
      description: null,
      imageUrl: null,
    },
    itemB: {
      id: `${id}-item-b`,
      title: `${id} Item B`,
      description: null,
      imageUrl: null,
    },
  };
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
      votingRequirement: "ANONYMOUS_ALLOWED",
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
      votingRequirement: "ANONYMOUS_ALLOWED",
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
      votingRequirement: "ANONYMOUS_ALLOWED",
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
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("has finished");
  });

  it("redirects straight to the single matchup's own URL when the ACTIVE round has exactly one votable matchup (issue #40's common case)", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [{ status: "ACTIVE", matchups: [matchup("m1")] }],
    });

    let thrown: unknown;
    try {
      await BracketVotingPage({ params: params("b1") });
    } catch (err) {
      thrown = err;
    }

    // next/navigation's redirect() works by throwing a special error whose
    // `digest` encodes the destination - see
    // `../../dashboard/layout.test.tsx` for the same pattern.
    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain(
      "/brackets/b1/matchups/m1"
    );
  });

  it("redirects to the single matchup's URL even when it's a TIE_BREAKER", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [{ status: "ACTIVE", matchups: [matchup("m1", "TIE_BREAKER")] }],
    });

    let thrown: unknown;
    try {
      await BracketVotingPage({ params: params("b1") });
    } catch (err) {
      thrown = err;
    }

    expect((thrown as { digest?: string }).digest).toContain(
      "/brackets/b1/matchups/m1"
    );
  });

  it("renders an index of links (item titles as link text) instead of redirecting when more than one matchup is votable at once", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [
        {
          status: "ACTIVE",
          matchups: [matchup("m1"), matchup("m2", "TIE_BREAKER")],
        },
      ],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Best Movie");
    expect(html).toContain("/brackets/b1/matchups/m1");
    expect(html).toContain("m1 Item A vs m1 Item B");
    expect(html).toContain("/brackets/b1/matchups/m2");
    expect(html).toContain("m2 Item A vs m2 Item B");
  });

  it("does not render vote controls or item images/descriptions on the index", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [
        { status: "ACTIVE", matchups: [matchup("m1"), matchup("m2")] },
      ],
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).not.toContain('"matchupId"');
  });
});
