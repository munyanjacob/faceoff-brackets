import {
  computeTotalRounds,
  roundNameHint,
} from "@/app/dashboard/brackets/[id]/edit/round-duration";

/**
 * Pure, framework-agnostic view-model for `/brackets/[id]/tree` (issue #30):
 * the full bracket-tree view, as opposed to `../voting-view-model.ts`'s
 * "just the one live matchup" concern. Kept separate from `page.tsx` and
 * free of any Prisma import, same reasoning as `../voting-view-model.ts`'s
 * top comment - so "what does each round column look like" can be
 * unit-tested without a database connection.
 *
 * ## Why this needs to synthesize rounds that don't exist yet
 *
 * `Round` rows are created lazily: round 1 is created at publish time
 * (`../../../dashboard/brackets/[id]/edit/publish-actions.ts`, #18), and
 * every later round is only created once `evaluateRound`
 * (`@/lib/rounds/evaluate-round.ts`, #20) closes the one before it. That
 * means an in-progress bracket's later rounds - the ones
 * `_docs/outdated/plan.md` SS14's mockup shows as empty "Semifinal"/"Final"
 * columns converging toward a champion - genuinely have no `Matchup` rows
 * in the database yet. To render the *whole* tree structure (not just
 * "however many rounds happen to exist so far"), this module works out the
 * total round count from round 1's item count
 * (`computeTotalRounds`, reused from #13's round-duration module - the same
 * `ceil(log2(itemCount))` rule) and fills in placeholder "not yet reached"
 * columns for every round beyond the ones actually persisted.
 *
 * Round 1's item count is read back out of round 1's own matchups (a bye
 * matchup contributes 1 item, i.e. just `itemA`; a real matchup contributes
 * 2) rather than requiring a separate `BracketItem` count from the caller -
 * one less thing `page.tsx` has to fetch and this module has to trust
 * matches.
 *
 * ## Bracket order
 *
 * Callers must pass each round's matchups already ordered the same way
 * `@/lib/rounds/evaluate-round.ts` reads and writes them - `itemA.createdAt`
 * ascending (see that file's top comment for why that ordering
 * reconstructs bracket position with no extra schema column). This module
 * doesn't re-sort; it only lays out whatever order it's given, top to
 * bottom, per column.
 */

export type TreeItem = {
  id: string;
  title: string;
  imageUrl: string | null;
};

export type TreeMatchup = {
  id: string;
  status: string; // Matchup status: PENDING | ACTIVE | TIE_BREAKER | COMPLETED
  itemA: TreeItem | null;
  itemB: TreeItem | null;
  winnerItemId: string | null;
};

export type TreeRound = {
  roundNumber: number;
  matchups: TreeMatchup[];
};

/**
 * One cell in the tree - what `bracket-tree.tsx` needs to render a single
 * matchup slot distinctly per the issue's acceptance criteria:
 *
 * - `"bye"`: an automatic advance (`itemB` was never set), not a played
 *   1-vs-1 match - rendered as "Item A (bye)", no opposing slot.
 * - `"completed"`: winner shown distinctly from loser.
 * - `"active"`: the currently votable matchup(s) (`ACTIVE`/`TIE_BREAKER`),
 *   visually distinguished from both completed and not-yet-reached slots.
 * - `"pending"`: a real `Matchup` row exists (so its two items are already
 *   known - the round it belongs to was already created) but voting hasn't
 *   opened yet, e.g. a `SCHEDULED` bracket's round 1 before its start time.
 * - `"upcoming"`: no `Matchup` row exists yet at all - a future round this
 *   bracket hasn't reached, items unknown.
 */
export type MatchupCell =
  | { kind: "bye"; id: string; advancing: TreeItem }
  | { kind: "completed"; id: string; winner: TreeItem; loser: TreeItem }
  | {
      kind: "active";
      id: string;
      itemA: TreeItem;
      itemB: TreeItem;
      isTieBreaker: boolean;
    }
  | { kind: "pending"; id: string; itemA: TreeItem | null; itemB: TreeItem | null }
  | { kind: "upcoming"; id: string };

export type RoundColumn = {
  roundNumber: number;
  label: string;
  matchups: MatchupCell[];
};

