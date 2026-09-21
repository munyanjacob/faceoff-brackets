import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import {
  buildBracketTree,
  type MatchupCell as InternalMatchupCell,
} from "@/app/brackets/[id]/tree/bracket-tree-view-model";
import { buildChampion, type ChampionState } from "@/app/brackets/[id]/tree/champion-view-model";
import {
  computeTotalRounds,
  roundNameHint,
} from "@/app/dashboard/brackets/[id]/edit/round-duration";

// GET /api/brackets/[bracketId]/tree (issue #57; docs/openapi.yaml's
// `getBracketTree` operation).
//
// Public, no personalization. Reuses the same three pure view-models
// `.../brackets/[id]/tree/page.tsx` (issues #30/#32) already assembles:
//
//  - `buildBracketTree` (`.../tree/bracket-tree-view-model.ts`) for the
//    per-round `MatchupCell` layout, including synthesized "upcoming"
//    placeholder columns for rounds that don't have a `Round` row yet.
//  - `buildChampion` (`.../tree/champion-view-model.ts`) for the champion
//    section, only once `bracket.status === "COMPLETED"`.
//
// ## Mapping the view-models' internal shapes onto the wire `BracketTree`
//
// `docs/openapi.yaml`'s `BracketTree`/`BracketTreeRound`/`MatchupCell` were
// reconciled against `frontend/src/services/types.ts` in issue #49 (see
// specification.md §9.6) - `types.ts` is used as the exact ground truth
// below wherever this reading of openapi.yaml could be ambiguous:
//
//  - Every non-"upcoming" cell carries a `matchupId` (renamed from the
//    view-model's `id`).
//  - The "upcoming" cell carries a `label` (a display hint) instead of an
//    `id` - the view-model's placeholder cells don't have one (only their
//    *round* does), so every "upcoming" cell in a column is given that
//    column's own `label`.
//  - Each `BracketTreeRound` needs its own `status`
//    (`PENDING | ACTIVE | COMPLETED | NOT_STARTED`), which the view-model's
//    `RoundColumn` doesn't carry - resolved here from the real `Round.status`
//    looked up by `roundNumber` against what was actually fetched, falling
//    back to `NOT_STARTED` for any column `buildBracketTree` synthesized
//    beyond the persisted rounds.
//  - `BracketTree` itself also carries `bracketTitle`/`bracketStatus`/
//    `totalRounds` alongside `rounds`/`champion` (added to openapi.yaml in
//    #49 so the tree page's header doesn't need a second `getBracket` call).
//  - `champion` uses `{item, finalTally}` (issue #49's renaming from
//    `{winner, tally}`) and is only ever a non-null object once
//    `buildChampion` reports a real, non-bye-decided champion - the
//    `{kind: "champion", tally: null}` defensive fallback (a bye-decided
//    final match, reasoned to be unreachable - see champion-view-model.ts's
//    top comment) has no vote tally to report, and `docs/openapi.yaml`'s
//    `champion.finalTally` is required + exactly 2 items whenever `champion`
//    itself is non-null, so that anomalous state is reported as `champion:
//    null` rather than an invalid/partial object.
//
// ## Always returning at least one round (issue #57 acceptance criterion)
//
// `buildBracketTree` returns a `{kind: "not-published"}` message instead of
// any rounds when `bracket.rounds` is empty (a `DRAFT` bracket - round 1 is
// only created at publish time, #18) - built for the page's own
// message-vs-tree branch. `docs/openapi.yaml`'s `getBracketTree` explicitly
// requires the opposite for this endpoint: "a bracket with no rounds started
// yet ... still returns a `rounds` array (at least one entry) with each
// round's `status: 'NOT_STARTED'` and an empty `cells` array, so the client
// always has a round count/label to render placeholders from." This route
// handles that case itself (see `synthesizeUnstartedRounds` below) rather
// than calling `buildBracketTree` at all when there are no persisted rounds,
// using the bracket's current `BracketItem` count and the same
// `computeTotalRounds`/`roundNameHint` helpers `buildBracketTree` itself
// uses internally (imported here from their real source,
// `.../dashboard/brackets/[id]/edit/round-duration.ts`, since
// `bracket-tree-view-model.ts` only re-exports the built tree, not these).

type RouteParams = { params: Promise<{ bracketId: string }> };

