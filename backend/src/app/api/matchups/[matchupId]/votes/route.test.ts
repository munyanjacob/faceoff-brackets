import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";

// Same "mock the primitive, not the logic under test" split as
// ../../../../brackets/[id]/vote-actions.test.ts: `getAuthenticatedUserId`
// (this REST endpoint's identity boundary, ../../../../lib/api/auth.ts) and
// Prisma are mocked; `signAnonymousVoterId`/`verifyAnonymousVoterId`
// (../../../../brackets/[id]/voter-identity.ts) and
// `isVotableMatchupStatus` (../../../../brackets/[id]/voting-view-model.ts)
// are exercised for real, since they're deterministic pure/crypto functions
// with no I/O of their own.
const getAuthenticatedUserId = vi.fn();
const matchupFindUnique = vi.fn();
const voteFindFirst = vi.fn();
const voteCount = vi.fn();
const voteCreate = vi.fn();
const randomUUID = vi.fn();

vi.mock("@/lib/api/auth", () => ({ getAuthenticatedUserId }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findUnique: matchupFindUnique },
    vote: { findFirst: voteFindFirst, count: voteCount, create: voteCreate },
  },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID };
});

const { POST, OPTIONS } = await import("./route");
const { signAnonymousVoterId } = await import(
  "@/app/brackets/[id]/voter-identity"
);
const {
  RATE_LIMIT_ERROR,
  VOTE_RATE_LIMIT_MAX_VOTES,
  MAX_COMMENT_LENGTH,
  COMMENT_TOO_LONG_ERROR,
} = await import("@/app/brackets/[id]/vote-form-state");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";
const VOTER_COOKIE_DOMAIN = process.env.VOTER_COOKIE_DOMAIN ?? ".example.com";

function makeRequest(options: {
  itemId?: string;
  comment?: string;
  authorization?: string;
  cookie?: string;
  origin?: string;
  rawBody?: string;
} = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization !== undefined) {
    headers.set("authorization", options.authorization);
  }
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  headers.set("origin", options.origin ?? ALLOWED_ORIGIN);

  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : JSON.stringify({ itemId: options.itemId, comment: options.comment });

  return new NextRequest("http://localhost/api/matchups/matchup-1/votes", {
    method: "POST",
    headers,
    body,
  });
}

function callPost(
  options: Parameters<typeof makeRequest>[0] = {},
  matchupId = "matchup-1"
) {
  return POST(makeRequest(options), {
    params: Promise.resolve({ matchupId }),
  });
}

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

