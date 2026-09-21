import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import {
  buildMatchupResultState,
  type ResultComment,
} from "@/app/brackets/[id]/matchups/[matchupId]/result/matchup-result-view-model";

// GET /api/brackets/[bracketId]/matchups/[matchupId]/result (issue #57;
// docs/openapi.yaml's `getMatchupResult` operation).
//
// Public, no personalization - unlike the voting-view endpoints (#55/#56)
// this never reads a bearer token or the `voter_id` cookie, since a result
// is the same for every viewer. Reuses
// `../../../../../../../brackets/[id]/matchups/[matchupId]/result/
// matchup-result-view-model.ts`'s `buildMatchupResultState` verbatim -
// the same pure function `.../result/page.tsx` (issue #31) already uses -
// rather than re-deriving the bye/decided branching or the tie-breaker
// detection (`tieBreakerEndsAt !== null`) a second time.
//
// ## Mapping the view-model's `MatchupResultState` onto the wire `MatchupResult`
//
// - `docs/openapi.yaml`'s `MatchupResult` union has no `matchupId` field on
//   any variant (it's already in the URL) - dropped here even though the
//   view-model's `bye`/`decided` states carry one (built for a page that
//   links elsewhere with it).
// - The view-model has no notion of "not completed yet" - `page.tsx` instead
//   redirects to the voting page before ever calling
//   `buildMatchupResultState` for a non-`COMPLETED` matchup. A REST endpoint
//   can't redirect a JSON caller, so that check happens here instead: any
//   matchup whose `status !== "COMPLETED"` short-circuits straight to
//   `{kind: "not_completed"}`, per the operation's own description ("If the
//   matchup isn't decided yet, returns the `not_completed` variant instead
//   of a result").
// - The view-model's third state, `{kind: "unresolved"}`, is a defensive-only
//   fallback for a `COMPLETED` matchup with anomalous data (missing `itemA`,
//   or no `winnerItemId` despite having two items - see that file's comment:
//   every real code path that marks a matchup `COMPLETED` also sets
//   `winnerItemId`, so this "shouldn't happen"). `MatchupResult` has no
//   matching variant, so this is reported the same way as "not decided yet"
//   rather than inventing an undocumented `kind` or crashing the request.
//
// ## Combined-phase vote counts (tie-breaker-decided matchups)
//
// `winnerVoteCount`/`loserVoteCount` are computed the same way `page.tsx`
// already does it: a plain `prisma.vote.count({ where: { matchupId, itemId } })`
// per item, with no `phase` filter - so for a matchup that went through a
// tie-breaker, the counts shown are the *combined* total across both the
// `ORIGINAL` and `TIE_BREAKER` phases, never just the tie-breaker-phase tally
// that actually decided the outcome. This is deliberate and matches
// `docs/openapi.yaml`'s own `decidedByTieBreaker` description: "Vote counts
// shown are the combined total across both ORIGINAL and TIE_BREAKER phases
// regardless of this flag."

type RouteParams = {
  params: Promise<{ bracketId: string; matchupId: string }>;
};

function fetchMatchupInBracket(bracketId: string, matchupId: string) {
  return prisma.matchup.findFirst({
    where: { id: matchupId, round: { bracketId } },
    include: { itemA: true, itemB: true },
  });
}

async function handleGetMatchupResult(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { bracketId, matchupId } = await params;

  const matchup = await fetchMatchupInBracket(bracketId, matchupId);

  if (!matchup) {
    // Same "which side is actually missing" distinction as
    // .../matchups/[matchupId]/route.ts (issue #55) - both cases are a 404
    // either way, this only makes the message accurate.
    const bracketExists = await prisma.bracket.findUnique({
      where: { id: bracketId },
      select: { id: true },
    });
    return errorResponse(
      404,
      "NOT_FOUND",
      bracketExists
        ? "This matchup no longer exists."
        : "This bracket no longer exists."
    );
  }

  if (matchup.status !== "COMPLETED") {
    return NextResponse.json({ kind: "not_completed" });
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
    // filter isn't reflected in the select's type (same cast `.../result/
    // page.tsx` already does for the same reason).
    comments = commentRows.map((row) => ({ ...row, comment: row.comment as string }));
  }

  const resultState = buildMatchupResultState(matchup, voteCountsByItemId, comments);

  switch (resultState.kind) {
    case "bye":
      return NextResponse.json({
        kind: "bye",
        advancingItem: resultState.advancing,
      });
    case "decided":
      return NextResponse.json({
        kind: "decided",
        winner: resultState.winner,
        winnerVoteCount: resultState.winnerVoteCount,
        loser: resultState.loser,
        loserVoteCount: resultState.loserVoteCount,
        decidedByTieBreaker: resultState.decidedByTieBreaker,
        comments: resultState.comments,
      });
    case "unresolved":
    default:
      return NextResponse.json({ kind: "not_completed" });
  }
}

export const GET = async (
  request: Request,
  ctx: RouteParams
): Promise<Response> =>
  withCors(request, await withErrorHandling(handleGetMatchupResult)(request, ctx));

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
