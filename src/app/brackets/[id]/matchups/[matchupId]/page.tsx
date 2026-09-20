import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { MatchupVoting } from "../../matchup-voting";
import {
  determineMatchupVotingState,
  determineVoterContext,
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
 * Bracket-level unavailability (not started, completed, between rounds)
 * renders the same status message `../../page.tsx` shows for those cases -
 * reached directly by URL, this route has no way to know "am I the only
 * live matchup" is moot when there's no live round at all, so it just
 * falls back to the same bracket-level message rather than a confusing
 * 404. Only an actually-wrong matchup id (typo, already-decided matchup,
 * one that belongs to a different round/bracket) 404s via `notFound()` -
 * see `../../voting-view-model.ts`'s `determineMatchupVotingState`.
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
  });
}
