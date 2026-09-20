"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { isVotableMatchupStatus } from "./voting-view-model";
import {
  ANONYMOUS_VOTER_COOKIE,
  ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
  signAnonymousVoterId,
  verifyAnonymousVoterId,
  type VoterLookupKey,
} from "./voter-identity";
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
  UNEXPECTED_ERROR,
} from "./vote-form-state";

/**
 * The "Vote" Server Action on `/brackets/[id]` (issue #22), invoked via
 * `useActionState` from `./vote-button.tsx` - one bound instance per
 * (matchup, item) pair, the same `Function.prototype.bind` pattern as
 * `../../dashboard/brackets/[id]/edit/item-row.tsx`'s
 * `updateItem.bind(null, bracketId, item.id)`.
 *
 * Every check below is a real, independent re-check against the database -
 * never trusting that `./page.tsx`/`./matchup-voting.tsx` only ever
 * rendered a reachable vote button (same "not just a hidden button"
 * reasoning as `../../dashboard/brackets/[id]/edit/publish-actions.ts`).
 *
 * `votedItemId` on the returned state is not just "did a new vote get
 * created" - it also covers "you already had a vote here" (found by the
 * proactive check, or recovered from a caught unique-constraint violation).
 * Both cases report the same non-error, "here's your existing choice"
 * result, matching issue #22's "the UI shows the voter's existing choice
 * rather than an unhelpful error" criterion.
 */
export type VoteFormState = {
  error: string | null;
  votedItemId: string | null;
};

export async function castVote(
  matchupId: string,
  itemId: string,
  _prevState: VoteFormState,
  formData: FormData
): Promise<VoteFormState> {
  try {
    return await castVoteUnsafe(matchupId, itemId, formData);
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR, votedItemId: null };
  }
}

