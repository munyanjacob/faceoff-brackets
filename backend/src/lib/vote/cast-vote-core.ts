import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isVotableMatchupStatus } from "@/app/brackets/[id]/voting-view-model";
import {
  verifyAnonymousVoterId,
  type VoterLookupKey,
} from "@/app/brackets/[id]/voter-identity";
import {
  SIGN_IN_TO_VOTE_ERROR,
  ROUND_CLOSED_ERROR,
  MATCHUP_NOT_VOTABLE_ERROR,
  INVALID_ITEM_ERROR,
  MATCHUP_NOT_FOUND_ERROR,
  RATE_LIMIT_ERROR,
  MAX_COMMENT_LENGTH,
  COMMENT_TOO_LONG_ERROR,
  VOTE_RATE_LIMIT_WINDOW_MS,
  VOTE_RATE_LIMIT_MAX_VOTES,
} from "@/app/brackets/[id]/vote-form-state";

/**
 * The vote rule list (docs/frontend-rework-specification.md §4.7, issue
 * #22/#41/#35/#23) shared between `../../app/brackets/[id]/vote-actions.ts`'s
 * `castVote` Server Action and `../../app/api/matchups/[matchupId]/votes/
 * route.ts`'s REST route handler (issue #77) - previously the full 9-step
 * rule list was hand-copied between the two.
 *
 * This module takes/returns only plain data - never `FormData`/`Request`/
 * Next's `cookies()` - so both entry points can call it directly. Each
 * entry point still owns its own input parsing (`FormData` field vs. JSON
 * body field), its own voter-identity *source* (a cookie-bound Supabase
 * session vs. a bearer token, and reading the anonymous-voter cookie via
 * `next/headers` vs. `NextRequest.cookies`), and its own side effects
 * (`revalidatePath`, actually setting the anonymous-voter cookie with its
 * own attributes) - those genuinely differ per Next.js API/deployment
 * surface (a same-origin Server Action vs. a stateless cross-origin REST
 * API, spec §6) rather than being a business rule.
 *
 * Step numbering below matches the REST route's original doc-comment
 * (steps 1-9), kept as the canonical numbering for both entry points.
 */

export type VotePhase = "ORIGINAL" | "TIE_BREAKER";

export type VoteRuleError =
  | { code: "MATCHUP_NOT_FOUND"; message: string }
  | { code: "INVALID_ITEM"; message: string }
  | { code: "ROUND_CLOSED"; message: string }
  | { code: "MATCHUP_NOT_VOTABLE"; message: string }
  | { code: "SIGN_IN_REQUIRED"; message: string }
  | { code: "RATE_LIMITED"; message: string }
  | { code: "COMMENT_TOO_LONG"; message: string };

type StepResult<T> = { ok: true; value: T } | { ok: false; error: VoteRuleError };

function fetchMatchupWithContext(matchupId: string) {
  return prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { round: { include: { bracket: true } } },
  });
}

export type MatchupWithContext = NonNullable<
  Awaited<ReturnType<typeof fetchMatchupWithContext>>
>;

/**
 * Steps 1-4: matchup existence, item validity, round status, matchup
 * status - the "is this vote even attemptable" checks, independent of
 * voter identity or persistence.
 */
export async function validateMatchupAndItem(
  matchupId: string,
  itemId: string
): Promise<StepResult<{ matchup: MatchupWithContext; phase: VotePhase }>> {
  // 1. Matchup must exist.
  const matchup = await fetchMatchupWithContext(matchupId);
  if (!matchup) {
    return {
      ok: false,
      error: { code: "MATCHUP_NOT_FOUND", message: MATCHUP_NOT_FOUND_ERROR },
    };
  }

  // 2. itemId must be one of the matchup's two items.
  if (matchup.itemAId !== itemId && matchup.itemBId !== itemId) {
    return {
      ok: false,
      error: { code: "INVALID_ITEM", message: INVALID_ITEM_ERROR },
    };
  }

  // 3. The matchup's round must be ACTIVE (not PENDING/COMPLETED). A round
  // only ever leaves ACTIVE once every one of its matchups is COMPLETED - a
  // matchup that's still TIE_BREAKER keeps its round ACTIVE, so this and
  // the isVotableMatchupStatus check below never fight each other during a
  // tie-breaker window.
  if (matchup.round.status !== "ACTIVE") {
    return {
      ok: false,
      error: { code: "ROUND_CLOSED", message: ROUND_CLOSED_ERROR },
    };
  }

  // 4. The matchup itself must be votable (ACTIVE or TIE_BREAKER).
  if (!isVotableMatchupStatus(matchup.status)) {
    return {
      ok: false,
      error: { code: "MATCHUP_NOT_VOTABLE", message: MATCHUP_NOT_VOTABLE_ERROR },
    };
  }

  // Which VotePhase this vote belongs to (issue #41), derived from the
  // matchup's status at request time - never accepted from the caller.
  const phase: VotePhase = matchup.status === "TIE_BREAKER" ? "TIE_BREAKER" : "ORIGINAL";

  return { ok: true, value: { matchup, phase } };
}

