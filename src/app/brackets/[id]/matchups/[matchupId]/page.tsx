import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { MatchupVoting } from "../../matchup-voting";
import {
  determineMatchupVotingState,
  determineVoterContext,
  type VoteCounts,
  type VoterContext,
} from "../../voting-view-model";
import { currentVoterLookupKey } from "../../voter-identity";

/**
 * `/brackets/[id]/matchups/[matchupId]` - the per-matchup voting page
 * (issue #40). Renders exactly the side-by-side single-matchup layout
 * issues #21/#22 built (both items, images/title/description, vote
 * buttons, the voter's existing choice once they've voted) - scoped to one
 * specific matchup named in the URL, instead of `/brackets/[id]`'s old
 * "whichever one `determineVotingState` picks" behavior. See
 * `../../voting-view-model.ts`'s top comment for the full issue #40
 * restructuring, and `../../page.tsx` for how a voter gets here (a redirect
 * for the common one-matchup case, or a link from the index for a round
 * with several matchups open at once).
 *
 * Every other concern is reused unchanged from `../../page.tsx`'s
 * pre-#40 version, just moved here wholesale rather than duplicated:
 *
 * - No auth *gate* of any kind (same reasoning as `../../../discover/
 *   page.tsx` and the pre-#40 `../../page.tsx`) - this route must be
 *   reachable by anyone, signed in or not, including anonymous voters.
 * - The read-only identity check (`createClient().auth.getUser()`) only
 *   computes `voterContext` for display - `../../vote-actions.ts`'s
 *   `castVote` Server Action re-derives and re-checks identity
 *   independently on every submit, so this page's `voterContext` is a
 *   display hint only, never the actual guard.
 * - `voterContext` (and its `Vote` lookup) is only ever computed when
 *   there's an actual matchup to vote on - skipped for the not-started/
 *   between-rounds/completed/not-found cases below, none of which need it.
 *
 * Issue #24's live results: once `voterContext.existingVoteItemId` comes
 * back non-null (this voter already voted here, whether just now or on an
 * earlier visit), this page also counts up current `Vote` rows for both of
 * the matchup's items (`prisma.vote.count`, one query per item) and passes
 * them down as `voteCounts` for `../../matchup-voting.tsx`'s `VoteControl`
 * to render. Deliberately gated behind the same `existingVoteItemId` check
 * that already decides "show their choice instead of a Vote button" -
 * matches the issue's "a voter who hasn't voted never sees vote counts"
 * criterion at the data layer (no query at all), not just by withholding it
 * from what's rendered. No caching to worry about: this is a plain Prisma
 * query, not a Next.js `fetch`/`"use cache"` call, so it always reads
 * current rows - freshness on a plain refresh comes for free, and
 * `../../vote-actions.ts`'s `revalidatePath` calls (unchanged by this
 * issue) are what make the *same* single round-trip that casts a vote also
 * re-run this query with the new vote already counted (see that file's and
 * `../../vote-button.tsx`'s comments on Next.js's single-response Server
 * Action model).
 *
 * Bracket-level unavailability (not started, completed, between rounds)
 * renders the same status message `../../page.tsx` shows for those cases -
 * reached directly by URL, this route has no way to know "am I the only
 * live matchup" is moot when there's no live round at all, so it just
 * falls back to the same bracket-level message rather than a confusing
 * 404. Only an actually-wrong matchup id (typo, already-decided matchup,
 * one that belongs to a different round/bracket) 404s via `notFound()` -
 * see `../../voting-view-model.ts`'s `determineMatchupVotingState`.
 *
 * Issue #25's countdown: computed here (as `countdownEndsAt`) and threaded
 * to `../../matchup-voting.tsx` the same way issue #24 threaded
 * `voteCounts` - only when `votingState.kind === "matchup"`, since that's
 * the only case with an actual `endsAt` worth counting down to.
 *
 * Which timestamp: a plain `ACTIVE` matchup counts down to the active
 * Round's own `endsAt` (already includes any issue #13 per-round duration
 * override - baked into `Round.durationMinutes`, and so into `endsAt`, at
 * creation time per #18/#20/#28; nothing here needs to recompute it). A
 * `TIE_BREAKER` matchup counts down to *its own* `tieBreakerEndsAt`
 * instead - deliberately not the Round's `endsAt`, which by that point has
 * already passed (that's *why* the matchup tied and moved to a
 * tie-breaker - see `evaluateRound`'s doc comment) and doesn't close the
 * Round while the tie-breaker is open (#20). Showing the stale, already-
 * expired Round `endsAt` during a tie-breaker would either read as
 * "closing" indefinitely (contradicting the still-open tie-breaker vote)
 * or, worse, look like a bug. `bracket.rounds` is queried with the same
 * unfiltered `include` as every other field here, so `Round.endsAt` and
 * `Matchup.tieBreakerEndsAt` are already present on the fetched rows - no
 * query change was needed for this (same reasoning as
 * `../../voting-view-model.ts`'s `scheduledStartAt` comment).
 */
