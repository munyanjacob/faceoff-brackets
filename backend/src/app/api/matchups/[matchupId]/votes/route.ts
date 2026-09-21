import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId } from "@/lib/api/auth";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { isVotableMatchupStatus } from "@/app/brackets/[id]/voting-view-model";
import {
  ANONYMOUS_VOTER_COOKIE,
  ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
  signAnonymousVoterId,
  verifyAnonymousVoterId,
  type VoterLookupKey,
} from "@/app/brackets/[id]/voter-identity";
import {
  SIGN_IN_TO_VOTE_ERROR,
  ROUND_CLOSED_ERROR,
  MATCHUP_NOT_VOTABLE_ERROR,
  INVALID_ITEM_ERROR,
  MATCHUP_NOT_FOUND_ERROR,
  RATE_LIMIT_ERROR,
  MAX_COMMENT_LENGTH,
  COMMENT_TOO_LONG_ERROR,
  VOTE_RATE_LIMIT_WINDOW_MS,
  VOTE_RATE_LIMIT_MAX_VOTES,
} from "@/app/brackets/[id]/vote-form-state";

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
 * This does not import/call the Server Action directly - a Server Action
 * is tied to `FormData` + Next's `useActionState` calling convention and
 * (via `"use server"`) can't be invoked as a plain function from a Route
 * Handler. Instead this ports the same ordered rule list
 * (docs/frontend-rework-specification.md §4.7) against the same
 * primitives the Server Action already uses - `isVotableMatchupStatus`
 * (`../../../../brackets/[id]/voting-view-model.ts`), the signed-cookie
 * helpers and rate-limit/comment constants
 * (`../../../../brackets/[id]/voter-identity.ts` /
 * `../../../../brackets/[id]/vote-form-state.ts`) - so the two entry
 * points can never silently drift on the actual business rules, error
 * copy, or thresholds. Only the request/response shape (JSON body/
 * `Response` here vs. `FormData`/`VoteFormState` there) and the identity
 * source (§6: a bearer token here, never a cookie-bound Supabase session -
 * see `../../../../lib/api/auth.ts`) differ, both dictated by this being a
 * separate, stateless REST API rather than a same-origin Server Action.
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

type VoteOutcome =
  | { kind: "success"; votedItemId: string; alreadyVoted: boolean }
  | { kind: "error"; status: number; code: string; message: string };

type CastVoteResult = {
  outcome: VoteOutcome;
  /**
   * Set only when this request minted a brand-new anonymous identity (no
   * valid `voter_id` cookie was already present) - `null` for a signed-in
   * voter, a voter with an already-valid cookie, or any rejection reached
   * before identity resolution (matchup/item/round/matchup-status checks,
   * or the `ACCOUNT_REQUIRED` block). The caller sets the cookie on
   * whatever response this outcome becomes, success or a later business
   * rejection (rate limit, comment-too-long) alike - matching the Server
   * Action, which mints/signs the cookie as an immediate side effect
   * during identity resolution, before any of those later checks run.
   */
  newAnonymousVoterId: string | null;
};

function errorOutcome(
  status: number,
  code: string,
  message: string
): CastVoteResult {
  return { outcome: { kind: "error", status, code, message }, newAnonymousVoterId: null };
}

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
    // step 2's INVALID_ITEM below rather than needing its own error code
    // (docs/openapi.yaml documents 400 for exactly "invalid item id", and
    // that's the honest description of a missing/malformed one too).
  }
  return { itemId: "", comment: "" };
}

/**
 * The ordered rule list itself (spec §4.7, numbered 1-9 in its own
 * comments below). Every step is a real, independent check against the
 * database - never trusting that a client only ever sent a request that
 * could have come from a reachable vote button.
 */
