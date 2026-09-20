"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { isVotableMatchupStatus } from "./voting-view-model";
import {
  ANONYMOUS_VOTER_COOKIE,
  ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
  type VoterLookupKey,
} from "./voter-identity";

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

export const initialVoteFormState: VoteFormState = {
  error: null,
  votedItemId: null,
};

export const SIGN_IN_TO_VOTE_ERROR = "Sign in to vote on this bracket.";
export const ROUND_CLOSED_ERROR = "Voting has closed for this round.";
export const MATCHUP_NOT_VOTABLE_ERROR =
  "Voting isn't open for this matchup.";
export const INVALID_ITEM_ERROR = "That's not a valid choice for this matchup.";
export const MATCHUP_NOT_FOUND_ERROR = "This matchup no longer exists.";

export async function castVote(
  matchupId: string,
  itemId: string,
  _prevState: VoteFormState,
  _formData: FormData
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
    let anonymousVoterIdentifier = cookieStore.get(
      ANONYMOUS_VOTER_COOKIE
    )?.value;
    if (!anonymousVoterIdentifier) {
      anonymousVoterIdentifier = randomUUID();
      cookieStore.set(ANONYMOUS_VOTER_COOKIE, anonymousVoterIdentifier, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
        path: "/",
      });
    }
    voterKey = { anonymousVoterIdentifier };
  }

  // Proactive check (issue #22: "also proactively check for an existing
  // vote before attempting the insert where practical"). Not the source of
  // truth on its own - two near-simultaneous requests from the same
  // identity could both pass this - see the P2002 catch below for the real
  // guard.
  const existingVote = await prisma.vote.findFirst({
    where: { matchupId, ...voterKey },
  });
  if (existingVote) {
    return { error: null, votedItemId: existingVote.itemId };
  }

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
        where: { matchupId, ...voterKey },
      });
      revalidatePath(`/brackets/${matchup.round.bracketId}`);
      revalidatePath(`/brackets/${matchup.round.bracketId}/matchups/${matchupId}`);
      return { error: null, votedItemId: existingAfterRace?.itemId ?? null };
    }
    throw err;
  }
}
