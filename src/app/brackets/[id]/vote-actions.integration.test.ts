import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signAnonymousVoterId, verifyAnonymousVoterId } from "./voter-identity";

// Exercises issue #22's `castVote` Server Action end-to-end against the
// real, disposable Supabase/Postgres project configured in `.env.local`:
// seeds a real `Profile` + `Bracket` (+ `BracketItem`/`Round`/`Matchup`)
// tree, calls the real (unmocked) action, asserts the resulting `Vote`
// row(s), then cleans everything up. Same disposable-test-data pattern as
// `../../dashboard/brackets/[id]/edit/publish-actions.integration.test.ts`
// - see that file for the fuller rationale.
//
// This suite in particular is what proves the schema's
// `@@unique([matchupId, userId])` / `@@unique([matchupId,
// anonymousVoterIdentifier])` constraints (issue #3) are the real guard
// against a duplicate vote, not just the action's own proactive check -
// mocked-Prisma tests (./vote-actions.test.ts) can only simulate a P2002
// throw; this one gets the genuine one from Postgres.
let currentUserId: string | undefined;

function formDataWithComment(comment: string): FormData {
  const formData = new FormData();
  formData.set("comment", comment);
  return formData;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: currentUserId ? { id: currentUserId } : null },
        error: null,
      })),
    },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// A minimal in-memory cookie jar, standing in for the real request-scoped
// one `next/headers`'s `cookies()` provides - good enough to prove
// "reuses an existing identifier" / "mints one when absent" within a
// single test, the same reasoning as
// `../../../lib/supabase/get-user.signed-out.test.ts`'s stub.
let cookieJar: Map<string, string>;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
  })),
}));

// See ../../dashboard/dashboard-query.integration.test.ts for why
// DATABASE_URL needs re-reading directly from .env.local rather than
// trusting Vite's (`$`-mangled) copy of it, and why this must happen before
// `@/lib/prisma` is ever imported.
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