async function castVoteViaApi(
  request: NextRequest,
  matchupId: string
): Promise<CastVoteResult> {
  // 1. Matchup must exist.
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { round: { include: { bracket: true } } },
  });

  if (!matchup) {
    return errorOutcome(404, "MATCHUP_NOT_FOUND", MATCHUP_NOT_FOUND_ERROR);
  }

  const { itemId, comment: rawComment } = await readCastVoteBody(request);

  // 2. itemId must be one of the matchup's two items.
  if (matchup.itemAId !== itemId && matchup.itemBId !== itemId) {
    return errorOutcome(400, "INVALID_ITEM", INVALID_ITEM_ERROR);
  }

  // 3. The matchup's round must be ACTIVE (not PENDING/COMPLETED). A round
  // only ever leaves ACTIVE once every one of its matchups is COMPLETED -
  // a matchup that's still TIE_BREAKER keeps its round ACTIVE, so this and
  // the isVotableMatchupStatus check below never fight each other during a
  // tie-breaker window.
  if (matchup.round.status !== "ACTIVE") {
    return errorOutcome(409, "ROUND_CLOSED", ROUND_CLOSED_ERROR);
  }

  // 4. The matchup itself must be votable (ACTIVE or TIE_BREAKER).
  if (!isVotableMatchupStatus(matchup.status)) {
    return errorOutcome(409, "MATCHUP_NOT_VOTABLE", MATCHUP_NOT_VOTABLE_ERROR);
  }

  // §4.4: which VotePhase this vote belongs to, derived from the matchup's
  // status at request time - never accepted from the client.
  const phase = matchup.status === "TIE_BREAKER" ? "TIE_BREAKER" : "ORIGINAL";

  // 5. Voter identity resolution.
  const userId = await getAuthenticatedUserId(request);

  let voterKey: VoterLookupKey;
  let newAnonymousVoterId: string | null = null;
  if (userId) {
    voterKey = { userId };
  } else if (matchup.round.bracket.votingRequirement === "ACCOUNT_REQUIRED") {
    return errorOutcome(401, "SIGN_IN_REQUIRED", SIGN_IN_TO_VOTE_ERROR);
  } else {
    // Verifies the signature, not just reads the value - a missing cookie
    // *and* a present-but-tampered/invalid-signature one both fall through
    // to minting a fresh, freshly-signed id below (spec §4.10: "never a
    // hard error").
    const rawCookieValue = request.cookies.get(ANONYMOUS_VOTER_COOKIE)?.value;
    let anonymousVoterIdentifier = rawCookieValue
      ? verifyAnonymousVoterId(rawCookieValue)
      : null;
    if (!anonymousVoterIdentifier) {
      anonymousVoterIdentifier = randomUUID();
      newAnonymousVoterId = anonymousVoterIdentifier;
    }
    voterKey = { anonymousVoterIdentifier };
  }

  // 6. Existing-vote short-circuit - not an error: respond as if the vote
  // succeeded, returning the existing choice. Not the sole source of truth
  // on its own (two near-simultaneous requests from the same identity
  // could both pass this) - see the P2002 catch below for the real guard.
  const existingVote = await prisma.vote.findFirst({
    where: { matchupId, phase, ...voterKey },
  });
  if (existingVote) {
    return {
      outcome: { kind: "success", votedItemId: existingVote.itemId, alreadyVoted: true },
      newAnonymousVoterId,
    };
  }

  // 7. Rate limit - only reached once we know this would be a *new* Vote
  // insert, so repeatedly re-submitting an already-voted matchup never
  // counts against it.
  const recentVoteCount = await prisma.vote.count({
    where: {
      ...voterKey,
      createdAt: { gte: new Date(Date.now() - VOTE_RATE_LIMIT_WINDOW_MS) },
    },
  });
  if (recentVoteCount >= VOTE_RATE_LIMIT_MAX_VOTES) {
    return {
      outcome: { kind: "error", status: 429, code: "RATE_LIMITED", message: RATE_LIMIT_ERROR },
      newAnonymousVoterId,
    };
  }

  // 8. Optional comment: trimmed; whitespace-only -> null; over 500 chars
  // -> rejected (never silently truncated). Checked here, not earlier
  // alongside the matchup/round/item checks: those are all "is this vote
  // even attemptable" checks independent of whether a Vote is actually
  // about to be created, so a stale/oversized comment never overrides the
  // existing-vote short-circuit above.
  const trimmedComment = rawComment.trim();
  if (trimmedComment.length > MAX_COMMENT_LENGTH) {
    return {
      outcome: { kind: "error", status: 400, code: "COMMENT_TOO_LONG", message: COMMENT_TOO_LONG_ERROR },
      newAnonymousVoterId,
    };
  }
  const comment = trimmedComment.length > 0 ? trimmedComment : null;

  // 9. Insert the vote - race-safe via the same unique-constraint recovery
  // pattern as the Server Action: `prisma/schema.prisma`'s
  // `@@unique([matchupId, userId, phase])` /
  // `@@unique([matchupId, anonymousVoterIdentifier, phase])` reject the
  // losing insert at the database level; recovered the same way as the
  // proactive-check path above (the voter's existing choice, not an
  // error), never surfacing the constraint violation to the caller.
  try {
    const created = await prisma.vote.create({
      data: {
        matchupId,
        itemId,
        userId: "userId" in voterKey ? voterKey.userId : null,
        anonymousVoterIdentifier:
          "anonymousVoterIdentifier" in voterKey
            ? voterKey.anonymousVoterIdentifier
            : null,
        comment,
        phase,
      },
    });
    return {
      outcome: { kind: "success", votedItemId: created.itemId, alreadyVoted: false },
      newAnonymousVoterId,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existingAfterRace = await prisma.vote.findFirst({
        where: { matchupId, phase, ...voterKey },
      });
      return {
        outcome: {
          kind: "success",
          // Defensive fallback only: existingAfterRace should always be
          // found here (that's exactly why the insert above raced), but
          // unlike the Server Action's VoteFormState (which allows
          // votedItemId: null), docs/openapi.yaml's CastVoteResponse
          // requires a string - fall back to the item just attempted
          // rather than violate the response schema in this
          // near-impossible case.
          votedItemId: existingAfterRace?.itemId ?? itemId,
          alreadyVoted: true,
        },
        newAnonymousVoterId,
      };
    }
    throw err;
  }
}

function outcomeToResponse(outcome: VoteOutcome): NextResponse {
  if (outcome.kind === "success") {
    return NextResponse.json({
      votedItemId: outcome.votedItemId,
      alreadyVoted: outcome.alreadyVoted,
    });
  }
  return errorResponse(outcome.status, outcome.code, outcome.message);
}

async function handlePost(
  request: NextRequest,
  context: { params: Promise<{ matchupId: string }> }
): Promise<Response> {
  const { matchupId } = await context.params;
  const { outcome, newAnonymousVoterId } = await castVoteViaApi(request, matchupId);

  const response = outcomeToResponse(outcome);

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