export type ResolvedVoterIdentity = {
  voterKey: VoterLookupKey;
  /** Set only when this call minted a brand-new anonymous identity (no
   * valid signed cookie value was already present) - `null` for a
   * signed-in voter or a voter with an already-valid cookie. The caller
   * decides how/whether to persist this (a Server Action sets the cookie
   * immediately; a Route Handler sets it on whatever Response the request
   * ends up producing, success or a later rejection alike). */
  newAnonymousVoterId: string | null;
};

/**
 * Step 5: voter identity resolution - signed-in vs. `ACCOUNT_REQUIRED`
 * rejection vs. anonymous-cookie verify-or-mint. Takes the caller's
 * already-resolved `userId` (or `null`) and the raw anonymous-cookie value
 * (or `undefined`) - each entry point resolves those from its own identity
 * source (see this module's doc-comment) before calling this.
 */
export function resolveVoterIdentity(params: {
  userId: string | null;
  votingRequirement: string;
  rawAnonymousCookieValue: string | undefined;
}): StepResult<ResolvedVoterIdentity> {
  const { userId, votingRequirement, rawAnonymousCookieValue } = params;

  if (userId) {
    return { ok: true, value: { voterKey: { userId }, newAnonymousVoterId: null } };
  }

  if (votingRequirement === "ACCOUNT_REQUIRED") {
    return {
      ok: false,
      error: { code: "SIGN_IN_REQUIRED", message: SIGN_IN_TO_VOTE_ERROR },
    };
  }

  // Verifies the signature, not just reads the value - a missing cookie
  // *and* a present-but-tampered/invalid-signature one both fall through to
  // minting a fresh, freshly-signed id below - never a hard error.
  let anonymousVoterIdentifier = rawAnonymousCookieValue
    ? verifyAnonymousVoterId(rawAnonymousCookieValue)
    : null;
  let newAnonymousVoterId: string | null = null;
  if (!anonymousVoterIdentifier) {
    anonymousVoterIdentifier = randomUUID();
    newAnonymousVoterId = anonymousVoterIdentifier;
  }

  return {
    ok: true,
    value: { voterKey: { anonymousVoterIdentifier }, newAnonymousVoterId },
  };
}

/**
 * Step 6: existing-vote short-circuit - not an error: the caller responds
 * as if the vote succeeded, returning the existing choice. Not the sole
 * source of truth on its own (two near-simultaneous requests from the same
 * identity could both pass this) - see `insertVoteWithRaceRecovery`'s
 * P2002 catch for the real guard.
 */
export function findExistingVote(
  matchupId: string,
  phase: VotePhase,
  voterKey: VoterLookupKey
) {
  return prisma.vote.findFirst({ where: { matchupId, phase, ...voterKey } });
}

/**
 * Step 7: rate limit - only meant to be consulted once the caller knows
 * this would be a *new* Vote insert, so repeatedly re-submitting an
 * already-voted matchup never counts against it.
 */
export async function isRateLimited(voterKey: VoterLookupKey): Promise<boolean> {
  const recentVoteCount = await prisma.vote.count({
    where: {
      ...voterKey,
      createdAt: { gte: new Date(Date.now() - VOTE_RATE_LIMIT_WINDOW_MS) },
    },
  });
  return recentVoteCount >= VOTE_RATE_LIMIT_MAX_VOTES;
}

/**
 * Step 8: optional comment - trimmed; whitespace-only -> null; over 500
 * chars -> rejected (never silently truncated). Checked only once the
 * caller knows a Vote is actually about to be created, so a stale/oversized
 * comment never overrides the existing-vote short-circuit (step 6).
 */
export function validateComment(
  rawComment: string
): { ok: true; comment: string | null } | { ok: false } {
  const trimmedComment = rawComment.trim();
  if (trimmedComment.length > MAX_COMMENT_LENGTH) {
    return { ok: false };
  }
  return { ok: true, comment: trimmedComment.length > 0 ? trimmedComment : null };
}

