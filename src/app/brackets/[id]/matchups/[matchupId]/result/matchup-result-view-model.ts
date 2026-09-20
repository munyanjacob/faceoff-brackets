/**
 * Pure, framework-agnostic view-model for `/brackets/[id]/matchups/[matchupId]/result`
 * (issue #31): the completed-matchup detail view reached by clicking a
 * decided matchup in the bracket tree (`../../../tree/bracket-tree.tsx`,
 * issue #30). Kept separate from `page.tsx` and free of any Prisma import,
 * same reasoning as `../../../voting-view-model.ts`'s top comment - so "what
 * does a decided matchup's result look like" can be unit-tested without a
 * database connection.
 *
 * ## Why this is a separate route, not a second state of the voting page
 *
 * `../page.tsx` (the existing `/brackets/[id]/matchups/[matchupId]` voting
 * page, issue #21/#22/#40) already has a well-defined, well-tested contract:
 * a matchup that isn't currently votable - including an already-`COMPLETED`
 * one - resolves to `{ kind: "not-found" }` in `../../../voting-view-model.ts`'s
 * `determineMatchupVotingState` and 404s (see that file's
 * "reports not-found for a matchupId that exists but isn't currently votable
 * (e.g. already COMPLETED)" test). Folding "show the result instead" into
 * that same route/state machine would mean either changing that contract
 * (breaking the existing test and every caller that relies on "not votable
 * -> not-found") or bolting a third, unrelated concern onto a function whose
 * whole job is "is there a vote to cast right now". A sibling route with its
 * own small view-model keeps each page's concern - "cast a vote" vs. "see
 * how it turned out" - independently testable and doesn't risk the
 * already-shipped voting flow. See the issue #31 comment for the fuller
 * write-up of this decision, including the accepted trade-off: a matchup
 * URL bookmarked while it was still votable still 404s once it completes
 * (unchanged, pre-existing behavior) - a voter reaches the result instead
 * through the tree view's new link (`../../../tree/bracket-tree.tsx`).
 *
 * ## Bye detection
 *
 * Same convention as `../../../tree/bracket-tree-view-model.ts`'s
 * `toMatchupCell`: `itemB === null` means the slot was decided by a bye
 * (`@/lib/bracket/generate-first-round.ts`), not a played 1-vs-1 matchup - a
 * bye never had any voting, so no vote tally is shown for it at all (not
 * even "0 - 0", which would misleadingly imply a vote took place and nobody
 * showed up).
 *
 * ## Tie-breaker labeling
 *
 * `Matchup.tieBreakerEndsAt` (see `prisma/schema.prisma`) is the only trace
 * left once a tie-breaker-resolved matchup reaches `COMPLETED` -
 * `status` itself becomes `COMPLETED` either way (clean majority or
 * tie-breaker), and `@/lib/rounds/resolve-tie-breaker.ts` never clears
 * `tieBreakerEndsAt` after resolving. A non-null `tieBreakerEndsAt` on a
 * `COMPLETED` matchup therefore reliably means "this went through a
 * tie-breaker vote" - that's `decidedByTieBreaker` below.
 *
 * There is deliberately no further split into "decisive tie-breaker vote"
 * vs. "tie-breaker tied again, resolved by random fallback" -
 * `resolveTieBreaker` persists identically (`status = COMPLETED`,
 * `winnerItemId` set) in both cases; nothing in the row distinguishes a
 * 2-1 tie-breaker tally from a coin flip. A general "resolved via
 * tie-breaker" label is what's actually derivable from the data, and is
 * what issue #31's acceptance criterion asks for ("labeled as such", not
 * "distinguish random from voted") - see the issue #31 comment.
 *
 * ## Vote tally
 *
 * `winnerVoteCount`/`loserVoteCount` are simple per-item `Vote` counts for
 * the matchup - the same unfiltered counting `@/lib/rounds/evaluate-round.ts`
 * uses (issue #31's own instruction: "same counting approach ... though here
 * you're just displaying, not deciding an outcome"). For a tie-breaker
 * matchup this is deliberately the *total* vote count across the whole
 * matchup's history (original round + tie-breaker window combined), not
 * `resolve-tie-breaker.ts`'s `tieBreakerStartedAt`-filtered tally it actually
 * decided the outcome from - this view only displays a tally, so the total
 * is the more informative "final vote count for each side" the acceptance
 * criteria ask for, and it's what the issue explicitly points at. Flagged in
 * the issue #31 comment.
 */

export type ResultItem = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
};

export type ResultComment = {
  id: string;
  itemId: string;
  comment: string;
  createdAt: Date;
};

/**
 * What `page.tsx` reads a `Matchup` row into before handing it to
 * `buildMatchupResultState`. `itemA`/`itemB` mirror
 * `../../../tree/bracket-tree-view-model.ts`'s `TreeItem`-shaped input
 * (only `itemB` is ever null, for a bye).
 */
export type ResultMatchup = {
  id: string;
  itemA: ResultItem | null;
  itemB: ResultItem | null;
  winnerItemId: string | null;
  tieBreakerEndsAt: Date | null;
};

export type MatchupResultState =
  | { kind: "bye"; matchupId: string; advancing: ResultItem }
  | {
      kind: "decided";
      matchupId: string;
      winner: ResultItem;
      winnerVoteCount: number;
      loser: ResultItem;
      loserVoteCount: number;
      decidedByTieBreaker: boolean;
      comments: ResultComment[];
    }
  // Defensive only - a COMPLETED matchup with no itemA, or no winnerItemId
  // despite having two items, shouldn't happen (see
  // `@/lib/rounds/evaluate-round.ts`'s top comment: every path that marks a
  // Matchup COMPLETED also sets winnerItemId) - falls back rather than
  // crashing the whole page, same reasoning as
  // `../../../tree/bracket-tree-view-model.ts`'s `toMatchupCell` fallback.
  | { kind: "unresolved" };

/**
 * Turns one `COMPLETED` `Matchup` row (plus its already-tallied vote counts
 * and comments) into the state `./matchup-result.tsx` renders. Callers
 * (`page.tsx`) are expected to only call this for a matchup whose `status`
 * is already `COMPLETED` - this function doesn't re-check `status` itself,
 * since "is it actually decided yet" is a routing decision (redirect back to
 * the voting page otherwise), not a display one.
 *
 * `voteCountsByItemId` only needs entries for a real (non-bye) matchup's two
 * items - callers can pass an empty map for a bye, since it's never read in
 * that branch.
 */
export function buildMatchupResultState(
  matchup: ResultMatchup,
  voteCountsByItemId: Record<string, number>,
  comments: ResultComment[]
): MatchupResultState {
  if (!matchup.itemA) {
    return { kind: "unresolved" };
  }

  if (matchup.itemB === null) {
    return { kind: "bye", matchupId: matchup.id, advancing: matchup.itemA };
  }

  if (!matchup.winnerItemId) {
    return { kind: "unresolved" };
  }

  const winnerIsItemA = matchup.winnerItemId === matchup.itemA.id;
  const winner = winnerIsItemA ? matchup.itemA : matchup.itemB;
  const loser = winnerIsItemA ? matchup.itemB : matchup.itemA;
  const winnerVoteCount = voteCountsByItemId[winner.id] ?? 0;
  const loserVoteCount = voteCountsByItemId[loser.id] ?? 0;

  return {
    kind: "decided",
    matchupId: matchup.id,
    winner,
    winnerVoteCount,
    loser,
    loserVoteCount,
    decidedByTieBreaker: matchup.tieBreakerEndsAt !== null,
    comments,
  };
}
