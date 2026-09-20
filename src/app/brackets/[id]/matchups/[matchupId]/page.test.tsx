import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const voteFindFirst = vi.fn();
const voteCount = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique },
    vote: { findFirst: voteFindFirst, count: voteCount },
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

// `next/headers`'s real `cookies()` only works inside a real Next.js
// request scope, which Vitest doesn't provide - same reasoning as
// `../../../lib/supabase/get-user.signed-out.test.ts`. Stubbed here with an
// empty, in-memory jar (no "voter_id" cookie) so `../../voter-identity.ts`'s
// `currentVoterLookupKey` behaves exactly like a real first-time visitor
// with no anonymous cookie yet.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
  })),
}));

// `next/navigation`'s real `notFound()` is used unmocked, same as
// `../../../dashboard/brackets/[id]/edit/page.test.tsx` - it throws a
// special error (with a `digest` containing "404") without needing a real
// Next.js request context, so no mock is needed here either.
const { default: BracketMatchupVotingPage } = await import("./page");

function params(id: string, matchupId: string) {
  return Promise.resolve({ id, matchupId });
}

const ACTIVE_MATCHUP_ROUNDS = (status: string) => [
  {
    status: "ACTIVE",
    matchups: [
      {
        id: "m1",
        status,
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
];

describe("/brackets/[id]/matchups/[matchupId] page", () => {
  beforeEach(() => {
    findUnique.mockReset();
    voteFindFirst.mockReset();
    voteCount.mockReset();
    getUser.mockReset();

    // Default: signed out, no existing vote - the common case for most
    // tests below that don't care about voter identity.
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    voteFindFirst.mockResolvedValue(null);
    voteCount.mockResolvedValue(0);
  });

  it("queries the bracket by id with only its ACTIVE round and that round's matchups/items", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });

    await BracketMatchupVotingPage({ params: params("b1", "m1") });

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
      await BracketMatchupVotingPage({ params: params("missing", "m1") });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
  });

  it("404s when the matchupId doesn't match any votable matchup in the bracket's ACTIVE round", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });

    let thrown: unknown;
    try {
      await BracketMatchupVotingPage({ params: params("b1", "no-such-matchup") });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("404");
    // No point doing a signed-in check or Vote lookup for a matchup that
    // doesn't even resolve.
    expect(getUser).not.toHaveBeenCalled();
    expect(voteFindFirst).not.toHaveBeenCalled();
  });

  it("does no signed-in check or Vote lookup when there's no active matchup to vote on at all", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "DRAFT",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [],
    });

    await BracketMatchupVotingPage({ params: params("b1", "m1") });

    expect(getUser).not.toHaveBeenCalled();
    expect(voteFindFirst).not.toHaveBeenCalled();
  });

  it("shows a not-started status message for a DRAFT bracket instead of a broken layout, even for a made-up matchupId", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "DRAFT",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [],
    });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
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

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
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

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("has finished");
  });

  it("renders both items of the named matchup side by side, with title, description, image, and a real Vote control each, when the voter is eligible and hasn't voted yet", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("The Matrix");
    expect(html).toContain("A hacker discovers reality is a simulation.");
    expect(html).toContain("https://example.com/matrix.png");
    expect(html).toContain("Inception");
    // No image for Item B -> a placeholder, not a missing/broken element.
    expect(html).toContain("No image");
    // Issue #22: a real <VoteButton> client element per item (its own
    // internal "Vote" text/pending state is opaque to JSON.stringify - see
    // ../../matchup-voting.tsx's top comment - but its props, bound to this
    // matchup and each item, are still visible).
    expect((html.match(/"matchupId":"m1"/g) ?? []).length).toBe(2);
    expect(html).toContain('"itemId":"item-a"');
    expect(html).toContain('"itemId":"item-b"');
  });

  it("renders a TIE_BREAKER matchup like an ACTIVE one, with a tie-breaker note and votable controls", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("TIE_BREAKER"),
    });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("The Matrix");
    expect(html).toContain("Inception");
    expect(html).toContain("tie-breaker");
    expect((html.match(/"matchupId":"m1"/g) ?? []).length).toBe(2);
  });

  it("blocks voting with a sign-in message, and renders no Vote control, on an ACCOUNT_REQUIRED bracket for a signed-out visitor", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ACCOUNT_REQUIRED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Sign in to vote on this bracket.");
    expect(html).not.toContain('"matchupId"');
    // No Vote lookup needed either - a blocked visitor can't have a vote.
    expect(voteFindFirst).not.toHaveBeenCalled();
  });

  it("allows voting on an ACCOUNT_REQUIRED bracket for a signed-in visitor", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ACCOUNT_REQUIRED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });
    getUser.mockResolvedValue({
      data: { user: { id: "voter-1" } },
      error: null,
    });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).not.toContain("Sign in to vote");
    expect((html.match(/"matchupId":"m1"/g) ?? []).length).toBe(2);
    expect(voteFindFirst).toHaveBeenCalledWith({
      where: { matchupId: "m1", userId: "voter-1" },
    });
  });

  it("shows the voter's existing choice instead of Vote controls when they've already voted (signed in)", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });
    getUser.mockResolvedValue({
      data: { user: { id: "voter-1" } },
      error: null,
    });
    voteFindFirst.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Your vote");
    // No Vote control at all once an existing vote is known.
    expect(html).not.toContain('"matchupId"');
  });

  describe("issue #24: live results after voting", () => {
    it("never queries vote counts for a voter who hasn't voted yet", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
      });
      voteFindFirst.mockResolvedValue(null);

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(voteCount).not.toHaveBeenCalled();
      expect(html).not.toMatch(/\d+ votes?"/);
    });

    it("never queries or shows vote counts for a blocked (signed-out, ACCOUNT_REQUIRED) voter", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ACCOUNT_REQUIRED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
      });
      getUser.mockResolvedValue({ data: { user: null }, error: null });

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(voteCount).not.toHaveBeenCalled();
      expect(html).not.toMatch(/\d+ votes?"/);
    });

    it("queries and shows current vote counts for both items once the signed-in voter has already voted", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
      });
      getUser.mockResolvedValue({
        data: { user: { id: "voter-1" } },
        error: null,
      });
      voteFindFirst.mockResolvedValue({ id: "vote-1", itemId: "item-a" });
      voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
        where.itemId === "item-a" ? 7 : 3
      );

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(voteCount).toHaveBeenCalledWith({
        where: { matchupId: "m1", itemId: "item-a" },
      });
      expect(voteCount).toHaveBeenCalledWith({
        where: { matchupId: "m1", itemId: "item-b" },
      });
      expect(html).toContain('"7 votes"');
      expect(html).toContain('"3 votes"');
    });

    it("shows the singular 'vote' for a count of exactly 1", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
      });
      getUser.mockResolvedValue({
        data: { user: { id: "voter-1" } },
        error: null,
      });
      voteFindFirst.mockResolvedValue({ id: "vote-1", itemId: "item-a" });
      voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
        where.itemId === "item-a" ? 1 : 0
      );

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).toContain('"1 vote"');
      expect(html).not.toContain('"1 votes"');
      expect(html).toContain('"0 votes"');
    });

    it("shows the same, up-to-date vote counts for both items when revisiting a matchup already voted on (this is what makes a refresh show others' votes too)", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
      });
      // A signed-in voter revisiting later - same `determineVoterContext`
      // path a returning anonymous voter with a valid cookie would take
      // (see `./voter-identity.ts`'s `currentVoterLookupKey`); this test
      // suite's `next/headers` mock never carries a cookie, so a signed-in
      // identity is what actually exercises the "found an existing Vote on
      // this page load, not from a just-submitted form" path here.
      getUser.mockResolvedValue({
        data: { user: { id: "voter-1" } },
        error: null,
      });
      voteFindFirst.mockResolvedValue({ id: "vote-1", itemId: "item-b" });
      voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
        where.itemId === "item-a" ? 10 : 12
      );

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).toContain("Your vote");
      expect(html).toContain('"10 votes"');
      expect(html).toContain('"12 votes"');
    });
  });

  it("looks up an existing vote by userId when signed in, without ever reading an anonymous cookie", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });
    getUser.mockResolvedValue({
      data: { user: { id: "voter-1" } },
      error: null,
    });

    await BracketMatchupVotingPage({ params: params("b1", "m1") });

    expect(voteFindFirst).toHaveBeenCalledWith({
      where: { matchupId: "m1", userId: "voter-1" },
    });
  });

  it("skips the existing-vote lookup entirely for a signed-out visitor with no anonymous cookie yet", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    await BracketMatchupVotingPage({ params: params("b1", "m1") });

    expect(voteFindFirst).not.toHaveBeenCalled();
  });

  describe("issue #25: round/tie-breaker countdown", () => {
    it("passes the active Round's endsAt as the countdown for a plain ACTIVE matchup", async () => {
      const endsAt = new Date("2026-01-02T00:00:00.000Z");
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: [{ ...ACTIVE_MATCHUP_ROUNDS("ACTIVE")[0], endsAt }],
      });

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).toContain(`"endsAt":"${endsAt.toISOString()}"`);
    });

    it("passes the matchup's own tieBreakerEndsAt (not the Round's endsAt) as the countdown for a TIE_BREAKER matchup", async () => {
      const roundEndsAt = new Date("2026-01-01T00:00:00.000Z"); // already passed
      const tieBreakerEndsAt = new Date("2026-01-02T01:00:00.000Z");
      const rounds = ACTIVE_MATCHUP_ROUNDS("TIE_BREAKER");
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: [
          {
            ...rounds[0],
            endsAt: roundEndsAt,
            matchups: [{ ...rounds[0].matchups[0], tieBreakerEndsAt }],
          },
        ],
      });

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).toContain(`"endsAt":"${tieBreakerEndsAt.toISOString()}"`);
      expect(html).not.toContain(`"endsAt":"${roundEndsAt.toISOString()}"`);
    });

    it("renders no countdown when the active Round has no endsAt set", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "ACTIVE",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"), // no endsAt field at all
      });

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).not.toContain('"endsAt"');
    });

    it("renders no countdown on the bracket-level not-started status message", async () => {
      findUnique.mockResolvedValue({
        id: "b1",
        title: "Best Movie",
        status: "DRAFT",
        votingRequirement: "ANONYMOUS_ALLOWED",
        rounds: [],
      });

      const result = await BracketMatchupVotingPage({ params: params("b1", "m1") });
      const html = JSON.stringify(result);

      expect(html).not.toContain('"endsAt"');
    });
  });

  it("scopes to the named matchup even when the ACTIVE round has more than one votable matchup", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
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
            {
              id: "m2",
              status: "ACTIVE",
              itemA: {
                id: "item-c",
                title: "Alien",
                description: null,
                imageUrl: null,
              },
              itemB: {
                id: "item-d",
                title: "Predator",
                description: null,
                imageUrl: null,
              },
            },
          ],
        },
      ],
    });

    const result = await BracketMatchupVotingPage({ params: params("b1", "m2") });
    const html = JSON.stringify(result);

    expect(html).toContain("Alien");
    expect(html).toContain("Predator");
    expect(html).not.toContain("The Matrix");
    expect(html).not.toContain("Inception");
    expect((html.match(/"matchupId":"m2"/g) ?? []).length).toBe(2);
  });
});
