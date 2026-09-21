import type { TreeItem } from "./bracket-tree-view-model";

/**
 * Pure, framework-agnostic view-model for the champion section on
 * `/brackets/[id]/tree` (issue #32) - the winning item's image/title plus
 * the final matchup's vote tally, shown above the full tree
 * (`bracket-tree.tsx`) once a bracket is `COMPLETED`. Kept separate from
 * `page.tsx` and free of any Prisma import, same reasoning as
 * `./bracket-tree-view-model.ts`'s top comment - so "what does the champion
 * section show" can be unit-tested without a database connection.
 *
 * ## Where the champion comes from
 *
 * `@/lib/rounds/evaluate-round.ts` (#20) only ever flips `Bracket.status` to
 * `COMPLETED` in one place: when a Round it just closed leaves exactly one
 * winner (`winnerIds.length === 1`), and in that same branch it deliberately
 * creates no further Round. So a `COMPLETED` bracket's highest-`roundNumber`
 * Round is always the one whose closing produced the champion, and it always
 * has exactly one `Matchup` (the one that produced that lone winner) - not
 * zero, not several.
 *
 * `page.tsx` already fetches every Round (with matchups, `itemA`/`itemB`
 * included) for the tree itself, ordered oldest-first - the highest-
 * `roundNumber` Round is simply the last element of that already-fetched
 * list, so no extra Round query is needed here; only the final matchup's
 * per-item vote counts (`Vote` rows) are an additional query, following the
 * same `prisma.vote.count({ where: { matchupId, itemId } })` pattern
 * `evaluate-round.ts` itself uses to decide a matchup's winner.
 *
 * ## Could the champion-declaring matchup be a bye?
 *
 * A bye's winner (`itemB` null) is decided at round-creation time (#18's
 * `generateFirstRound` for round 1, or `evaluateRound`'s own reuse of it
 * when pairing winners into a later round) - never via `evaluateRound`
 * closing a round down to one remaining winner. For the *final* round (the
 * one whose closing sets `Bracket.status = COMPLETED`) to consist of a
 * single bye matchup, that round would have to be created with exactly one
 * `Matchup`, itself a bye. But `evaluateRound` only ever creates a next
 * round when the previous round left *more than one* winner
 * (`winnerIds.length === 1` short-circuits straight to completing the
 * bracket, before any next round is created) - and `generateFirstRound`
 * only produces a bye for an *odd* leftover item, i.e. only when pairing
 * down more than 2 items into more than 1 matchup. Pairing exactly 2
 * surviving winners always yields exactly 1 matchup with both `itemA` and
 * `itemB` set (a real 1-vs-1), never a bye. So a `COMPLETED` bracket's final
 * matchup can never itself be a bye, for any bracket size #17 allows
 * (2+ items) - this is reasoned through, not just assumed, but this module
 * still handles a bye final matchup gracefully (winner shown, no vote tally
 * implied, rather than crashing or showing a misleading "0 votes") in case
 * that invariant is ever violated by a future change elsewhere.
 */

export type ChampionMatchup = {
  id: string;
  itemA: TreeItem | null;
  itemB: TreeItem | null;
  winnerItemId: string | null;
};

export type ChampionTallyEntry = {
  item: TreeItem;
  votes: number;
};

export type ChampionVoteCounts = {
  itemAVotes: number;
  itemBVotes: number;
};

export type ChampionState =
  | { kind: "none" }
  | {
      kind: "champion";
      winner: TreeItem;
      // `null` when the final matchup was a bye (see this file's top
      // comment) - no vote tally exists to show in that case.
      tally: [ChampionTallyEntry, ChampionTallyEntry] | null;
    };

/**
 * Builds the champion section's state. Returns `{ kind: "none" }" whenever
 * the champion section shouldn't render at all - not just for a non-
 * `COMPLETED` bracket (the acceptance criterion this guards), but also
 * defensively for any shape that doesn't look like a real decided final
 * matchup, so a data anomaly falls back to "nothing shown" rather than
 * crashing the page.
 */
export function buildChampion(
  bracketStatus: string,
  finalMatchup: ChampionMatchup | null,
  votes: ChampionVoteCounts | null
): ChampionState {
  if (bracketStatus !== "COMPLETED") {
    return { kind: "none" };
  }

  if (!finalMatchup || !finalMatchup.itemA || !finalMatchup.winnerItemId) {
    return { kind: "none" };
  }

  const winner =
    finalMatchup.winnerItemId === finalMatchup.itemA.id
      ? finalMatchup.itemA
      : finalMatchup.itemB;

  if (!winner || winner.id !== finalMatchup.winnerItemId) {
    // Defensive only - winnerItemId didn't match either item on the row.
    return { kind: "none" };
  }

  if (!finalMatchup.itemB || !votes) {
    // A bye-decided final matchup (see this file's top comment for why this
    // shouldn't be reachable) - show the winner, imply no vote tally.
    return { kind: "champion", winner, tally: null };
  }

  return {
    kind: "champion",
    winner,
    tally: [
      { item: finalMatchup.itemA, votes: votes.itemAVotes },
      { item: finalMatchup.itemB, votes: votes.itemBVotes },
    ],
  };
}