/**
 * Step 9: insert the vote - race-safe via `prisma/schema.prisma`'s
 * `@@unique([matchupId, userId, phase])` /
 * `@@unique([matchupId, anonymousVoterIdentifier, phase])` constraints,
 * which reject the losing insert at the database level; recovered the same
 * way as the proactive check (`findExistingVote`) above (the voter's
 * existing choice, not an error), never surfacing the constraint violation
 * to the caller.
 *
 * `votedItemId` is `string | null` rather than always a `string`: on the
 * P2002 race-recovery path, `existingAfterRace` should always be found
 * (that's exactly why the insert above raced), but this is defensive
 * against the near-impossible case where it isn't. Deliberately left as
 * `null` here rather than this function picking a fallback itself - the
 * two entry points disagree on what to do with it (the REST route's
 * `CastVoteResponse` schema requires a non-null string, so it falls back to
 * the item just attempted; the Server Action's `VoteFormState` allows
 * `null` and keeps it) - so each caller applies its own policy.
 */
export async function insertVoteWithRaceRecovery(params: {
  matchupId: string;
  itemId: string;
  phase: VotePhase;
  voterKey: VoterLookupKey;
  comment: string | null;
}): Promise<{ votedItemId: string | null; alreadyVoted: boolean }> {
  const { matchupId, itemId, phase, voterKey, comment } = params;
  try {
    const created = await prisma.vote.create({
      data: {
        matchupId,
        itemId,
        userId: "userId" in voterKey ? voterKey.userId : null,
        anonymousVoterIdentifier:
          "anonymousVoterIdentifier" in voterKey
            ? voterKey.anonymousVoterIdentifier
            : null,
        comment,
        phase,
      },
    });
    return { votedItemId: created.itemId, alreadyVoted: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existingAfterRace = await prisma.vote.findFirst({
        where: { matchupId, phase, ...voterKey },
      });
      return {
        votedItemId: existingAfterRace?.itemId ?? null,
        alreadyVoted: true,
      };
    }
    throw err;
  }
}

export type CastVoteInput = {
  matchupId: string;
  itemId: string;
  /** Raw, untrimmed comment text - "" when no comment was supplied at all
   * (an absent `FormData` field / JSON body field alike). */
  comment: string;
  /** The caller's already-resolved signed-in user id, or `null`. */
  userId: string | null;
  /** The raw anonymous-voter cookie value, or `undefined` if absent. */
  rawAnonymousCookieValue: string | undefined;
};

export type CastVoteOutcome =
  | { kind: "error"; error: VoteRuleError }
  | {
      kind: "voted";
      /** `null` only on the P2002 race-recovery path's near-impossible
       * not-found case - see `insertVoteWithRaceRecovery`'s doc-comment for
       * why this module deliberately doesn't pick a fallback itself. */
      votedItemId: string | null;
      alreadyVoted: boolean;
      bracketId: string;
    };

export type CastVoteResult = {
  outcome: CastVoteOutcome;
  newAnonymousVoterId: string | null;
};

/**
 * The full ordered rule list (steps 1-9 above), composed into one entry
 * point both the Server Action and the REST route call. Every step is a
 * real, independent check against the database - never trusting that the
 * caller only ever reached this from a reachable vote button.
 */
export async function castVoteCore(input: CastVoteInput): Promise<CastVoteResult> {
  const validated = await validateMatchupAndItem(input.matchupId, input.itemId);
  if (!validated.ok) {
    return { outcome: { kind: "error", error: validated.error }, newAnonymousVoterId: null };
  }
  const { matchup, phase } = validated.value;

  const identity = resolveVoterIdentity({
    userId: input.userId,
    votingRequirement: matchup.round.bracket.votingRequirement,
    rawAnonymousCookieValue: input.rawAnonymousCookieValue,
  });
  if (!identity.ok) {
    return { outcome: { kind: "error", error: identity.error }, newAnonymousVoterId: null };
  }
  const { voterKey, newAnonymousVoterId } = identity.value;

  const existingVote = await findExistingVote(input.matchupId, phase, voterKey);
  if (existingVote) {
    return {
      outcome: {
        kind: "voted",
        votedItemId: existingVote.itemId,
        alreadyVoted: true,
        bracketId: matchup.round.bracketId,
      },
      newAnonymousVoterId,
    };
  }

  if (await isRateLimited(voterKey)) {
    return {
      outcome: { kind: "error", error: { code: "RATE_LIMITED", message: RATE_LIMIT_ERROR } },
      newAnonymousVoterId,
    };
  }

  const validatedComment = validateComment(input.comment);
  if (!validatedComment.ok) {
    return {
      outcome: {
        kind: "error",
        error: { code: "COMMENT_TOO_LONG", message: COMMENT_TOO_LONG_ERROR },
      },
      newAnonymousVoterId,
    };
  }

  const { votedItemId, alreadyVoted } = await insertVoteWithRaceRecovery({
    matchupId: input.matchupId,
    itemId: input.itemId,
    phase,
    voterKey,
    comment: validatedComment.comment,
  });

  return {
    outcome: { kind: "voted", votedItemId, alreadyVoted, bracketId: matchup.round.bracketId },
    newAnonymousVoterId,
  };
}
