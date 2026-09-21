import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises issue #56's POST /api/matchups/[matchupId]/votes Route Handler
// end-to-end against the real, disposable Supabase/Postgres project
// configured in `.env.local` - same disposable-test-data pattern as
// ../../../../brackets/[id]/vote-actions.integration.test.ts (this
// endpoint's Server Action sibling), ported to HTTP request/response
// instead of a Server Action call. This suite is what proves the schema's
// `@@unique([matchupId, userId, phase])` /
// `@@unique([matchupId, anonymousVoterIdentifier, phase])` constraints are
// the real guard against a duplicate vote, and that the rate limit is
// counted against genuine Postgres rows - not just what
// `route.test.ts`'s mocked-Prisma suite can simulate.
//
// `getAuthenticatedUserId` (../../../../lib/api/auth.ts) is mocked the same
// way the Server Action suite mocks `@/lib/supabase/server`'s `getUser` -
// this endpoint's identity boundary is "does a bearer token verify", which
// isn't itself under test here; only what happens once an identity (real
// userId or real anonymous cookie) is in hand is.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", () => ({
  getAuthenticatedUserId: vi.fn(async () => currentUserId ?? null),
}));

function fixDatabaseUrlFromEnvFile(): string | undefined {
  delete process.env.DATABASE_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DATABASE_URL left unset, same as prisma7.config.ts.
  }
  return process.env.DATABASE_URL;
}

const hasLiveDatabase = Boolean(fixDatabaseUrlFromEnvFile());

function requestFor(
  matchupId: string,
  body: { itemId: string; comment?: string },
  options: { authorization?: string; cookie?: string } = {}
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest(
    `http://localhost/api/matchups/${matchupId}/votes`,
    { method: "POST", headers, body: JSON.stringify(body) }
  );
}

function extractSetCookie(response: Response): string | null {
  return response.headers.get("set-cookie");
}