async function castVoteUnsafe(
  matchupId: string,
  itemId: string,
  formData: FormData
): Promise<VoteFormState> {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { round: { include: { bracket: true } } },
  });

  if (!matchup) {
    return { error: MATCHUP_NOT_FOUND_ERROR, votedItemId: null };
  }

  if (matchup.itemAId !== itemId && matchup.itemBId !== itemId) {
    return { error: INVALID_ITEM_ERROR, votedItemId: null };
  }

  // A round only ever leaves ACTIVE once every one of its matchups is
  // COMPLETED (issue #20) - a matchup that's still TIE_BREAKER keeps its
  // round ACTIVE, so this and the isVotableMatchupStatus check below never
  // fight each other during a tie-breaker window (see that function's
  // comment in ./voting-view-model.ts for why TIE_BREAKER counts as
  // votable at all).
  if (matchup.round.status !== "ACTIVE") {
    return { error: ROUND_CLOSED_ERROR, votedItemId: null };
  }

  if (!isVotableMatchupStatus(matchup.status)) {
    return { error: MATCHUP_NOT_VOTABLE_ERROR, votedItemId: null };
  }

  // Issue #41: which VotePhase this vote belongs to, derived from the
  // matchup's status at request time - not stored/passed by the caller, so
  // a stale form submission can't lie about it. isVotableMatchupStatus
  // above already narrowed matchup.status to "ACTIVE" | "TIE_BREAKER", so
  // any non-TIE_BREAKER votable status maps to ORIGINAL. This makes a
  // voter's existing-vote lookup, insert, and P2002 race-recovery lookup
  // below all scoped per phase: a voter who already voted while the
  // matchup was ACTIVE gets a fresh, independent vote once it becomes
  // TIE_BREAKER, without weakening the one-vote-per-identity-per-phase
  // guarantee within either phase - see prisma/schema.prisma's
  // @@unique([matchupId, userId, phase]) / @@unique([matchupId,
  // anonymousVoterIdentifier, phase]).
  const phase = matchup.status === "TIE_BREAKER" ? "TIE_BREAKER" : "ORIGINAL";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let voterKey: VoterLookupKey;
  if (user) {
    voterKey = { userId: user.id };
  } else if (matchup.round.bracket.votingRequirement === "ACCOUNT_REQUIRED") {
    return { error: SIGN_IN_TO_VOTE_ERROR, votedItemId: null };
  } else {
    const cookieStore = await cookies();
    const rawCookieValue = cookieStore.get(ANONYMOUS_VOTER_COOKIE)?.value;
    // Verifies the signature (issue #35), not just reads the value - a
    // missing cookie *and* a present-but-tampered/invalid-signature one
    // both fall through to minting a fresh, freshly-signed id below. See
    // `verifyAnonymousVoterId`'s comment in `./voter-identity.ts` for why
    // that's the right behavior for a hand-edited or pre-#35 unsigned
    // cookie alike.
    let anonymousVoterIdentifier = rawCookieValue
      ? verifyAnonymousVoterId(rawCookieValue)
      : null;
    if (!anonymousVoterIdentifier) {
      anonymousVoterIdentifier = randomUUID();
      cookieStore.set(
        ANONYMOUS_VOTER_COOKIE,
        signAnonymousVoterId(anonymousVoterIdentifier),
        {
          httpOnly: true,
          sameSite: "lax",
          maxAge: ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
          path: "/",
        }
      );
    }
    voterKey = { anonymousVoterIdentifier };
  }

  // Proactive check (issue #22: "also proactively check for an existing
  // vote before attempting the insert where practical"). Not the source of
  // truth on its own - two near-simultaneous requests from the same
  // identity could both pass this - see the P2002 catch below for the real
  // guard.
  const existingVote = await prisma.vote.findFirst({
    where: { matchupId, phase, ...voterKey },
  });
  if (existingVote) {
    return { error: null, votedItemId: existingVote.itemId };
  }

  // Rate limit (issue #35) - only reached once we know this would be a
  // *new* Vote insert, so repeatedly re-submitting an already-voted
  // matchup (short-circuited above) never counts against it.
  const recentVoteCount = await prisma.vote.count({
    where: {
      ...voterKey,
      createdAt: { gte: new Date(Date.now() - VOTE_RATE_LIMIT_WINDOW_MS) },
    },
  });
  if (recentVoteCount >= VOTE_RATE_LIMIT_MAX_VOTES) {
    return { error: RATE_LIMIT_ERROR, votedItemId: null };
  }

  // Issue #23's optional comment. Checked here, not earlier alongside the
  // matchup/round/item checks above: those are all "is this vote even
  // attemptable" checks against data already in hand, independent of
  // whether a Vote is actually about to be created - a comment, by
  // contrast, is only ever relevant right before the insert it would land
  // on. In particular, this means a stale or oversized comment value never
  // overrides the existing-vote short-circuit above: resubmitting an
  // already-voted matchup (e.g. a duplicate click) keeps returning that
  // existing choice regardless of what's currently in the comment field.
  //
  // `formData.get(...)` returns `null` when the field is absent entirely
  // (a non-JS form submission that never included it, or a test harness's
  // bare `new FormData()`) - treated the same as an empty string. Trimmed
  // before both the length check and the null-vs-string decision, so
  // whitespace-only input (e.g. a few spaces) saves as `comment = null`
  // too, per the issue's "a comment is never required" criterion.
  const rawComment = formData.get("comment");
  const trimmedComment = typeof rawComment === "string" ? rawComment.trim() : "";
  if (trimmedComment.length > MAX_COMMENT_LENGTH) {
    return { error: COMMENT_TOO_LONG_ERROR, votedItemId: null };
  }
  const comment = trimmedComment.length > 0 ? trimmedComment : null;

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

    revalidatePath(`/brackets/${matchup.round.bracketId}`);
    revalidatePath(`/brackets/${matchup.round.bracketId}/matchups/${matchupId}`);
    return { error: null, votedItemId: created.itemId };
  } catch (err) {
    // The actual source of truth against the race the proactive check
    // above can't rule out: prisma/schema.prisma's
    // `@@unique([matchupId, userId])` / `@@unique([matchupId,
    // anonymousVoterIdentifier])` constraints reject the losing insert at
    // the database level. Recovered the same way as the proactive-check
    // path above - the voter's existing choice, not an error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existingAfterRace = await prisma.vote.findFirst({
        where: { matchupId, phase, ...voterKey },
      });
      revalidatePath(`/brackets/${matchup.round.bracketId}`);
      revalidatePath(`/brackets/${matchup.round.bracketId}/matchups/${matchupId}`);
      return { error: null, votedItemId: existingAfterRace?.itemId ?? null };
    }
    throw err;
  }
}