export default async function BracketMatchupVotingPage({
  params,
}: PageProps<"/brackets/[id]/matchups/[matchupId]">) {
  const { id, matchupId } = await params;

  const bracket = await prisma.bracket.findUnique({
    where: { id },
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

  if (!bracket) {
    notFound();
  }

  const votingState = determineMatchupVotingState(bracket, bracket.rounds, matchupId);

  if (votingState.kind === "not-found") {
    notFound();
  }

  let voterContext: VoterContext = { kind: "eligible", existingVoteItemId: null };
  let voteCounts: VoteCounts | null = null;
  if (votingState.kind === "matchup") {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const lookupKey = await currentVoterLookupKey(user?.id ?? null);
    let existingVoteItemId: string | null = null;
    if (lookupKey) {
      const existingVote = await prisma.vote.findFirst({
        where: { matchupId: votingState.matchup.id, ...lookupKey },
      });
      existingVoteItemId = existingVote?.itemId ?? null;
    }

    voterContext = determineVoterContext(
      bracket.votingRequirement,
      Boolean(user),
      existingVoteItemId
    );

    // Issue #24: only ever fetched once we know the voter has already
    // voted here - see this file's top comment. `itemA`/`itemB` are
    // guaranteed non-null by `determineMatchupVotingState`'s own
    // `isVotableAndComplete` filter before a `{ kind: "matchup" }` state is
    // produced (same guarantee `../../matchup-voting.tsx`'s `MatchupPanel`
    // relies on); the null check here is only defensive type-narrowing.
    const { matchup } = votingState;
    if (
      voterContext.kind === "eligible" &&
      voterContext.existingVoteItemId &&
      matchup.itemA &&
      matchup.itemB
    ) {
      const [itemACount, itemBCount] = await Promise.all([
        prisma.vote.count({
          where: { matchupId: matchup.id, itemId: matchup.itemA.id },
        }),
        prisma.vote.count({
          where: { matchupId: matchup.id, itemId: matchup.itemB.id },
        }),
      ]);
      voteCounts = {
        [matchup.itemA.id]: itemACount,
        [matchup.itemB.id]: itemBCount,
      };
    }
  }

  // Issue #25: only computed once we know there's an actual matchup being
  // shown - see this file's top comment for which timestamp is picked and
  // why. `bracket.rounds` here is the same already-fetched ACTIVE-round
  // list `determineMatchupVotingState` searched above (filtered by the
  // `prisma.bracket.findUnique` call's own `where: { status: "ACTIVE" }`),
  // so this is a plain in-memory lookup, not a second query.
  let countdownEndsAt: Date | null = null;
  if (votingState.kind === "matchup") {
    const activeRound = bracket.rounds.find((round) => round.status === "ACTIVE");
    countdownEndsAt = votingState.isTieBreaker
      ? votingState.matchup.tieBreakerEndsAt ?? null
      : activeRound?.endsAt ?? null;
  }

  // Called directly as a plain function, not as a `<MatchupVoting ... />`
  // JSX element - same reasoning as `../../page.tsx`'s pre-#40 version and
  // `../../../discover/page.tsx`'s call to `DiscoveryGroups`: this
  // codebase's page tests introspect the return value via
  // `JSON.stringify`, which can't see into an unrendered child element.
  return MatchupVoting({
    bracketTitle: bracket.title,
    bracketId: id,
    votingState,
    voterContext,
    voteCounts,
    countdownEndsAt,
  });
}