export type BracketTreeState =
  | { kind: "not-published"; message: string }
  | { kind: "tree"; rounds: RoundColumn[] };

export const NOT_PUBLISHED_MESSAGE =
  "This bracket hasn't been published yet - there's no bracket tree to show.";

/**
 * Turns one real `Matchup` row into its display cell. `matchup.itemA` is
 * guaranteed present on any real row (only `itemB` is ever null, for a
 * bye - see `@/lib/rounds/evaluate-round.ts`'s top comment), so only
 * `itemB`/`winnerItemId` combinations are branched on here.
 */
function toMatchupCell(matchup: TreeMatchup): MatchupCell {
  if (!matchup.itemA) {
    // Defensive only - not expected on a real Matchup row (see comment
    // above) - falls back to "pending" rather than crashing the whole tree.
    return { kind: "pending", id: matchup.id, itemA: null, itemB: matchup.itemB };
  }

  if (matchup.itemB === null) {
    return { kind: "bye", id: matchup.id, advancing: matchup.itemA };
  }

  if (matchup.status === "COMPLETED" && matchup.winnerItemId) {
    const winner =
      matchup.winnerItemId === matchup.itemA.id ? matchup.itemA : matchup.itemB;
    const loser =
      matchup.winnerItemId === matchup.itemA.id ? matchup.itemB : matchup.itemA;
    return { kind: "completed", id: matchup.id, winner, loser };
  }

  if (matchup.status === "ACTIVE" || matchup.status === "TIE_BREAKER") {
    return {
      kind: "active",
      id: matchup.id,
      itemA: matchup.itemA,
      itemB: matchup.itemB,
      isTieBreaker: matchup.status === "TIE_BREAKER",
    };
  }

  // PENDING (e.g. a SCHEDULED bracket's round 1 before its start time), or a
  // COMPLETED row missing winnerItemId (shouldn't happen - see
  // evaluate-round.ts - but fall back rather than crash).
  return { kind: "pending", id: matchup.id, itemA: matchup.itemA, itemB: matchup.itemB };
}

/**
 * Round 1's item count, read back out of its own matchups rather than
 * required as a separate input - see this file's top comment.
 */
function itemCountFromFirstRound(firstRound: TreeRound): number {
  return firstRound.matchups.reduce(
    (sum, matchup) => sum + (matchup.itemB ? 2 : 1),
    0
  );
}

/**
 * Builds every round column `/brackets/[id]/tree` should render, from
 * whichever rounds actually exist in the database so far - synthesizing
 * "upcoming" placeholder columns for any later round this bracket hasn't
 * reached yet (see this file's top comment).
 *
 * `rounds` must be sorted by `roundNumber` ascending, and every round's
 * `matchups` in bracket order (see this file's top comment).
 */
export function buildBracketTree(rounds: TreeRound[]): BracketTreeState {
  if (rounds.length === 0) {
    return { kind: "not-published", message: NOT_PUBLISHED_MESSAGE };
  }

  const totalRounds = Math.max(
    computeTotalRounds(itemCountFromFirstRound(rounds[0])),
    rounds.length
  );
  const byRoundNumber = new Map(rounds.map((round) => [round.roundNumber, round]));

  const columns: RoundColumn[] = [];
  // Winners still left to feed into the *next* round - starts as round 1's
  // matchup count (one winner per matchup, bye or not) once round 1 itself
  // is appended below, and is only used to size a not-yet-created round's
  // placeholder slots.
  let remainingWinners = rounds[0].matchups.length;

  for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
    const round = byRoundNumber.get(roundNumber);
    const label = roundNameHint(roundNumber, totalRounds) ?? `Round ${roundNumber}`;

    if (round) {
      columns.push({
        roundNumber,
        label,
        matchups: round.matchups.map(toMatchupCell),
      });
      remainingWinners = round.matchups.length;
    } else {
      const matchupCount = Math.max(1, Math.ceil(remainingWinners / 2));
      columns.push({
        roundNumber,
        label,
        matchups: Array.from({ length: matchupCount }, (_, index) => ({
          kind: "upcoming" as const,
          id: `upcoming-${roundNumber}-${index}`,
        })),
      });
      remainingWinners = matchupCount;
    }
  }

  return { kind: "tree", rounds: columns };
}
