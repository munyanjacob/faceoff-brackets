import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/api/auth";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import {
  castVoteCore,
  type CastVoteOutcome,
} from "@/lib/vote/cast-vote-core";
import {
  ANONYMOUS_VOTER_COOKIE,
  ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
  signAnonymousVoterId,
} from "@/app/brackets/[id]/voter-identity";

/**
 * `POST /matchups/{matchupId}/votes` (issue #56, docs/openapi.yaml's
 * `castVote` operation) - the REST-API sibling of
 * `../../../../brackets/[id]/vote-actions.ts`'s `castVote` Server Action.
 *
 * NOT nested under `/brackets/{bracketId}/...` - see docs/openapi.yaml's
 * `/matchups/{matchupId}/votes` path (a matchup id alone is already
 * globally unique, and the frontend's `votingService.castVote` call
 * (spec.md §7.3) only ever has the matchup id in hand at the point it
 * votes).
 *
 * A thin adapter (issue #77) over `../../../../lib/vote/cast-vote-core.ts`'s
 * `castVoteCore`, which owns the actual ordered rule list
 * (docs/frontend-rework-specification.md §4.7) shared with the Server
 * Action above - so the two entry points can never silently drift on the
 * actual business rules, error copy, or thresholds. This file's only
 * remaining jobs: parse the JSON body, resolve identity from *this* entry
 * point's own source (a bearer token via `getAuthenticatedUserId`, never a
 * cookie-bound Supabase session - see `../../../../lib/api/auth.ts`, spec
 * §6), translate `castVoteCore`'s result into a `Response`, and set the
 * anonymous-voter cookie on the response with this entry point's own
 * attributes (Domain/Secure, absent from the Server Action's cookie).
 *
 * Also, deliberately, no `revalidatePath` call (unlike the Server Action) -
 * spec §7.6/§8.3: "no more automatic Next.js `revalidatePath` once split";
 * refetching after a mutation is the new frontend's own concern.
 */

// The signed voter_id cookie's `Domain` attribute (spec §6, issue #48's
// topology-(a) decision: frontend and backend as subdomains of one shared
// parent domain). Same overridable-with-a-documented-placeholder-fallback
// pattern as ../../../../lib/api/cors.ts's `FRONTEND_ORIGIN` - the leading
// dot is what makes the cookie travel to both the `app.` and `api.`
// subdomains (see that file's own comment for why this mirrors
// docs/openapi.yaml's placeholder `servers` entry).
const DEFAULT_VOTER_COOKIE_DOMAIN = ".example.com";
const VOTER_COOKIE_DOMAIN =
  process.env.VOTER_COOKIE_DOMAIN ?? DEFAULT_VOTER_COOKIE_DOMAIN;

async function readCastVoteBody(
  request: NextRequest
): Promise<{ itemId: string; comment: string }> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      return {
        itemId: typeof record.itemId === "string" ? record.itemId : "",
        comment: typeof record.comment === "string" ? record.comment : "",
      };
    }
  } catch {
    // Malformed or absent JSON body - falls through to the same "" default
    // as a body with no itemId/comment field at all. An empty itemId can
    // never equal a real matchup item id, so this naturally resolves to
    // cast-vote-core's INVALID_ITEM step rather than needing its own error
    // code (docs/openapi.yaml documents 400 for exactly "invalid item id",
    // and that's the honest description of a missing/malformed one too).
  }
  return { itemId: "", comment: "" };
}

function outcomeToResponse(outcome: CastVoteOutcome, itemId: string): NextResponse {
  if (outcome.kind === "voted") {
    return NextResponse.json({
      // Unlike the Server Action's VoteFormState (which allows
      // `votedItemId: null`), docs/openapi.yaml's CastVoteResponse requires
      // a string - fall back to the item just attempted rather than violate
      // the response schema in cast-vote-core's near-impossible
      // race-recovery-not-found case. See that module's doc-comment on
      // `insertVoteWithRaceRecovery` for why this fallback lives here
      // rather than in the shared core.
      votedItemId: outcome.votedItemId ?? itemId,
      alreadyVoted: outcome.alreadyVoted,
    });
  }
  const statusByCode: Record<string, number> = {
    MATCHUP_NOT_FOUND: 404,
    INVALID_ITEM: 400,
    ROUND_CLOSED: 409,
    MATCHUP_NOT_VOTABLE: 409,
    SIGN_IN_REQUIRED: 401,
    RATE_LIMITED: 429,
    COMMENT_TOO_LONG: 400,
  };
  return errorResponse(
    statusByCode[outcome.error.code],
    outcome.error.code,
    outcome.error.message
  );
}

async function handlePost(
  request: NextRequest,
  context: { params: Promise<{ matchupId: string }> }
): Promise<Response> {
  const { matchupId } = await context.params;
  const { itemId, comment } = await readCastVoteBody(request);
  const userId = await getAuthenticatedUserId(request);
  const rawAnonymousCookieValue = request.cookies.get(ANONYMOUS_VOTER_COOKIE)?.value;

  const { outcome, newAnonymousVoterId } = await castVoteCore({
    matchupId,
    itemId,
    comment,
    userId,
    rawAnonymousCookieValue,
  });

  const response = outcomeToResponse(outcome, itemId);

  if (newAnonymousVoterId) {
    // §6's decided attributes for this cookie, exactly: Domain (the shared
    // parent domain, leading dot), SameSite=Lax, Secure, httpOnly, Path=/.
    response.cookies.set(
      ANONYMOUS_VOTER_COOKIE,
      signAnonymousVoterId(newAnonymousVoterId),
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        domain: VOTER_COOKIE_DOMAIN,
        path: "/",
        maxAge: ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
      }
    );
  }

  return response;
}

/**
 * Every exported method applies CORS headers (issue #50/#60,
 * `../../../../lib/api/cors.ts`) as the outermost step, wrapping
 * `withErrorHandling`'s own generic-500 fallback too - so even an
 * unexpected failure still carries the CORS headers a cross-origin
 * `credentials: "include"` request needs to read the response at all.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ matchupId: string }> }
): Promise<Response> {
  const response = await withErrorHandling(handlePost)(request, context);
  return withCors(request, response);
}

export function OPTIONS(request: NextRequest): Response {
  return preflightResponse(request);
}
