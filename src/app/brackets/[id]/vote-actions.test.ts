import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

const getUser = vi.fn();
const matchupFindUnique = vi.fn();
const voteFindFirst = vi.fn();
const voteCount = vi.fn();
const voteCreate = vi.fn();
const revalidatePath = vi.fn();
const randomUUID = vi.fn();

const cookieGet = vi.fn();
const cookieSet = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findUnique: matchupFindUnique },
    vote: { findFirst: voteFindFirst, count: voteCount, create: voteCreate },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: cookieGet,
    set: cookieSet,
  })),
}));

// Only `randomUUID` is mocked here - `signAnonymousVoterId`/
// `verifyAnonymousVoterId` (issue #35) are exercised for real (not mocked),
// same "mock the primitive, not the logic under test" reasoning as leaving
// `Prisma`'s error class itself unmocked below. They're deterministic pure
// functions of `VOTE_COOKIE_SECRET` (or its dev fallback), so real signing
// and verifying within a single test run is both simpler and more honest
// than hand-rolling a fake cookie format here.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID };
});

const { castVote, initialVoteFormState, RATE_LIMIT_ERROR, VOTE_RATE_LIMIT_MAX_VOTES } =
  await import("./vote-actions");
const { signAnonymousVoterId } = await import("./voter-identity");

function activeMatchup(overrides: Record<string, unknown> = {}) {
  return {
    id: "matchup-1",
    itemAId: "item-a",
    itemBId: "item-b",
    status: "ACTIVE",
    round: {
      id: "round-1",
      status: "ACTIVE",
      bracketId: "bracket-1",
      bracket: { id: "bracket-1", votingRequirement: "ANONYMOUS_ALLOWED" },
    },
    ...overrides,
  };
}