function fetchBracketWithRounds(bracketId: string) {
  return prisma.bracket.findUnique({
    where: { id: bracketId },
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
}

type FetchedBracket = NonNullable<Awaited<ReturnType<typeof fetchBracketWithRounds>>>;
type FetchedRound = FetchedBracket["rounds"][number];
type FetchedMatchup = FetchedRound["matchups"][number];
type FetchedItem = NonNullable<FetchedMatchup["itemA"]>;

type WireCell =
  | { kind: "bye"; matchupId: string; advancingItem: FetchedItem }
  | { kind: "completed"; matchupId: string; winner: FetchedItem; loser: FetchedItem }
  | {
      kind: "active";
      matchupId: string;
      itemA: FetchedItem;
      itemB: FetchedItem;
      isTieBreaker: boolean;
    }
  | { kind: "pending"; matchupId: string; itemA: FetchedItem | null; itemB: FetchedItem | null }
  | { kind: "upcoming"; label: string };

type WireRound = {
  roundNumber: number;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "NOT_STARTED";
  label: string;
  cells: WireCell[];
};

/**
 * Maps one `bracket-tree-view-model.ts` `MatchupCell` onto this endpoint's
 * wire shape - see this file's top comment for the `matchupId`/`label`
 * renaming. The `as unknown as FetchedItem` casts recover the full
 * `BracketItem` shape (`bracketId`, `description`, `seed`, `createdAt`)
 * `docs/openapi.yaml`'s `BracketItem` schema requires: the view-model's own
 * `TreeItem` type only declares the subset of fields it needs to render
 * (`id`/`title`/`imageUrl`), but the actual object reference passed through
 * it is always the real, fully-fetched Prisma row this route queried below -
 * same reasoning/pattern as `.../matchups/route.ts`'s `toMatchupSummary`
 * cast (issue #55).
 */
function toWireCell(cell: InternalMatchupCell, roundLabel: string): WireCell {
  switch (cell.kind) {
    case "bye":
      return {
        kind: "bye",
        matchupId: cell.id,
        advancingItem: cell.advancing as unknown as FetchedItem,
      };
    case "completed":
      return {
        kind: "completed",
        matchupId: cell.id,
        winner: cell.winner as unknown as FetchedItem,
        loser: cell.loser as unknown as FetchedItem,
      };
    case "active":
      return {
        kind: "active",
        matchupId: cell.id,
        itemA: cell.itemA as unknown as FetchedItem,
        itemB: cell.itemB as unknown as FetchedItem,
        isTieBreaker: cell.isTieBreaker,
      };
    case "pending":
      return {
        kind: "pending",
        matchupId: cell.id,
        itemA: cell.itemA as unknown as FetchedItem | null,
        itemB: cell.itemB as unknown as FetchedItem | null,
      };
    case "upcoming":
      return { kind: "upcoming", label: roundLabel };
  }
}

/** The "no `Round` rows exist yet" branch - see this file's top comment. */
async function synthesizeUnstartedRounds(bracketId: string): Promise<WireRound[]> {
  const itemCount = await prisma.bracketItem.count({ where: { bracketId } });
  const totalRounds = Math.max(1, computeTotalRounds(itemCount));

  return Array.from({ length: totalRounds }, (_, index) => {
    const roundNumber = index + 1;
    return {
      roundNumber,
      status: "NOT_STARTED" as const,
      label: roundNameHint(roundNumber, totalRounds) ?? `Round ${roundNumber}`,
      cells: [],
    };
  });
}

/** The normal branch - at least one `Round` row already exists. */
function buildWireRounds(rounds: FetchedRound[]): WireRound[] {
  const statusByRoundNumber = new Map(rounds.map((round) => [round.roundNumber, round.status]));

  const treeState = buildBracketTree(rounds);
  // Guaranteed "tree" (never "not-published"), since `rounds.length > 0` is
  // this function's only caller's precondition.
  const columns = treeState.kind === "tree" ? treeState.rounds : [];

  return columns.map((column) => ({
    roundNumber: column.roundNumber,
    status: statusByRoundNumber.get(column.roundNumber) ?? "NOT_STARTED",
    label: column.label,
    cells: column.matchups.map((cell) => toWireCell(cell, column.label)),
  }));
}

function toWireChampion(
  championState: ChampionState
): { item: FetchedItem; finalTally: { item: FetchedItem; votes: number }[] } | null {
  if (championState.kind !== "champion" || championState.tally === null) {
    return null;
  }
  return {
    item: championState.winner as unknown as FetchedItem,
    finalTally: championState.tally.map((entry) => ({
      item: entry.item as unknown as FetchedItem,
      votes: entry.votes,
    })),
  };
}

/**
 * Issue #32's champion section - same reasoning as `.../tree/page.tsx`'s own
 * `buildChampionForBracket`: the champion-declaring matchup is always the
 * last-fetched round's decided matchup (rounds are fetched oldest-first, and
 * a `COMPLETED` bracket's highest round is always the one that produced the
 * lone winner), so no extra `Round` query is needed - only the final
 * matchup's own per-item vote counts.
 */
async function buildWireChampionForBracket(
  bracketStatus: string,
  rounds: FetchedRound[]
): Promise<ReturnType<typeof toWireChampion>> {
  if (bracketStatus !== "COMPLETED" || rounds.length === 0) {
    return toWireChampion(buildChampion(bracketStatus, null, null));
  }

  const finalRound = rounds[rounds.length - 1];
  const finalMatchup = finalRound.matchups.find((matchup) => matchup.winnerItemId) ?? null;

  if (!finalMatchup || !finalMatchup.itemA || !finalMatchup.itemB) {
    return toWireChampion(buildChampion(bracketStatus, finalMatchup, null));
  }

  const [itemAVotes, itemBVotes] = await Promise.all([
    prisma.vote.count({
      where: { matchupId: finalMatchup.id, itemId: finalMatchup.itemA.id },
    }),
    prisma.vote.count({
      where: { matchupId: finalMatchup.id, itemId: finalMatchup.itemB.id },
    }),
  ]);

  return toWireChampion(
    buildChampion(bracketStatus, finalMatchup, { itemAVotes, itemBVotes })
  );
}

async function handleGetBracketTree(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { bracketId } = await params;

  const bracket = await fetchBracketWithRounds(bracketId);

  if (!bracket) {
    return errorResponse(404, "NOT_FOUND", "This bracket no longer exists.");
  }

  const rounds =
    bracket.rounds.length === 0
      ? await synthesizeUnstartedRounds(bracketId)
      : buildWireRounds(bracket.rounds);

  const champion = await buildWireChampionForBracket(bracket.status, bracket.rounds);

  return NextResponse.json({
    bracketTitle: bracket.title,
    bracketStatus: bracket.status,
    totalRounds: rounds.length,
    rounds,
    champion,
  });
}

export const GET = async (
  request: Request,
  ctx: RouteParams
): Promise<Response> =>
  withCors(request, await withErrorHandling(handleGetBracketTree)(request, ctx));

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
