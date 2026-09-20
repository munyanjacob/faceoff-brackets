import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { MatchupVoting } from "./matchup-voting";
import { determineVotingState } from "./voting-view-model";

/**
 * `/brackets/[id]` - the public matchup-voting page (issue #21). Shows the
 * bracket's current active matchup - both items side by side with a vote
 * action under each - or an explanatory status message when there isn't
 * one right now (not started, between rounds, or completed). See
 * `./voting-view-model.ts` for the full "what counts as the active
 * matchup" reasoning, including the tie-breaker and multi-matchup-round
 * judgment calls flagged there and in the issue #21 comment.
 *
 * Deliberately has no auth check of any kind, same reasoning as
 * `../../discover/page.tsx`: this route must be reachable by anyone,
 * signed in or not, including anonymous voters (per
 * `_docs/outdated/plan.md` SS3's Voter role and SS12's "anyone with the
 * private link can access it" rule for private brackets). It also does not
 * gate on `Bracket.visibility` - per the issue, a private bracket simply
 * isn't listed anywhere public (#34 already enforces that); anyone who has
 * this page's link is allowed to view and vote on it, the same as
 * `/discover` never needing a second check beyond its own listing query.
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

  // Called directly as a plain function, not as a `<MatchupVoting ... />`
  // JSX element - same reasoning as `../../discover/page.tsx`'s call to
  // `DiscoveryGroups`: this codebase's page tests introspect the return
  // value via `JSON.stringify`, which can't see into an unrendered child
  // element.
  return MatchupVoting({ bracketTitle: bracket.title, votingState });
}