describe("castVote", () => {
  beforeEach(() => {
    getUser.mockReset();
    matchupFindUnique.mockReset();
    voteFindFirst.mockReset();
    voteCount.mockReset();
    voteCreate.mockReset();
    revalidatePath.mockReset();
    randomUUID.mockReset();
    cookieGet.mockReset();
    cookieSet.mockReset();

    getUser.mockResolvedValue({ data: { user: null }, error: null });
    voteFindFirst.mockResolvedValue(null);
    voteCount.mockResolvedValue(0);
    cookieGet.mockReturnValue(undefined);
    randomUUID.mockReturnValue("generated-anon-id");
  });

  it("404s-equivalent: returns an error when the matchup doesn't exist, without touching Vote", async () => {
    matchupFindUnique.mockResolvedValue(null);

    const result = await castVote(
      "missing-matchup",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "This matchup no longer exists.",
      votedItemId: null,
    });
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("rejects an itemId that isn't one of this matchup's two items", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());

    const result = await castVote(
      "matchup-1",
      "some-other-item",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "That's not a valid choice for this matchup.",
      votedItemId: null,
    });
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("rejects a vote when the round has already closed (COMPLETED)", async () => {
    matchupFindUnique.mockResolvedValue(
      activeMatchup({ round: { ...activeMatchup().round, status: "COMPLETED" } })
    );

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Voting has closed for this round.",
      votedItemId: null,
    });
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("rejects a vote when the round hasn't started yet (PENDING)", async () => {
    matchupFindUnique.mockResolvedValue(
      activeMatchup({ round: { ...activeMatchup().round, status: "PENDING" } })
    );

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result.error).toBe("Voting has closed for this round.");
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("rejects a vote on a PENDING matchup (e.g. a bye or not-yet-reached matchup) even in an ACTIVE round", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup({ status: "PENDING" }));

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Voting isn't open for this matchup.",
      votedItemId: null,
    });
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("rejects a vote on an already-COMPLETED matchup", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup({ status: "COMPLETED" }));

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result.error).toBe("Voting isn't open for this matchup.");
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("accepts a vote on a TIE_BREAKER matchup - #29's tally is meant to count these", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup({ status: "TIE_BREAKER" }));
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({ error: null, votedItemId: "item-a" });
    expect(voteCreate).toHaveBeenCalled();
  });

  it("blocks an ACCOUNT_REQUIRED bracket for a signed-out visitor with a sign-in message, and never touches the cookie or Vote", async () => {
    matchupFindUnique.mockResolvedValue(
      activeMatchup({
        round: {
          ...activeMatchup().round,
          bracket: { id: "bracket-1", votingRequirement: "ACCOUNT_REQUIRED" },
        },
      })
    );

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({
      error: "Sign in to vote on this bracket.",
      votedItemId: null,
    });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("records a signed-in voter's Vote.userId as their Profile id, never touching the anonymous cookie", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        matchupId: "matchup-1",
        itemId: "item-a",
        userId: "profile-1",
        anonymousVoterIdentifier: null,
      },
    });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(result).toEqual({ error: null, votedItemId: "item-a" });
    expect(revalidatePath).toHaveBeenCalledWith("/brackets/bracket-1");
  });

  it("mints and sets a new, signed anonymous cookie identifier when ANONYMOUS_ALLOWED and no cookie exists yet, and uses the raw id as Vote.anonymousVoterIdentifier", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    cookieGet.mockReturnValue(undefined);
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    await castVote("matchup-1", "item-a", initialVoteFormState, new FormData());

    expect(cookieSet).toHaveBeenCalledWith(
      "voter_id",
      signAnonymousVoterId("generated-anon-id"),
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        matchupId: "matchup-1",
        itemId: "item-a",
        userId: null,
        anonymousVoterIdentifier: "generated-anon-id",
      },
    });
  });

  it("reuses an existing, validly signed anonymous cookie identifier instead of minting a new one", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    cookieGet.mockReturnValue({ value: signAnonymousVoterId("existing-anon-id") });
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    await castVote("matchup-1", "item-a", initialVoteFormState, new FormData());

    expect(cookieSet).not.toHaveBeenCalled();
    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        matchupId: "matchup-1",
        itemId: "item-a",
        userId: null,
        anonymousVoterIdentifier: "existing-anon-id",
      },
    });
  });

  it("mints a fresh, freshly signed identifier when the cookie's id has been hand-edited (signature no longer matches)", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    // A cookie with a valid-*looking* signature suffix, but for a
    // different id than the one now present - simulates a voter editing
    // the httpOnly-but-still-swappable cookie value directly.
    cookieGet.mockReturnValue({
      value: "attacker-chosen-id.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    await castVote("matchup-1", "item-a", initialVoteFormState, new FormData());

    expect(cookieSet).toHaveBeenCalledWith(
      "voter_id",
      signAnonymousVoterId("generated-anon-id"),
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        matchupId: "matchup-1",
        itemId: "item-a",
        userId: null,
        anonymousVoterIdentifier: "generated-anon-id",
      },
    });
  });

  it("mints a fresh identifier for a pre-#35, unsigned cookie value (no signature suffix at all)", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    cookieGet.mockReturnValue({ value: "old-unsigned-uuid" });
    voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

    await castVote("matchup-1", "item-a", initialVoteFormState, new FormData());

    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        matchupId: "matchup-1",
        itemId: "item-a",
        userId: null,
        anonymousVoterIdentifier: "generated-anon-id",
      },
    });
  });

  it("proactively finds an existing vote and returns it without attempting an insert", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
    voteFindFirst.mockResolvedValue({ id: "vote-existing", itemId: "item-b" });

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({ error: null, votedItemId: "item-b" });
    expect(voteCreate).not.toHaveBeenCalled();
  });

  it("recovers from a P2002 unique constraint violation (a race the proactive check missed) by looking up and returning the existing vote, not an error", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
    voteFindFirst
      .mockResolvedValueOnce(null) // proactive check: nothing yet
      .mockResolvedValueOnce({ id: "vote-race-winner", itemId: "item-b" }); // after the race
    voteCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const result = await castVote(
      "matchup-1",
      "item-a",
      initialVoteFormState,
      new FormData()
    );

    expect(result).toEqual({ error: null, votedItemId: "item-b" });
  });

  it("rethrows a non-P2002 error from the Vote insert instead of swallowing it", async () => {
    matchupFindUnique.mockResolvedValue(activeMatchup());
    getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
    voteCreate.mockRejectedValue(new Error("connection reset"));

    await expect(
      castVote("matchup-1", "item-a", initialVoteFormState, new FormData())
    ).rejects.toThrow("connection reset");
  });

  describe("rate limiting (issue #35)", () => {
    it("rejects a vote once the identifier has hit the cap of recent Votes, without inserting", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
      voteCount.mockResolvedValue(VOTE_RATE_LIMIT_MAX_VOTES);

      const result = await castVote(
        "matchup-1",
        "item-a",
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: RATE_LIMIT_ERROR, votedItemId: null });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("allows a vote when the identifier is still under the cap", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
      voteCount.mockResolvedValue(VOTE_RATE_LIMIT_MAX_VOTES - 1);
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const result = await castVote(
        "matchup-1",
        "item-a",
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null, votedItemId: "item-a" });
      expect(voteCreate).toHaveBeenCalled();
    });

    it("counts recent votes by the same voter key the vote itself is being recorded under", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      cookieGet.mockReturnValue({ value: signAnonymousVoterId("anon-voter-1") });
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      await castVote("matchup-1", "item-a", initialVoteFormState, new FormData());

      expect(voteCount).toHaveBeenCalledWith({
        where: {
          anonymousVoterIdentifier: "anon-voter-1",
          createdAt: { gte: expect.any(Date) },
        },
      });
    });

    it("never even checks the rate limit when the voter already has a vote on this matchup (the proactive-existing-vote short circuit)", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getUser.mockResolvedValue({ data: { user: { id: "profile-1" } }, error: null });
      voteFindFirst.mockResolvedValue({ id: "vote-existing", itemId: "item-b" });

      const result = await castVote(
        "matchup-1",
        "item-a",
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null, votedItemId: "item-b" });
      expect(voteCount).not.toHaveBeenCalled();
    });
  });
});
