import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/api/auth";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { buildRoundOnePlan } from "@/lib/bracket/build-round-one";
import { parseStoredRoundDurationOverrides } from "@/app/dashboard/brackets/[id]/edit/round-duration";

/**
 * `POST /brackets/{bracketId}/publish` (issue #54, docs/openapi.yaml's
 * `publishBracket` operation) - the REST-API sibling of
 * `../../../dashboard/brackets/[id]/edit/publish-actions.ts`'s
 * `publishBracket` Server Action.
 *
 * This does not import/call the Server Action directly - a Server Action is
 * tied to `FormData` + Next's `useActionState` calling convention (and its
 * `notFound()`/`unstable_rethrow` control flow) and can't be invoked as a
 * plain function from a Route Handler. Instead this re-derives the exact
 * same persistence logic that Server Action runs - same
 * `bracket.findFirst({ id, creatorId })` ownership scoping, same
 * `>= 2 items` guard, same `scheduledStartAt` → SCHEDULED/ACTIVE decision,
 * same `parseStoredRoundDurationOverrides` duration resolution, and,
 * crucially, the exact same `buildRoundOnePlan` call (which itself wraps
 * `generateFirstRound`, #17) feeding the exact same one
 * `prisma.$transaction` shape for the `Bracket` update + `Round`/`Matchup`
 * creation - so round 1's bye/pairing algorithm can never disagree between
 * the dashboard's Server Action and this REST endpoint.
 *
 * Two differences, both dictated by this being a separate, stateless REST
 * API rather than a same-origin Server Action (per
 * docs/frontend-rework-specification.md §6):
 * - Identity source: a bearer token via `getAuthenticatedUserId`
 *   (`@/lib/api/auth`), never a cookie-bound Supabase session. A
 *   missing/invalid token is a 401 here, not a `notFound()` 404 - the
 *   Server Action's `requireOwnedBracket` conflates "not signed in" and
 *   "not this creator's bracket" into one 404 because it has no other way
 *   to represent "unauthenticated" in a Server Action; a REST endpoint
 *   does, so unauthenticated gets its own documented 401
 *   (`unauthorizedResponse()`) and "not found or not owned" keeps its own
 *   404 (`NOT_FOUND`) - matching every other creator-scoped endpoint in
 *   this API (spec §4.9) and openapi.yaml's documented response set for
 *   this operation.
 * - Response/error shape: JSON `{ code, message }` (`errorResponse`) and
 *   the published `Bracket` row on success (openapi.yaml: 200,
 *   `#/components/schemas/Bracket`) instead of `PublishFormState`. The
 *   `NOT_DRAFT`/`TOO_FEW_ITEMS` codes and their exact message strings come
 *   straight from openapi.yaml's documented 409 examples for this
 *   operation, and match `publish-actions.ts`'s own
 *   `NOT_DRAFT_ERROR`/`NOT_ENOUGH_ITEMS_ERROR` constants verbatim.
 *
 * Also, deliberately, no `revalidatePath` call (unlike the Server Action) -
 * spec §7.6/§8.3: refetching after a mutation is the new frontend's own
 * concern once split from Next's same-origin cache.
 */

const NOT_DRAFT_ERROR = "This bracket has already been published.";

const NOT_ENOUGH_ITEMS_ERROR =
  "Add at least 2 items before publishing this bracket.";

const MINIMUM_ITEM_COUNT = 2;

const NOT_FOUND_ERROR = "This bracket no longer exists.";

type RouteParams = { params: Promise<{ bracketId: string }> };

async function handlePost(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return unauthorizedResponse();
  }

  const { bracketId } = await params;

  // Scoped to `id AND creatorId = caller` (spec §4.9) - never `id` alone.
  // Not found *or* not owned both fall through to the same 404, so a
  // non-owner can't learn a bracket with this id exists at all.
  const bracket = await prisma.bracket.findFirst({
    where: { id: bracketId, creatorId: userId },
  });

  if (!bracket) {
    return errorResponse(404, "NOT_FOUND", NOT_FOUND_ERROR);
  }

  // A bracket that exists and is owned but isn't DRAFT is a distinct,
  // non-404 case (spec §4.9) - publish is one-way, so this also covers
  // "already published" for a stale tab / double click / direct re-request.
  if (bracket.status !== "DRAFT") {
    return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ERROR);
  }

  const itemCount = await prisma.bracketItem.count({
    where: { bracketId: bracket.id },
  });

  if (itemCount < MINIMUM_ITEM_COUNT) {
    return errorResponse(409, "TOO_FEW_ITEMS", NOT_ENOUGH_ITEMS_ERROR);
  }

  const status = bracket.scheduledStartAt ? "SCHEDULED" : "ACTIVE";
  const immediateStart = status === "ACTIVE";
  const publishedAt = new Date();

  // Same order `publish-actions.ts`/the edit-page preview read items in -
  // `orderBy: { createdAt: "asc" }` - so this can never produce different
  // pairings than the dashboard's own preview/publish for this item list.
  const items = await prisma.bracketItem.findMany({
    where: { bracketId: bracket.id },
    orderBy: { createdAt: "asc" },
  });

  const overrides = parseStoredRoundDurationOverrides(
    bracket.roundDurationOverrides
  );
  const durationMinutes = overrides[1] ?? bracket.defaultRoundDurationMinutes;

  // Reused as-is (#54's constraint) - never reimplemented - so round 1's
  // bye/pairing algorithm can't drift from the dashboard's Server Action or
  // the edit-page preview.
  const roundPlan = buildRoundOnePlan(items, {
    durationMinutes,
    immediateStart,
    now: publishedAt,
  });

  // One transaction, same shape as publish-actions.ts: the Bracket update
  // and Round+Matchup creation happen together so a bracket can never be
  // left ACTIVE/SCHEDULED with no Round row if something fails partway.
  const updatedBracket = await prisma.$transaction(async (tx) => {
    const updated = await tx.bracket.update({
      where: { id: bracket.id },
      data: { status, publishedAt },
    });

    await tx.round.create({
      data: {
        bracketId: bracket.id,
        roundNumber: roundPlan.roundNumber,
        durationMinutes: roundPlan.durationMinutes,
        status: roundPlan.status,
        startsAt: roundPlan.startsAt,
        endsAt: roundPlan.endsAt,
        matchups: {
          create: roundPlan.matchups.map((matchup) => ({
            itemAId: matchup.itemAId,
            itemBId: matchup.itemBId,
            winnerItemId: matchup.winnerItemId,
            status: matchup.status,
          })),
        },
      },
    });

    return updated;
  });

  return NextResponse.json({
    ...updatedBracket,
    // See brackets/[bracketId]/route.ts's identical normalization - this
    // update only touches status/publishedAt, so the column is still null
    // when round-duration has never been PATCHed for this bracket.
    roundDurationOverrides: parseStoredRoundDurationOverrides(
      updatedBracket.roundDurationOverrides
    ),
  });
}

/**
 * Applies CORS headers (`@/lib/api/cors`) as the outermost step, wrapping
 * `withErrorHandling`'s own generic-500 fallback too - so even an
 * unexpected failure still carries the CORS headers a cross-origin
 * `credentials: "include"` request needs to read the response at all.
 */
export async function POST(
  request: Request,
  context: RouteParams
): Promise<Response> {
  const response = await withErrorHandling(handlePost)(request, context);
  return withCors(request, response);
}

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
