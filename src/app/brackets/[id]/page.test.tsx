import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const voteFindFirst = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findUnique },
    vote: { findFirst: voteFindFirst },
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

// `next/headers`'s real `cookies()` only works inside a real Next.js
// request scope, which Vitest doesn't provide - same reasoning as
// `../../lib/supabase/get-user.signed-out.test.ts`. Stubbed here with an
// empty, in-memory jar (no "voter_id" cookie) so `./voter-identity.ts`'s
// `currentVoterLookupKey` behaves exactly like a real first-time visitor
// with no anonymous cookie yet.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
  })),
}));

// `next/navigation`'s real `notFound()` is used unmocked, same as
// `../../dashboard/brackets/[id]/edit/page.test.tsx` - it throws a special
// error (with a `digest` containing "404") without needing a real Next.js
// request context, so no mock is needed here either.
const { default: BracketVotingPage } = await import("./page");

function params(id: string) {
  return Promise.resolve({ id });
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

describe("/brackets/[id] page", () => {
  beforeEach(() => {
    findUnique.mockReset();
    voteFindFirst.mockReset();
    getUser.mockReset();

    // Default: signed out, no existing vote - the common case for most
    // tests below that don't care about voter identity.
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    voteFindFirst.mockResolvedValue(null);
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

  it("does no signed-in check or Vote lookup when there's no active matchup to vote on", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "DRAFT",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: [],
    });

    await BracketVotingPage({ params: params("b1") });

    expect(getUser).not.toHaveBeenCalled();
    expect(voteFindFirst).not.toHaveBeenCalled();
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

  it("renders both items of the active matchup side by side, with title, description, image, and a real Vote control each, when the voter is eligible and hasn't voted yet", async () => {
    findUnique.mockResolvedValue({
      id: "b1",
      title: "Best Movie",
      status: "ACTIVE",
      votingRequirement: "ANONYMOUS_ALLOWED",
      rounds: ACTIVE_MATCHUP_ROUNDS("ACTIVE"),
    });

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("The Matrix");
    expect(html).toContain("A hacker discovers reality is a simulation.");
    expect(html).toContain("https://example.com/matrix.png");
    expect(html).toContain("Inception");
    // No image for Item B -> a placeholder, not a missing/broken element.
    expect(html).toContain("No image");
    // Issue #22: a real <VoteButton> client element per item (its own
    // internal "Vote" text/pending state is opaque to JSON.stringify - see
    // ./matchup-voting.tsx's top comment - but its props, bound to this
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

    const result = await BracketVotingPage({ params: params("b1") });
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

    const result = await BracketVotingPage({ params: params("b1") });
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

    const result = await BracketVotingPage({ params: params("b1") });
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

    const result = await BracketVotingPage({ params: params("b1") });
    const html = JSON.stringify(result);

    expect(html).toContain("Your vote");
    // No Vote control at all once an existing vote is known.
    expect(html).not.toContain('"matchupId"');
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

    await BracketVotingPage({ params: params("b1") });

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

    await BracketVotingPage({ params: params("b1") });

    expect(voteFindFirst).not.toHaveBeenCalled();
  });
});
