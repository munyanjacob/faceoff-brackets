import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BracketTree } from "./bracket-tree";
import { buildBracketTree } from "./bracket-tree-view-model";
import { buildChampion, type ChampionState } from "./champion-view-model";

/**
 * `/brackets/[id]/tree` - the full bracket-tree view (issue #30).
 *
 * Issue #40 turned `/brackets/[id]` into a routing layer that either
 * redirects straight into a single live matchup or shows a lightweight
 * index of several - it no longer renders any page content of its own in
 * the common case, so there's nowhere left on that route for "the whole
 * tournament tree" to live. This route is that place instead: unlike
 * `/brackets/[id]`, it always renders (a message, or the tree), regardless
 * of `Bracket.status` - draft/scheduled/active/completed all resolve to
 * *something* sensible here rather than a redirect or a 404-if-no-active-
 * round.
 *
 * Looks the bracket up by `id` alone, same as `../page.tsx` - 404s via
 * `notFound()` when it doesn't exist.
 *
 * Fetches *every* round (not just the `ACTIVE` one `../page.tsx` cares
 * about), ordered oldest-first, each round's matchups ordered by
 * `itemA.createdAt` ascending - the same bracket-order convention
 * `@/lib/rounds/evaluate-round.ts` reads/writes rounds in (see that file's
 * top comment), so this tree's top-to-bottom order within a column is
 * consistent round over round. A `DRAFT` bracket has no rounds at all yet
 * (round 1 is only created at publish time - #18) - `buildBracketTree`
 * turns that empty list into an explicit "not published yet" message
 * rather than an empty/broken-looking tree.
 *
 * ## Champion section (issue #32)
 *
 * When `bracket.status === "COMPLETED"`, this also builds the champion
 * section's state via `./champion-view-model.ts`'s `buildChampion` - see
 * that file's top comment for why the final round can be read straight back
 * out of the `bracket.rounds` list already fetched above (its last element,
 * since rounds are fetched oldest-first) rather than a second Round query,
 * and why only the final matchup's per-item `Vote` counts need an extra
 * query, counted with the same `prisma.vote.count({ where: { matchupId,
 * itemId } })` pattern `@/lib/rounds/evaluate-round.ts` uses to decide a
 * winner. For any other `Bracket.status`, `buildChampion` returns
 * `{ kind: "none" }` and no vote-count query runs at all.
 */
export default async function BracketTreePage({
  params,
}: PageProps<"/brackets/[id]/tree">) {
  const { id } = await params;

  const bracket = await prisma.bracket.findUnique({
    where: { id },
    include: {
      rounds: {
        orderBy: { roundNumber: "asc" },
        include: {
          matchups: {
            orderBy: { itemA: { createdAt: "asc" } },
            include: { itemA: true, itemB: true },
          },
        },
      },
    },
  });

  if (!bracket) {
    notFound();
  }

  const treeState = buildBracketTree(bracket.rounds);
  const champion = await buildChampionForBracket(bracket.status, bracket.rounds);

  // Called directly as a plain function, not as a `<BracketTree ... />` JSX
  // element - same reasoning as every other page/presentational split in
  // this codebase (see e.g. `../matchup-voting.tsx`'s top comment): this
  // codebase's page tests introspect the return value via
  // `JSON.stringify`, which can't see into an unrendered child element.
  return BracketTree({ bracketTitle: bracket.title, bracketId: id, treeState, champion });
}

/**
 * Issue #32's champion section, computed here rather than inline in the
 * page function above so its "no query at all unless COMPLETED" early-out
 * reads clearly. See `./champion-view-model.ts`'s top comment for the full
 * reasoning behind reading the final round back out of `rounds` and why the
 * champion-declaring matchup can't itself be a bye.
 */
async function buildChampionForBracket(
  bracketStatus: string,
  rounds: Array<{
    matchups: Array<{
      id: string;
      itemA: { id: string; title: string; imageUrl: string | null } | null;
      itemB: { id: string; title: string; imageUrl: string | null } | null;
      winnerItemId: string | null;
    }>;
  }>
): Promise<ChampionState> {
  if (bracketStatus !== "COMPLETED" || rounds.length === 0) {
    return buildChampion(bracketStatus, null, null);
  }

  const finalRound = rounds[rounds.length - 1];
  const finalMatchup =
    finalRound.matchups.find((matchup) => matchup.winnerItemId) ?? null;

  if (!finalMatchup || !finalMatchup.itemA || !finalMatchup.itemB) {
    // No decided matchup found (data anomaly), or a bye-decided one (see
    // champion-view-model.ts - reasoned to be unreachable for a COMPLETED
    // bracket's final matchup, handled gracefully anyway) - no vote tally
    // to query either way.
    return buildChampion(bracketStatus, finalMatchup, null);
  }

  const [itemAVotes, itemBVotes] = await Promise.all([
    prisma.vote.count({
      where: { matchupId: finalMatchup.id, itemId: finalMatchup.itemA.id },
    }),
    prisma.vote.count({
      where: { matchupId: finalMatchup.id, itemId: finalMatchup.itemB.id },
    }),
  ]);

  return buildChampion(bracketStatus, finalMatchup, { itemAVotes, itemBVotes });
}
