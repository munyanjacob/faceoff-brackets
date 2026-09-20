import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { MatchupVoting } from "./matchup-voting";
import {
  determineVoterContext,
  determineVotingState,
  type VoterContext,
} from "./voting-view-model";
import { currentVoterLookupKey } from "./voter-identity";

/**
 * `/brackets/[id]` - the public matchup-voting page (issue #21). Shows the
 * bracket's current active matchup - both items side by side with a vote
 * action under each - or an explanatory status message when there isn't
 * one right now (not started, between rounds, or completed). See
 * `./voting-view-model.ts` for the full "what counts as the active
 * matchup" reasoning, including the tie-breaker and multi-matchup-round
 * judgment calls flagged there and in the issue #21 comment.
 *
 * Deliberately has no auth *gate* of any kind, same reasoning as
 * `../../discover/page.tsx`: this route must be reachable by anyone,
 * signed in or not, including anonymous voters (per
 * `_docs/outdated/plan.md` SS3's Voter role and SS12's "anyone with the
 * private link can access it" rule for private brackets). It also does not
 * gate on `Bracket.visibility` - per the issue, a private bracket simply
 * isn't listed anywhere public (#34 already enforces that); anyone who has
 * this page's link is allowed to view and vote on it, the same as
 * `/discover` never needing a second check beyond its own listing query.
 *
 * Issue #22 adds one read-only identity check - `createClient().auth.
 * getUser()` - but only to compute `voterContext` (whether the visitor can
 * vote at all, and whether they already have) for display, not to redirect
 * or block the page itself. `./vote-actions.ts`'s `castVote` Server Action
 * re-derives and re-checks this identity independently on every submit, so
 * this page's `voterContext` is a display hint only, never the actual
 * guard.
 *
 * Looks the bracket up by `id` alone (no ownership/creator check - unlike
 * `../../dashboard/brackets/[id]/edit/page.tsx`, which is a creator-only
 * route) and 404s via `notFound()` when it doesn't exist, matching that
 * same file's convention for an unchecked id from the URL.
 *
 * Only the current `ACTIVE` round (if any) is fetched, with its matchups
 * and their items - `determineVotingState` only ever looks at an `ACTIVE`
 * round, so a completed or not-yet-started round would be wasted data. At
 * most one round is ever `ACTIVE` at a time (issues #18/#20/#27), but the
 * query and view-model both tolerate zero or more defensively rather than
 * assuming exactly one.
 */
export default async function BracketVotingPage({
  params,
}: PageProps<"/brackets/[id]">) {
  const { id } = await params;

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

  const votingState = determineVotingState(bracket, bracket.rounds);

  // The signed-in check and the existing-vote lookup below both need I/O
  // (`determineVotingState`/`determineVoterContext` deliberately don't),
  // and only ever matter when there's an actual matchup to vote on - so
  // they're skipped entirely for the (much more common) not-started/
  // between-rounds/completed cases.
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
  // JSX element - same reasoning as `../../discover/page.tsx`'s call to
  // `DiscoveryGroups`: this codebase's page tests introspect the return
  // value via `JSON.stringify`, which can't see into an unrendered child
  // element.
  return MatchupVoting({ bracketTitle: bracket.title, votingState, voterContext });
}