describe("POST /api/matchups/[matchupId]/votes", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset().mockResolvedValue(null);
    matchupFindUnique.mockReset();
    voteFindFirst.mockReset().mockResolvedValue(null);
    voteCount.mockReset().mockResolvedValue(0);
    voteCreate.mockReset();
    randomUUID.mockReset().mockReturnValue("generated-anon-id");
  });

  describe("§4.7 step 1: matchup existence", () => {
    it("returns 404 MATCHUP_NOT_FOUND when the matchup doesn't exist, without touching Vote", async () => {
      matchupFindUnique.mockResolvedValue(null);

      const response = await callPost({ itemId: "item-a" }, "missing-matchup");

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "MATCHUP_NOT_FOUND",
        message: "This matchup no longer exists.",
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });
  });

  describe("§4.7 step 2: item validity", () => {
    it("returns 400 INVALID_ITEM for an itemId that isn't one of this matchup's two items", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());

      const response = await callPost({ itemId: "some-other-item" });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_ITEM",
        message: "That's not a valid choice for this matchup.",
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("returns 400 INVALID_ITEM for a missing itemId field", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());

      const response = await callPost({});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_ITEM",
      });
    });

    it("returns 400 INVALID_ITEM for a malformed (non-JSON) request body, rather than throwing", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());

      const response = await callPost({ rawBody: "not json" });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_ITEM",
        message: "That's not a valid choice for this matchup.",
      });
    });
  });

  describe("§4.7 step 3: round must be ACTIVE", () => {
    it("returns 409 ROUND_CLOSED when the round has already closed (COMPLETED)", async () => {
      matchupFindUnique.mockResolvedValue(
        activeMatchup({ round: { ...activeMatchup().round, status: "COMPLETED" } })
      );

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "ROUND_CLOSED",
        message: "Voting has closed for this round.",
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("returns 409 ROUND_CLOSED when the round hasn't started yet (PENDING)", async () => {
      matchupFindUnique.mockResolvedValue(
        activeMatchup({ round: { ...activeMatchup().round, status: "PENDING" } })
      );

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "ROUND_CLOSED",
      });
    });
  });

  describe("§4.7 step 4: matchup must be votable", () => {
    it("returns 409 MATCHUP_NOT_VOTABLE for a PENDING matchup (e.g. a bye) even in an ACTIVE round", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup({ status: "PENDING" }));

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "MATCHUP_NOT_VOTABLE",
        message: "Voting isn't open for this matchup.",
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("returns 409 MATCHUP_NOT_VOTABLE for an already-COMPLETED matchup", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup({ status: "COMPLETED" }));

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "MATCHUP_NOT_VOTABLE",
      });
    });

    it("accepts a vote on a TIE_BREAKER matchup", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup({ status: "TIE_BREAKER" }));
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-a",
        alreadyVoted: false,
      });
      expect(voteCreate).toHaveBeenCalled();
    });
  });

  describe("§4.7 step 5: voter identity resolution", () => {
    it("returns 401 SIGN_IN_REQUIRED for an ACCOUNT_REQUIRED bracket when the caller isn't signed in, and never touches Vote", async () => {
      matchupFindUnique.mockResolvedValue(
        activeMatchup({
          round: {
            ...activeMatchup().round,
            bracket: { id: "bracket-1", votingRequirement: "ACCOUNT_REQUIRED" },
          },
        })
      );

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        code: "SIGN_IN_REQUIRED",
        message: "Sign in to vote on this bracket.",
      });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("records a signed-in voter's Vote.userId from the bearer token, never touching the anonymous cookie", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(voteCreate).toHaveBeenCalledWith({
        data: {
          matchupId: "matchup-1",
          itemId: "item-a",
          userId: "profile-1",
          anonymousVoterIdentifier: null,
          comment: null,
          phase: "ORIGINAL",
        },
      });
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-a",
        alreadyVoted: false,
      });
    });

    it("mints and sets a new, signed anonymous cookie when ANONYMOUS_ALLOWED and no cookie exists yet, with the §6-decided attributes", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({ itemId: "item-a" });

      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain(
        `voter_id=${signAnonymousVoterId("generated-anon-id")}`
      );
      expect(setCookie).toContain(`Domain=${VOTER_COOKIE_DOMAIN}`);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toContain("Path=/");

      expect(voteCreate).toHaveBeenCalledWith({
        data: {
          matchupId: "matchup-1",
          itemId: "item-a",
          userId: null,
          anonymousVoterIdentifier: "generated-anon-id",
          comment: null,
          phase: "ORIGINAL",
        },
      });
    });

    it("reuses an existing, validly signed anonymous cookie instead of minting a new one", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        cookie: `voter_id=${signAnonymousVoterId("existing-anon-id")}`,
      });

      expect(response.headers.get("set-cookie")).toBeNull();
      expect(voteCreate).toHaveBeenCalledWith({
        data: {
          matchupId: "matchup-1",
          itemId: "item-a",
          userId: null,
          anonymousVoterIdentifier: "existing-anon-id",
          comment: null,
          phase: "ORIGINAL",
        },
      });
    });

    it("mints a fresh identifier when the cookie's signature doesn't match (hand-edited/tampered)", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        cookie:
          "voter_id=attacker-chosen-id.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

      expect(response.headers.get("set-cookie")).toContain(
        `voter_id=${signAnonymousVoterId("generated-anon-id")}`
      );
      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            anonymousVoterIdentifier: "generated-anon-id",
          }),
        })
      );
    });

    it("mints a fresh identifier for a pre-#35 unsigned cookie (no signature suffix)", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        cookie: "voter_id=old-unsigned-uuid",
      });

      expect(response.headers.get("set-cookie")).not.toBeNull();
      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            anonymousVoterIdentifier: "generated-anon-id",
          }),
        })
      );
    });

    it("derives phase TIE_BREAKER for a TIE_BREAKER matchup, scoping the lookup/insert by it", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup({ status: "TIE_BREAKER" }));
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteCreate.mockResolvedValue({ id: "vote-2", itemId: "item-a" });

      await callPost({ itemId: "item-a", authorization: "Bearer valid-token" });

      expect(voteFindFirst).toHaveBeenCalledWith({
        where: { matchupId: "matchup-1", phase: "TIE_BREAKER", userId: "profile-1" },
      });
      expect(voteCreate).toHaveBeenCalledWith({
        data: {
          matchupId: "matchup-1",
          itemId: "item-a",
          userId: "profile-1",
          anonymousVoterIdentifier: null,
          comment: null,
          phase: "TIE_BREAKER",
        },
      });
    });
  });

  describe("§4.7 step 6: existing-vote short-circuit", () => {
    it("proactively finds an existing vote and returns it with alreadyVoted: true, without inserting", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteFindFirst.mockResolvedValue({ id: "vote-existing", itemId: "item-b" });

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-b",
        alreadyVoted: true,
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("recovers from a P2002 unique-constraint violation (a race the proactive check missed) by returning the winning row's choice, not an error", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteFindFirst
        .mockResolvedValueOnce(null) // proactive check: nothing yet
        .mockResolvedValueOnce({ id: "vote-race-winner", itemId: "item-b" }); // after the race
      voteCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        })
      );

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-b",
        alreadyVoted: true,
      });
      expect(voteFindFirst).toHaveBeenNthCalledWith(2, {
        where: { matchupId: "matchup-1", phase: "ORIGINAL", userId: "profile-1" },
      });
    });

    it("returns a 500 UNEXPECTED for a non-P2002 error from the insert, instead of leaking it", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteCreate.mockRejectedValue(new Error("connection reset"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        code: "UNEXPECTED",
        message: "Something went wrong. Please try again.",
      });

      consoleError.mockRestore();
    });
  });

  describe("§4.7 step 7: rate limiting", () => {
    it("returns 429 RATE_LIMITED once the identifier has hit the cap of recent votes, without inserting", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteCount.mockResolvedValue(VOTE_RATE_LIMIT_MAX_VOTES);

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        code: "RATE_LIMITED",
        message: RATE_LIMIT_ERROR,
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("allows a vote when the identifier is still under the cap", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteCount.mockResolvedValue(VOTE_RATE_LIMIT_MAX_VOTES - 1);
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(200);
      expect(voteCreate).toHaveBeenCalled();
    });

    it("never even checks the rate limit when the voter already has a vote on this matchup", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteFindFirst.mockResolvedValue({ id: "vote-existing", itemId: "item-b" });

      await callPost({ itemId: "item-a", authorization: "Bearer valid-token" });

      expect(voteCount).not.toHaveBeenCalled();
    });

    it("still sets the freshly-minted anonymous cookie on a 429 RATE_LIMITED response", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCount.mockResolvedValue(VOTE_RATE_LIMIT_MAX_VOTES);

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(429);
      expect(response.headers.get("set-cookie")).toContain(
        `voter_id=${signAnonymousVoterId("generated-anon-id")}`
      );
    });
  });

  describe("§4.7 step 8: comment validation", () => {
    it("saves a trimmed comment on the new Vote row", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        comment: "  Great choice!  ",
      });

      expect(response.status).toBe(200);
      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ comment: "Great choice!" }),
        })
      );
    });

    it("saves comment = null when the comment field is empty", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      await callPost({ itemId: "item-a", comment: "" });

      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ comment: null }) })
      );
    });

    it("saves comment = null when the comment field is whitespace-only", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      await callPost({ itemId: "item-a", comment: "   \n\t  " });

      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ comment: null }) })
      );
    });

    it("saves comment = null when no comment field is present at all", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      await callPost({
        rawBody: JSON.stringify({ itemId: "item-a" }),
      });

      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ comment: null }) })
      );
    });

    it("accepts a comment exactly at MAX_COMMENT_LENGTH", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });
      const exactLengthComment = "a".repeat(MAX_COMMENT_LENGTH);

      const response = await callPost({
        itemId: "item-a",
        comment: exactLengthComment,
      });

      expect(response.status).toBe(200);
      expect(voteCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ comment: exactLengthComment }),
        })
      );
    });

    it("returns 400 COMMENT_TOO_LONG for a comment over MAX_COMMENT_LENGTH, without creating a Vote", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      const tooLongComment = "a".repeat(MAX_COMMENT_LENGTH + 1);

      const response = await callPost({
        itemId: "item-a",
        comment: tooLongComment,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "COMMENT_TOO_LONG",
        message: COMMENT_TOO_LONG_ERROR,
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("does not let an over-length comment override the existing-vote short circuit", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      getAuthenticatedUserId.mockResolvedValue("profile-1");
      voteFindFirst.mockResolvedValue({ id: "vote-existing", itemId: "item-b" });
      const tooLongComment = "a".repeat(MAX_COMMENT_LENGTH + 1);

      const response = await callPost({
        itemId: "item-a",
        comment: tooLongComment,
        authorization: "Bearer valid-token",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-b",
        alreadyVoted: true,
      });
      expect(voteCreate).not.toHaveBeenCalled();
    });

    it("still sets the freshly-minted anonymous cookie on a 400 COMMENT_TOO_LONG response", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      const tooLongComment = "a".repeat(MAX_COMMENT_LENGTH + 1);

      const response = await callPost({ itemId: "item-a", comment: tooLongComment });

      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toContain(
        `voter_id=${signAnonymousVoterId("generated-anon-id")}`
      );
    });
  });

  describe("§4.7 step 9: response shape", () => {
    it("returns the openapi CastVoteResponse shape on a genuinely new vote", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({ itemId: "item-a" });

      await expect(response.json()).resolves.toEqual({
        votedItemId: "item-a",
        alreadyVoted: false,
      });
    });
  });

  describe("CORS", () => {
    it("applies the allowed-origin CORS headers on a success response", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({ itemId: "item-a" });

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        ALLOWED_ORIGIN
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true"
      );
    });

    it("applies CORS headers on every error response too", async () => {
      matchupFindUnique.mockResolvedValue(null);

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(404);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        ALLOWED_ORIGIN
      );
    });

    it("applies CORS headers on the generic 500 fallback too", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockRejectedValue(new Error("boom"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await callPost({ itemId: "item-a" });

      expect(response.status).toBe(500);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        ALLOWED_ORIGIN
      );

      consoleError.mockRestore();
    });

    it("omits Access-Control-Allow-Origin for a non-matching origin", async () => {
      matchupFindUnique.mockResolvedValue(activeMatchup());
      voteCreate.mockResolvedValue({ id: "vote-1", itemId: "item-a" });

      const response = await callPost({
        itemId: "item-a",
        origin: "https://evil.example.com",
      });

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("OPTIONS returns the CORS preflight response", async () => {
      const response = await OPTIONS(makeRequest());

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        ALLOWED_ORIGIN
      );
    });
  });
});
