import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { listVotableMatchups } from "@/app/brackets/[id]/voting-view-model";

// GET /api/brackets/[bracketId]/matchups (issue #55; docs/openapi.yaml's
// `listVotableMatchups` operation).
//
// Public read-only endpoint - lists the bracket's currently votable
// matchups, or a status message when there's nothing to vote on right now.
// Deliberately a thin wrapper: all of the actual "what counts as votable
// right now" logic already lives in
// `../../../../brackets/[id]/voting-view-model.ts`'s `listVotableMatchups`
// (built for `../../../../brackets/[id]/page.tsx`'s index/redirect
// decision, issue #40) - this route reuses it verbatim against the same
// Prisma query shape that page already uses, rather than re-deriving the
// not-started/between-rounds/completed rules a second time.
//
// Response shape is `docs/openapi.yaml`'s `VotableMatchupsResponse`
// discriminated union: `{kind:"message", message}` when
// `listVotableMatchups` reports no votable matchup, or `{kind:"matchups",
// matchups: MatchupSummary[]}` otherwise. The "exactly one matchup ->
// navigate straight to it" behavior the operation's description mentions is
// explicitly client-side routing (see the issue #55 grooming comment) - not
// this endpoint's job; it always returns the full list, of whatever length.
//
// No auth is used here at all (unlike the single-matchup endpoint) -
// `VotableMatchupsResponse` carries no per-voter personalization, only
// bracket-wide matchup data.

type RouteParams = { params: Promise<{ bracketId: string }> };

type FetchedBracket = NonNullable<
  Awaited<ReturnType<typeof fetchBracketWithActiveRound>>
>;
type FetchedMatchup = FetchedBracket["rounds"][number]["matchups"][number];

function fetchBracketWithActiveRound(bracketId: string) {
  return prisma.bracket.findUnique({
    where: { id: bracketId },
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
}

function toMatchupSummary(matchup: FetchedMatchup) {
  return {
    id: matchup.id,
    status: matchup.status,
    itemA: matchup.itemA,
    itemB: matchup.itemB,
  };
}

async function handleGetVotableMatchups(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { bracketId } = await params;

  const bracket = await fetchBracketWithActiveRound(bracketId);

  if (!bracket) {
    return errorResponse(404, "NOT_FOUND", "This bracket no longer exists.");
  }

  const matchupListState = listVotableMatchups(bracket, bracket.rounds);

  const body =
    matchupListState.kind === "no-active-matchup"
      ? { kind: "message" as const, message: matchupListState.message }
      : {
          kind: "matchups" as const,
          // `listVotableMatchups` narrows each matchup's `itemA`/`itemB`
          // static type down to the minimal `VotingItem` shape it declares
          // (see that file's top comment) - the underlying objects are
          // still the exact same Prisma rows this route fetched (the
          // function only `.filter()`s/`.find()`s, never clones), so this
          // cast recovers the full `BracketItem` shape (`bracketId`,
          // `seed`, `createdAt`, etc.) that `docs/openapi.yaml`'s
          // `BracketItem` schema requires in the response, without a
          // second query.
          matchups: (
            matchupListState.matchups as unknown as FetchedMatchup[]
          ).map(toMatchupSummary),
        };

  return NextResponse.json(body);
}

export const GET = async (
  request: Request,
  ctx: RouteParams
): Promise<Response> =>
  withCors(request, await withErrorHandling(handleGetVotableMatchups)(request, ctx));

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
