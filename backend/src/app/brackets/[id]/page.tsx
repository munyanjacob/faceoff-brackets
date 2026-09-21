import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { MatchupIndex } from "./matchup-index";
import { MatchupVoting } from "./matchup-voting";
import { listVotableMatchups } from "./voting-view-model";

/**
 * `/brackets/[id]` - the public bracket-voting entry point (issue #21;
 * restructured into a routing layer by issue #40). No longer the page that
 * renders a matchup's vote UI itself - that's
 * `./matchups/[matchupId]/page.tsx` now, for every case, including the
 * common one. This page only ever does one of three things:
 *
 * 1. Its active round has no votable matchup right now (not started,
 *    between rounds, or completed) - render the same explanatory status
 *    message issue #21 built, via `./matchup-voting.tsx` (unchanged) - see
 *    `./voting-view-model.ts`'s `listVotableMatchups`.
 * 2. Its active round has exactly one votable matchup - the common case,
 *    including every round after round 1 shrinks the bracket down to one
 *    matchup - `redirect()` straight into
 *    `/brackets/[id]/matchups/[matchupId]` so the single-matchup UX is
 *    unchanged for a voter, just reached one hop later. This also means
 *    every existing link to `/brackets/[id]` (issue #33's dashboard, #34's
 *    discovery page) keeps resolving to something sensible without either
 *    of those having to change what they link to.
 * 3. Its active round has more than one votable matchup at once - render a
 *    lightweight index of links into each one (`./matchup-index.tsx`), so a
 *    voter can reach and vote on every matchup in the round, not just
 *    whichever one a fixed pick-the-first rule would have shown before
 *    issue #40.
 *
 * No signed-in check, no `Vote` lookup, no `voterContext` here anymore -
 * those only ever mattered for an actual matchup's vote UI, which now lives
 * entirely on `./matchups/[matchupId]/page.tsx`. See that file for the
 * "why this route has no auth gate" reasoning (issue #21/#22's - it
 * carries over unchanged, just moved).
 *
 * Looks the bracket up by `id` alone (no ownership/creator check) and 404s
 * via `notFound()` when it doesn't exist - unchanged from issue #21.
 *
 * Only the current `ACTIVE` round (if any) is fetched, with its matchups
 * and their items - same query shape as issue #21/#22, still tolerant of
 * zero or more `ACTIVE` rounds defensively even though at most one is ever
 * active at a time (issues #18/#20/#27).
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

  const matchupListState = listVotableMatchups(bracket, bracket.rounds);

  if (matchupListState.kind === "no-active-matchup") {
    // Called directly as a plain function, not as a `<MatchupVoting ... />`
    // JSX element - same reasoning as `../../discover/page.tsx`'s call to
    // `DiscoveryGroups`: this codebase's page tests introspect the return
    // value via `JSON.stringify`, which can't see into an unrendered child
    // element.
    return MatchupVoting({
      bracketTitle: bracket.title,
      bracketId: id,
      votingState: matchupListState,
      voterContext: { kind: "eligible", existingVoteItemId: null },
    });
  }

  if (matchupListState.matchups.length === 1) {
    redirect(`/brackets/${id}/matchups/${matchupListState.matchups[0].id}`);
  }

  return MatchupIndex({
    bracketTitle: bracket.title,
    bracketId: id,
    matchups: matchupListState.matchups,
  });
}
