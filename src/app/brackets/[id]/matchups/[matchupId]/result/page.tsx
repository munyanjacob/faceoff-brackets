import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { MatchupResult } from "./matchup-result";
import { buildMatchupResultState, type ResultComment } from "./matchup-result-view-model";

/**
 * `/brackets/[id]/matchups/[matchupId]/result` - the completed-matchup
 * detail view (issue #31), reached by clicking a decided matchup's cell in
 * `../../../tree/bracket-tree.tsx` (issue #30). See
 * `./matchup-result-view-model.ts`'s top comment for why this is a new
 * sibling route rather than a second state of `../page.tsx` (the existing
 * "cast a vote" page).
 *
 * Looks the matchup up by `matchupId` alone (not scoped through the
 * bracket's rounds the way `../page.tsx` is, since a decided matchup's round
 * may no longer be `ACTIVE`) and separately checks its `Round.bracketId`
 * matches the `id` in the URL - the same "wrong bracket for this matchup id"
 * 404 case `../page.tsx` covers via its own scoped query.
 *
 * A matchup that exists but isn't `COMPLETED` yet (a stale/mistyped link,
 * or a race where voting reopened) redirects back to the voting page
 * (`../page.tsx`) rather than rendering a broken "result" for a matchup
 * that doesn't have one yet - that page already knows how to render
 * whatever *is* currently true for it (votable, between rounds, etc).
 *
 * Vote counts and comments are only fetched for a real (non-bye) matchup -
 * `matchup.itemBId === null` means it was decided by a bye
 * (`@/lib/bracket/generate-first-round.ts`), which never had any voting.
 */
export default async function MatchupResultPage({
  params,
}: PageProps<"/brackets/[id]/matchups/[matchupId]/result">) {
  const { id, matchupId } = await params;

  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: {
      itemA: true,
      itemB: true,
      round: { include: { bracket: true } },
    },
  });

  if (!matchup || matchup.round.bracketId !== id) {
    notFound();
  }

  if (matchup.status !== "COMPLETED") {
    redirect(`/brackets/${id}/matchups/${matchupId}`);
  }

  let voteCountsByItemId: Record<string, number> = {};
  let comments: ResultComment[] = [];

  if (matchup.itemAId && matchup.itemBId) {
    const [votesForA, votesForB, commentRows] = await Promise.all([
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemAId },
      }),
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemBId },
      }),
      prisma.vote.findMany({
        where: { matchupId: matchup.id, comment: { not: null } },
        orderBy: { createdAt: "asc" },
        select: { id: true, itemId: true, comment: true, createdAt: true },
      }),
    ]);

    voteCountsByItemId = { [matchup.itemAId]: votesForA, [matchup.itemBId]: votesForB };
    // `comment: { not: null }` above guarantees `comment` is a string here -
    // Prisma's generated type still widens it to `string | null` since the
    // filter isn't reflected in the select's type.
    comments = commentRows.map((row) => ({ ...row, comment: row.comment as string }));
  }

  const resultState = buildMatchupResultState(matchup, voteCountsByItemId, comments);

  // Called directly as a plain function, not as a `<MatchupResult ... />`
  // JSX element - same reasoning as every other page/presentational split
  // in this codebase (see e.g. `../../../matchup-voting.tsx`'s top comment):
  // this codebase's page tests introspect the return value via
  // `JSON.stringify`, which can't see into an unrendered child element.
  return MatchupResult({
    bracketTitle: matchup.round.bracket.title,
    bracketId: id,
    resultState,
  });
}