describe.runIf(hasLiveDatabase)(
  "castVote Server Action, against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let castVote: typeof import("./vote-actions").castVote;
    let initialVoteFormState: typeof import("./vote-actions").initialVoteFormState;

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
    let revoteMatchupId: string;
    let revoteItemAId: string;
    let revoteItemBId: string;
    let rateLimitMatchupIds: string[];
    let rateLimitItemAId: string;
    let rateLimitExtraMatchupId: string;
    let commentMatchupId: string;
    let commentItemAId: string;
    let noCommentMatchupId: string;
    let noCommentItemAId: string;
    let tooLongCommentMatchupId: string;
    let tooLongCommentItemAId: string;

    let RATE_LIMIT_ERROR: typeof import("./vote-actions").RATE_LIMIT_ERROR;
    let VOTE_RATE_LIMIT_MAX_VOTES: typeof import("./vote-actions").VOTE_RATE_LIMIT_MAX_VOTES;
    let MAX_COMMENT_LENGTH: typeof import("./vote-actions").MAX_COMMENT_LENGTH;
    let COMMENT_TOO_LONG_ERROR: typeof import("./vote-actions").COMMENT_TOO_LONG_ERROR;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({
        castVote,
        initialVoteFormState,
        RATE_LIMIT_ERROR,
        VOTE_RATE_LIMIT_MAX_VOTES,
        MAX_COMMENT_LENGTH,
        COMMENT_TOO_LONG_ERROR,
      } = await import("./vote-actions"));

      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `vote-e2e-creator-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: voterProfileId,
            email: `vote-e2e-voter-${Date.now()}-${Math.random()
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

      // Bracket 1: ANONYMOUS_ALLOWED, one ACTIVE round with an ACTIVE
      // matchup, and a second, already-COMPLETED round with a matchup
      // whose round has closed.
      const anonymousBracketId = await makeBracket(
        "Vote e2e - anonymous allowed",
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

      // Issue #41: a dedicated matchup for proving a real revote across
      // phases - separate items/matchup from duplicateTestMatchup above so
      // its own (matchupId, phase, identity) unique constraint never
      // collides with that suite's ORIGINAL-phase duplicate test.
      const revoteItems = await makeItems(anonymousBracketId, 2);
      const revoteMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: revoteItems[0].id,
          itemBId: revoteItems[1].id,
          status: "ACTIVE",
        },
      });
      revoteMatchupId = revoteMatchup.id;
      revoteItemAId = revoteItems[0].id;
      revoteItemBId = revoteItems[1].id;

      // Bracket 1b: ANONYMOUS_ALLOWED, three more items/matchups dedicated
      // to issue #23's comment tests, kept separate from the matchups above
      // so a comment-test vote never collides with another test's unique
      // (matchupId, identity) constraint.
      const commentItems = await makeItems(anonymousBracketId, 6);
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

      const noCommentMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: commentItems[2].id,
          itemBId: commentItems[3].id,
          status: "ACTIVE",
        },
      });
      noCommentMatchupId = noCommentMatchup.id;
      noCommentItemAId = commentItems[2].id;

      const tooLongCommentMatchup = await prisma.matchup.create({
        data: {
          roundId: activeRound.id,
          itemAId: commentItems[4].id,
          itemBId: commentItems[5].id,
          status: "ACTIVE",
        },
      });
      tooLongCommentMatchupId = tooLongCommentMatchup.id;
      tooLongCommentItemAId = commentItems[4].id;

      // Bracket 2: ACCOUNT_REQUIRED, one ACTIVE matchup.
      const accountRequiredBracketId = await makeBracket(
        "Vote e2e - account required",
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

      // Bracket 3: ANONYMOUS_ALLOWED, `VOTE_RATE_LIMIT_MAX_VOTES` distinct
      // ACTIVE matchups sharing one item pair (nothing stops multiple
      // Matchups from referencing the same BracketItems), plus one extra
      // matchup - enough to seed exactly-at-the-cap real `Vote` rows and
      // then prove issue #35's `prisma.vote.count` rate limit rejects the
      // next one, against genuine Postgres counting rather than a mock.
      const rateLimitBracketId = await makeBracket(
        "Vote e2e - rate limit",
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
      cookieJar = new Map();
    });

    afterAll(async () => {
      // Delete children before parents (`onDelete: Restrict` throughout the
      // schema) so this suite never leaves test data behind in the one
      // live database this project has.
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

      const result = await castVote(
        activeMatchupId,
        activeMatchupItemAId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null, votedItemId: activeMatchupItemAId });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: activeMatchupId, userId: voterProfileId },
      });
      expect(vote).not.toBeNull();
      expect(vote?.itemId).toBe(activeMatchupItemAId);
      expect(vote?.anonymousVoterIdentifier).toBeNull();
    });

    it("gives an anonymous voter on an ANONYMOUS_ALLOWED bracket a cookie identifier and records it on the Vote", async () => {
      const result = await castVote(
        activeMatchupId,
        activeMatchupItemBId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null, votedItemId: activeMatchupItemBId });
      const signedCookieValue = cookieJar.get("voter_id");
      expect(signedCookieValue).toBeDefined();

      // The cookie stores the *signed* value (issue #35) - `Vote.
      // anonymousVoterIdentifier` stores the raw id, so verify the cookie
      // to recover it, the same way `castVote`/`currentVoterLookupKey` do.
      const rawIdentifier = verifyAnonymousVoterId(signedCookieValue!);
      expect(rawIdentifier).not.toBeNull();

      const vote = await prisma.vote.findFirst({
        where: {
          matchupId: activeMatchupId,
          anonymousVoterIdentifier: rawIdentifier,
        },
      });
      expect(vote).not.toBeNull();
      expect(vote?.itemId).toBe(activeMatchupItemBId);
      expect(vote?.userId).toBeNull();
    });

    it("blocks an anonymous visitor on an ACCOUNT_REQUIRED bracket with a sign-in message, and creates no Vote", async () => {
      const result = await castVote(
        accountRequiredMatchupId,
        accountRequiredItemAId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({
        error: "Sign in to vote on this bracket.",
        votedItemId: null,
      });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: accountRequiredMatchupId },
      });
      expect(vote).toBeNull();
    });

    it("rejects a duplicate vote from the same signed-in identity and reports the existing choice, relying on the real unique constraint", async () => {
      currentUserId = voterProfileId;

      const original = await castVote(
        duplicateTestMatchupId,
        duplicateTestItemAId,
        initialVoteFormState,
        new FormData()
      );
      expect(original).toEqual({
        error: null,
        votedItemId: duplicateTestItemAId,
      });

      const secondAttempt = await castVote(
        duplicateTestMatchupId,
        duplicateTestItemBId,
        initialVoteFormState,
        new FormData()
      );

      // Rejected as a duplicate - and reports the *original* choice, not
      // the second item just attempted, proving the real unique constraint
      // (not just the proactive check) is what's enforcing this.
      expect(secondAttempt).toEqual({
        error: null,
        votedItemId: duplicateTestItemAId,
      });

      const votes = await prisma.vote.findMany({
        where: { matchupId: duplicateTestMatchupId, userId: voterProfileId },
      });
      expect(votes).toHaveLength(1);
      expect(votes[0].itemId).toBe(duplicateTestItemAId);
    });

    it("issue #41: lets an original-round voter cast an independent second vote once the matchup moves to TIE_BREAKER, keeps the original Vote row (with its comment) intact, and rejects a third attempt in the same TIE_BREAKER phase as a duplicate - against the real unique constraint, not just the proactive check", async () => {
      currentUserId = voterProfileId;

      const originalVote = await castVote(
        revoteMatchupId,
        revoteItemAId,
        initialVoteFormState,
        formDataWithComment("original round pick")
      );
      expect(originalVote).toEqual({ error: null, votedItemId: revoteItemAId });

      // Moves the matchup into TIE_BREAKER directly - entering a
      // tie-breaker is evaluateRound's job (issue #20/#29), not castVote's,
      // so this simulates it the same way this suite treats every other
      // fixture status.
      await prisma.matchup.update({
        where: { id: revoteMatchupId },
        data: {
          status: "TIE_BREAKER",
          tieBreakerEndsAt: new Date(Date.now() + 60 * 60_000),
        },
      });

      const tieBreakerVote = await castVote(
        revoteMatchupId,
        revoteItemBId,
        initialVoteFormState,
        new FormData()
      );
      expect(tieBreakerVote).toEqual({ error: null, votedItemId: revoteItemBId });

      // A third attempt, still within the TIE_BREAKER phase, is rejected as
      // a duplicate and reports the tie-breaker choice just cast - not a
      // third row, and not the original-round choice either.
      const repeatTieBreakerAttempt = await castVote(
        revoteMatchupId,
        revoteItemAId,
        initialVoteFormState,
        new FormData()
      );
      expect(repeatTieBreakerAttempt).toEqual({
        error: null,
        votedItemId: revoteItemBId,
      });

      const votes = await prisma.vote.findMany({
        where: { matchupId: revoteMatchupId, userId: voterProfileId },
      });
      expect(votes).toHaveLength(2);
      const originalRow = votes.find((vote) => vote.phase === "ORIGINAL");
      const tieBreakerRow = votes.find((vote) => vote.phase === "TIE_BREAKER");
      expect(originalRow?.itemId).toBe(revoteItemAId);
      expect(originalRow?.comment).toBe("original round pick");
      expect(tieBreakerRow?.itemId).toBe(revoteItemBId);
    });

    it("rejects a vote on a matchup whose round has already closed", async () => {
      const result = await castVote(
        closedRoundMatchupId,
        closedRoundItemAId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({
        error: "Voting has closed for this round.",
        votedItemId: null,
      });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: closedRoundMatchupId },
      });
      expect(vote).toBeNull();
    });

    it("accepts a vote on a TIE_BREAKER matchup", async () => {
      const result = await castVote(
        tieBreakerMatchupId,
        tieBreakerItemAId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: null, votedItemId: tieBreakerItemAId });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: tieBreakerMatchupId },
      });
      expect(vote).not.toBeNull();
    });

    it("rejects a vote once an anonymous identifier already has VOTE_RATE_LIMIT_MAX_VOTES recent Votes, against real Postgres counting (issue #35)", async () => {
      const anonymousVoterIdentifier = randomUUID();
      const signedCookieValue = signAnonymousVoterId(anonymousVoterIdentifier);

      // Seed exactly-at-the-cap real Vote rows for this identifier, one per
      // distinct rate-limit matchup - proves the rejection below comes from
      // `prisma.vote.count`'s real rolling-window query, not a mock.
      await prisma.vote.createMany({
        data: rateLimitMatchupIds.map((matchupId) => ({
          matchupId,
          itemId: rateLimitItemAId,
          anonymousVoterIdentifier,
        })),
      });

      // Simulate the voter already holding a validly signed cookie for
      // this identifier (as `castVote` would have set on an earlier vote).
      cookieJar.set("voter_id", signedCookieValue);

      const result = await castVote(
        rateLimitExtraMatchupId,
        rateLimitItemAId,
        initialVoteFormState,
        new FormData()
      );

      expect(result).toEqual({ error: RATE_LIMIT_ERROR, votedItemId: null });

      const vote = await prisma.vote.findFirst({
        where: { matchupId: rateLimitExtraMatchupId },
      });
      expect(vote).toBeNull();
    });

    describe("optional comment (issue #23)", () => {
      it("saves a comment on the Vote row when one is provided", async () => {
        const result = await castVote(
          commentMatchupId,
          commentItemAId,
          initialVoteFormState,
          formDataWithComment("Loved this one!")
        );

        expect(result).toEqual({ error: null, votedItemId: commentItemAId });

        const vote = await prisma.vote.findFirst({
          where: { matchupId: commentMatchupId },
        });
        expect(vote?.comment).toBe("Loved this one!");
      });

      it("saves comment = null when no comment is given - a comment is never required", async () => {
        const result = await castVote(
          noCommentMatchupId,
          noCommentItemAId,
          initialVoteFormState,
          new FormData()
        );

        expect(result).toEqual({ error: null, votedItemId: noCommentItemAId });

        const vote = await prisma.vote.findFirst({
          where: { matchupId: noCommentMatchupId },
        });
        expect(vote?.comment).toBeNull();
      });

      it("rejects a comment over MAX_COMMENT_LENGTH and creates no Vote at all", async () => {
        const tooLongComment = "a".repeat(MAX_COMMENT_LENGTH + 1);

        const result = await castVote(
          tooLongCommentMatchupId,
          tooLongCommentItemAId,
          initialVoteFormState,
          formDataWithComment(tooLongComment)
        );

        expect(result).toEqual({
          error: COMMENT_TOO_LONG_ERROR,
          votedItemId: null,
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
  // No live database configured (e.g. CI, or a fresh checkout with no
  // `.env.local`) - explain the skip instead of silently doing nothing,
  // same reasoning as the skip note in
  // ../../dashboard/dashboard-query.integration.test.ts.
  describe("castVote Server Action, against the live database", () => {
    console.warn(
      "[vote-actions.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
