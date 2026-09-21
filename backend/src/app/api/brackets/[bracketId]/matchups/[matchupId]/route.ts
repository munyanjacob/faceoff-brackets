import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId } from "@/lib/api/auth";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { determineVoterContext } from "@/app/brackets/[id]/voting-view-model";
import { currentVoterLookupKey } from "@/app/brackets/[id]/voter-identity";

// GET /api/brackets/[bracketId]/matchups/[matchupId] (issue #55;
// docs/openapi.yaml's `getMatchup` operation).
//
// Public, identity-personalized single-matchup voting view. Reuses the two
// pieces of real business logic this needs, rather than re-deriving them:
//
//  - `determineVoterContext` (`../../../../../brackets/[id]/voting-view-model.ts`,
//    issue #22) for the blocked/eligible decision.
//  - `currentVoterLookupKey` (`../../../../../brackets/[id]/voter-identity.ts`,
//    issue #22/#35) to resolve the caller's identity from a bearer token or
//    the signed `voter_id` cookie - read-only here, same as
//    `../../../../../brackets/[id]/matchups/[matchupId]/page.tsx`; neither
//    that page nor this endpoint ever mints/sets the cookie, only
//    `POST /matchups/{matchupId}/votes` (issue #56) does that.
//
// Deliberately does *not* reuse `determineMatchupVotingState` (the same
// view-model file's per-matchup helper for `.../matchups/[matchupId]/
// page.tsx`): that helper only ever looks inside the bracket's current
// `ACTIVE` round and 404s (or falls back to a bracket-level status message)
// for anything else - a UX rule for that page's redirect/index routing, not
// a constraint on this resource. This endpoint looks the matchup up
// directly by id (scoped to `bracketId` via its round), independent of the
// matchup's or its round's status, so an already-PENDING (round not started
// yet) or already-COMPLETED matchup still resolves to a real
// `MatchupVotingView` rather than a 404 or a generic bracket-level message -
// `docs/openapi.yaml`'s own `countdownEndsAt` description explicitly names
// the PENDING case ("a PENDING matchup in a SCHEDULED bracket's round 1,
// before the round has an endsAt"), which only makes sense under this
// broader read. Flagged in the issue #55 grooming comment as a deliberate
// scope difference from the page, not an oversight.
//
// `countdownEndsAt`/`isTieBreaker`: same timestamp-selection reasoning as
// `../../../../../brackets/[id]/matchups/[matchupId]/page.tsx`'s top
// comment - the round's own `endsAt` for a normal matchup, or the matchup's
// own `tieBreakerEndsAt` once it's `TIE_BREAKER` (the round's `endsAt` has
// already passed by then and doesn't reflect the tie-breaker's real
// deadline).
//
// `voter.voteCounts`: same gating as issue #24's page version - only
// computed (two `prisma.vote.count` calls) once the caller already has an
// existing vote on this matchup+phase, so a voter who hasn't voted yet never
// even triggers the query, let alone sees the counts.

type RouteParams = {
  params: Promise<{ bracketId: string; matchupId: string }>;
};

function fetchMatchupInBracket(bracketId: string, matchupId: string) {
  return prisma.matchup.findFirst({
    where: { id: matchupId, round: { bracketId } },
    include: {
      itemA: true,
      itemB: true,
      round: { include: { bracket: true } },
    },
  });
}

async function handleGetMatchup(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { bracketId, matchupId } = await params;

  const matchup = await fetchMatchupInBracket(bracketId, matchupId);

  if (!matchup) {
    // Distinguishes "the bracket itself is gone" from "this matchup id is
    // wrong/belongs elsewhere" only for the error message's accuracy - both
    // are a 404 either way (docs/openapi.yaml's getMatchup 404: "Matchup
    // doesn't exist, or doesn't belong to this bracket"). Only costs a
    // second query on the not-found path; the common (found) path never
    // pays for it.
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

  const bracket = matchup.round.bracket;
  const isTieBreaker = matchup.status === "TIE_BREAKER";
  const countdownEndsAt = isTieBreaker
    ? matchup.tieBreakerEndsAt
    : matchup.round.endsAt;

  const userId = await getAuthenticatedUserId(request);
  const lookupKey = await currentVoterLookupKey(userId);

  // Issue #41: scoped by the same current-phase rule `castVote` (#56) uses -
  // a TIE_BREAKER matchup's existing-vote lookup is against the
  // TIE_BREAKER phase, never the voter's earlier ORIGINAL-phase vote, so
  // "have you voted" always answers for *this* votable window.
  let existingVoteItemId: string | null = null;
  if (lookupKey) {
    const existingVote = await prisma.vote.findFirst({
      where: {
        matchupId: matchup.id,
        phase: isTieBreaker ? "TIE_BREAKER" : "ORIGINAL",
        ...lookupKey,
      },
    });
    existingVoteItemId = existingVote?.itemId ?? null;
  }

  const voterContext = determineVoterContext(
    bracket.votingRequirement,
    Boolean(userId),
    existingVoteItemId
  );

  let voteCounts: Record<string, number> | undefined;
  if (
    voterContext.kind === "eligible" &&
    voterContext.existingVoteItemId &&
    matchup.itemA &&
    matchup.itemB
  ) {
    const [itemACount, itemBCount] = await Promise.all([
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemA.id },
      }),
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemB.id },
      }),
    ]);
    voteCounts = {
      [matchup.itemA.id]: itemACount,
      [matchup.itemB.id]: itemBCount,
    };
  }

  // `voteCounts: undefined` is dropped entirely by JSON.stringify (via
  // NextResponse.json below), which is exactly docs/openapi.yaml's "only
  // present once the caller has already voted" rule for VoterContext -
  // never a present-but-empty object.
  const voter =
    voterContext.kind === "eligible"
      ? { ...voterContext, voteCounts }
      : voterContext;

  return NextResponse.json({
    matchup: {
      id: matchup.id,
      status: matchup.status,
      itemA: matchup.itemA,
      itemB: matchup.itemB,
    },
    bracketTitle: bracket.title,
    isTieBreaker,
    countdownEndsAt,
    voter,
  });
}

export const GET = async (
  request: Request,
  ctx: RouteParams
): Promise<Response> =>
  withCors(request, await withErrorHandling(handleGetMatchup)(request, ctx));

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