describe.runIf(hasLiveDatabase)(
  "POST /api/matchups/[matchupId]/votes, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let POST: typeof import("./route").POST;
    let verifyAnonymousVoterId: typeof import(
      "@/app/brackets/[id]/voter-identity"
    ).verifyAnonymousVoterId;
    let signAnonymousVoterId: typeof import(
      "@/app/brackets/[id]/voter-identity"
    ).signAnonymousVoterId;
    let VOTE_RATE_LIMIT_MAX_VOTES: typeof import(
      "@/app/brackets/[id]/vote-form-state"
    ).VOTE_RATE_LIMIT_MAX_VOTES;

    const creatorId = randomUUID();
    const voterProfileId = randomUUID();
    const bracketIds: string[] = [];
    const profileIds: string[] = [];

    let activeMatchupId: string;
    let activeMatchupItemAId: string;
    let activeMatchupItemBId: string;
    let accountRequiredMatchupId: string;
    let accountRequiredItemAId: string;
    let closedRoundMatchupId: string;
    let closedRoundItemAId: string;
    let tieBreakerMatchupId: string;
    let tieBreakerItemAId: string;
    let duplicateTestMatchupId: string;
    let duplicateTestItemAId: string;
    let duplicateTestItemBId: string;
    let rateLimitMatchupIds: string[];
    let rateLimitItemAId: string;
    let rateLimitExtraMatchupId: string;
    let commentMatchupId: string;
    let commentItemAId: string;
    let tooLongCommentMatchupId: string;
    let tooLongCommentItemAId: string;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ POST } = await import("./route"));
      ({ verifyAnonymousVoterId, signAnonymousVoterId } = await import(
        "@/app/brackets/[id]/voter-identity"
      ));
      ({ VOTE_RATE_LIMIT_MAX_VOTES } = await import(
        "@/app/brackets/[id]/vote-form-state"
      ));

      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `vote-api-e2e-creator-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: voterProfileId,
            email: `vote-api-e2e-voter-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
      profileIds.push(creatorId, voterProfileId);

      async function makeBracket(
        title: string,
        votingRequirement: "ANONYMOUS_ALLOWED" | "ACCOUNT_REQUIRED"
      ) {
        const bracket = await prisma.bracket.create({
          data: {
            creatorId,
            title,
            visibility: "PUBLIC",
            votingRequirement,
            defaultRoundDurationMinutes: 60,
            status: "ACTIVE",
            publishedAt: new Date(),
          },
        });
        bracketIds.push(bracket.id);
        return bracket.id;
      }

      async function makeItems(bracketId: string, count: number) {
        const items = [];
        for (let i = 0; i < count; i++) {
          items.push(
            await prisma.bracketItem.create({
              data: { bracketId, title: `Item ${i + 1}` },
            })
          );
        }
        return items;
      }

      const anonymousBracketId = await makeBracket(
        "Vote API e2e - anonymous allowed",
        "ANONYMOUS_ALLOWED"
      );
      const anonymousItems = await makeItems(anonymousBracketId, 8);

      const activeRound = await prisma.round.create({
        data: {
          bracketId: anonymousBracketId,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const activeMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: anonymousItems[0].id,
          itemBId: anonymousItems[1].id,
          status: "ACTIVE",
        },
      });
      activeMatchupId = activeMatchup.id;
      activeMatchupItemAId = anonymousItems[0].id;
      activeMatchupItemBId = anonymousItems[1].id;

      const tieBreakerMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: anonymousItems[2].id,
          itemBId: anonymousItems[3].id,
          status: "TIE_BREAKER",
          tieBreakerEndsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      tieBreakerMatchupId = tieBreakerMatchup.id;
      tieBreakerItemAId = anonymousItems[2].id;

      const closedRound = await prisma.round.create({
        data: {
          bracketId: anonymousBracketId,
          roundNumber: 2,
          durationMinutes: 60,
          status: "COMPLETED",
          startsAt: new Date(Date.now() - 2 * 60 * 60_000),
          endsAt: new Date(Date.now() - 60 * 60_000),
        },
      });
      const closedRoundMatchup = await prisma.matchup.create({
        data: {
          roundId: closedRound.id,
          itemAId: anonymousItems[4].id,
          itemBId: anonymousItems[5].id,
          status: "ACTIVE",
        },
      });
      closedRoundMatchupId = closedRoundMatchup.id;
      closedRoundItemAId = anonymousItems[4].id;

      const duplicateTestMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: anonymousItems[6].id,
          itemBId: anonymousItems[7].id,
          status: "ACTIVE",
        },
      });
      duplicateTestMatchupId = duplicateTestMatchup.id;
      duplicateTestItemAId = anonymousItems[6].id;
      duplicateTestItemBId = anonymousItems[7].id;

      const commentItems = await makeItems(anonymousBracketId, 4);
      const commentMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: commentItems[0].id,
          itemBId: commentItems[1].id,
          status: "ACTIVE",
        },
      });
      commentMatchupId = commentMatchup.id;
      commentItemAId = commentItems[0].id;

      const tooLongCommentMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: commentItems[2].id,
          itemBId: commentItems[3].id,
          status: "ACTIVE",
        },
      });
      tooLongCommentMatchupId = tooLongCommentMatchup.id;
      tooLongCommentItemAId = commentItems[2].id;

      const accountRequiredBracketId = await makeBracket(
        "Vote API e2e - account required",
        "ACCOUNT_REQUIRED"
      );
      const accountRequiredItems = await makeItems(accountRequiredBracketId, 2);
      const accountRequiredRound = await prisma.round.create({
        data: {
          bracketId: accountRequiredBracketId,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const accountRequiredMatchup = await prisma.matchup.create({
        data: {
          roundId: accountRequiredRound.id,
          itemAId: accountRequiredItems[0].id,
          itemBId: accountRequiredItems[1].id,
          status: "ACTIVE",
        },
      });
      accountRequiredMatchupId = accountRequiredMatchup.id;
      accountRequiredItemAId = accountRequiredItems[0].id;

      const rateLimitBracketId = await makeBracket(
        "Vote API e2e - rate limit",
        "ANONYMOUS_ALLOWED"
      );
      const rateLimitItems = await makeItems(rateLimitBracketId, 2);
      rateLimitItemAId = rateLimitItems[0].id;
      const rateLimitRound = await prisma.round.create({
        data: {
          bracketId: rateLimitBracketId,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      rateLimitMatchupIds = [];
      for (let i = 0; i < VOTE_RATE_LIMIT_MAX_VOTES; i++) {
        const matchup = await prisma.matchup.create({
          data: {
            roundId: rateLimitRound.id,
            itemAId: rateLimitItems[0].id,
            itemBId: rateLimitItems[1].id,
            status: "ACTIVE",
          },
        });
        rateLimitMatchupIds.push(matchup.id);
      }
      const rateLimitExtraMatchup = await prisma.matchup.create({
        data: {
          roundId: rateLimitRound.id,
          itemAId: rateLimitItems[0].id,
          itemBId: rateLimitItems[1].id,
          status: "ACTIVE",
        },
      });
      rateLimitExtraMatchupId = rateLimitExtraMatchup.id;
    });

    beforeEach(() => {
      currentUserId = undefined;
    });

    afterAll(async () => {
      await prisma.vote.deleteMany({
        where: { matchup: { round: { bracketId: { in: bracketIds } } } },
      });
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({ where: { bracketId: { in: bracketIds } } });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
      await prisma.$disconnect();
    });

    it("records a signed-in voter's Vote.userId as their Profile id", async () => {
      currentUserId = voterProfileId;

      const response = await POST(
        requestFor(
          activeMatchupId,
          { itemId: activeMatchupItemAId },
          { authorization: "Bearer whatever-verifies" }
        ),
        { params: Promise.resolve({ matchupId: activeMatchupId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: activeMatchupItemAId,
        alreadyVoted: false,
      });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: activeMatchupId, userId: voterProfileId },
      });
      expect(vote).not.toBeNull();
      expect(vote?.itemId).toBe(activeMatchupItemAId);
      expect(vote?.anonymousVoterIdentifier).toBeNull();
    });

    it("gives an anonymous voter a signed voter_id cookie with the §6-decided attributes and records it on the Vote", async () => {
      const response = await POST(
        requestFor(activeMatchupId, { itemId: activeMatchupItemBId }),
        { params: Promise.resolve({ matchupId: activeMatchupId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        votedItemId: activeMatchupItemBId,
        alreadyVoted: false,
      });

      const setCookie = extractSetCookie(response);
      expect(setCookie).not.toBeNull();
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);

      const signedValue = setCookie!.split(";")[0].split("=").slice(1).join("=");
      const rawIdentifier = verifyAnonymousVoterId(signedValue);
      expect(rawIdentifier).not.toBeNull();

      const vote = await prisma.vote.findFirst({
        where: { matchupId: activeMatchupId, anonymousVoterIdentifier: rawIdentifier },
      });
      expect(vote).not.toBeNull();
      expect(vote?.itemId).toBe(activeMatchupItemBId);
      expect(vote?.userId).toBeNull();
    });

    it("blocks an anonymous visitor on an ACCOUNT_REQUIRED bracket with 401 SIGN_IN_REQUIRED, and creates no Vote", async () => {
      const response = await POST(
        requestFor(accountRequiredMatchupId, { itemId: accountRequiredItemAId }),
        { params: Promise.resolve({ matchupId: accountRequiredMatchupId }) }
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        code: "SIGN_IN_REQUIRED",
        message: "Sign in to vote on this bracket.",
      });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: accountRequiredMatchupId },
      });
      expect(vote).toBeNull();
    });

    it("rejects a duplicate vote from the same signed-in identity and reports the existing choice, against the real unique constraint", async () => {
      currentUserId = voterProfileId;

      const original = await POST(
        requestFor(
          duplicateTestMatchupId,
          { itemId: duplicateTestItemAId },
          { authorization: "Bearer whatever-verifies" }
        ),
        { params: Promise.resolve({ matchupId: duplicateTestMatchupId }) }
      );
      await expect(original.json()).resolves.toEqual({
        votedItemId: duplicateTestItemAId,
        alreadyVoted: false,
      });

      const secondAttempt = await POST(
        requestFor(
          duplicateTestMatchupId,
          { itemId: duplicateTestItemBId },
          { authorization: "Bearer whatever-verifies" }
        ),
        { params: Promise.resolve({ matchupId: duplicateTestMatchupId }) }
      );

      expect(secondAttempt.status).toBe(200);
      await expect(secondAttempt.json()).resolves.toEqual({
        votedItemId: duplicateTestItemAId,
        alreadyVoted: true,
      });

      const votes = await prisma.vote.findMany({
        where: { matchupId: duplicateTestMatchupId, userId: voterProfileId },
      });
      expect(votes).toHaveLength(1);
      expect(votes[0].itemId).toBe(duplicateTestItemAId);
    });

    it("rejects a vote on a matchup whose round has already closed", async () => {
      const response = await POST(
        requestFor(closedRoundMatchupId, { itemId: closedRoundItemAId }),
        { params: Promise.resolve({ matchupId: closedRoundMatchupId }) }
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "ROUND_CLOSED",
        message: "Voting has closed for this round.",
      });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: closedRoundMatchupId },
      });
      expect(vote).toBeNull();
    });

    it("accepts a vote on a TIE_BREAKER matchup", async () => {
      const response = await POST(
        requestFor(tieBreakerMatchupId, { itemId: tieBreakerItemAId }),
        { params: Promise.resolve({ matchupId: tieBreakerMatchupId }) }
      );

      expect(response.status).toBe(200);
      const vote = await prisma.vote.findFirst({
        where: { matchupId: tieBreakerMatchupId },
      });
      expect(vote).not.toBeNull();
    });

    it("rejects a vote once an anonymous identifier already has VOTE_RATE_LIMIT_MAX_VOTES recent Votes, against real Postgres counting", async () => {
      const anonymousVoterIdentifier = randomUUID();
      const signedCookieValue = signAnonymousVoterId(anonymousVoterIdentifier);

      await prisma.vote.createMany({
        data: rateLimitMatchupIds.map((matchupId) => ({
          matchupId,
          itemId: rateLimitItemAId,
          anonymousVoterIdentifier,
        })),
      });

      const response = await POST(
        requestFor(
          rateLimitExtraMatchupId,
          { itemId: rateLimitItemAId },
          { cookie: `voter_id=${signedCookieValue}` }
        ),
        { params: Promise.resolve({ matchupId: rateLimitExtraMatchupId }) }
      );

      expect(response.status).toBe(429);
      const vote = await prisma.vote.findFirst({
        where: { matchupId: rateLimitExtraMatchupId },
      });
      expect(vote).toBeNull();
    });

    describe("optional comment", () => {
      it("saves a comment on the Vote row when one is provided", async () => {
        const response = await POST(
          requestFor(commentMatchupId, {
            itemId: commentItemAId,
            comment: "Loved this one!",
          }),
          { params: Promise.resolve({ matchupId: commentMatchupId }) }
        );

        expect(response.status).toBe(200);
        const vote = await prisma.vote.findFirst({
          where: { matchupId: commentMatchupId },
        });
        expect(vote?.comment).toBe("Loved this one!");
      });

      it("rejects a comment over MAX_COMMENT_LENGTH and creates no Vote at all", async () => {
        const tooLongComment = "a".repeat(501);

        const response = await POST(
          requestFor(tooLongCommentMatchupId, {
            itemId: tooLongCommentItemAId,
            comment: tooLongComment,
          }),
          { params: Promise.resolve({ matchupId: tooLongCommentMatchupId }) }
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code: "COMMENT_TOO_LONG",
        });

        const vote = await prisma.vote.findFirst({
          where: { matchupId: tooLongCommentMatchupId },
        });
        expect(vote).toBeNull();
      });
    });
  }
);

if (!hasLiveDatabase) {
  describe("POST /api/matchups/[matchupId]/votes, against the live database", () => {
    console.warn(
      "[route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
