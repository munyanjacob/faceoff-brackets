import { NextResponse } from "next/server";
import { requireOwnedBracket } from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { NOT_DRAFT_PUBLISH_MESSAGE } from "@/lib/api/messages";
import { toWireBracket } from "@/lib/api/wire-bracket";
import {
  publishBracketCore,
  NOT_ENOUGH_ITEMS_ERROR,
} from "@/lib/bracket/publish-core";

/**
 * `POST /brackets/{bracketId}/publish` (issue #54, docs/openapi.yaml's
 * `publishBracket` operation) - the REST-API sibling of
 * `../../../dashboard/brackets/[id]/edit/publish-actions.ts`'s
 * `publishBracket` Server Action.
 *
 * A thin adapter (issue #77) over `@/lib/bracket/publish-core.ts`'s
 * `publishBracketCore`, which owns the actual DRAFT/item-count/transaction
 * rules shared with the Server Action above - so round 1's bye/pairing
 * algorithm and the publish preconditions can never disagree between the
 * dashboard and this REST endpoint.
 *
 * Two differences from the Server Action, both dictated by this being a
 * separate, stateless REST API rather than a same-origin Server Action
 * (per docs/frontend-rework-specification.md §6):
 * - Identity source: a bearer token via the shared `requireOwnedBracket`
 *   (`@/lib/api/require-owned-bracket`, issue #72), never a cookie-bound
 *   Supabase session. A missing/invalid token is a 401 here, not a
 *   `notFound()` 404 - the Server Action's own `requireOwnedBracket`
 *   conflates "not signed in" and "not this creator's bracket" into one 404
 *   because it has no other way to represent "unauthenticated" in a Server
 *   Action; a REST endpoint does, so unauthenticated gets its own
 *   documented 401 (`unauthorizedResponse()`) and "not found or not owned"
 *   keeps its own 404 (`NOT_FOUND`) - matching every other creator-scoped
 *   endpoint in this API (spec §4.9) and openapi.yaml's documented response
 *   set for this operation.
 * - Response/error shape: JSON `{ code, message }` (`errorResponse`) and
 *   the published `Bracket` row on success (openapi.yaml: 200,
 *   `#/components/schemas/Bracket`, normalized via `toWireBracket` - issue
 *   #73) instead of `PublishFormState`. The `NOT_DRAFT`/`TOO_FEW_ITEMS`
 *   codes and their exact message strings come straight from
 *   openapi.yaml's documented 409 examples for this operation, and match
 *   `publish-actions.ts`'s own wording verbatim -
 *   `NOT_DRAFT_PUBLISH_MESSAGE` (`@/lib/api/messages`, issue #74) and
 *   `NOT_ENOUGH_ITEMS_ERROR` (`@/lib/bracket/publish-core`) are now the one
 *   shared source for each.
 *
 * Also, deliberately, no `revalidatePath` call (unlike the Server Action) -
 * spec §7.6/§8.3: refetching after a mutation is the new frontend's own
 * concern once split from Next's same-origin cache.
 */

type RouteParams = { params: Promise<{ bracketId: string }> };

async function handlePost(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { bracketId } = await params;

  // Scoped to `id AND creatorId = caller` (spec §4.9) - never `id` alone.
  // Not found *or* not owned both fall through to the same 404, so a
  // non-owner can't learn a bracket with this id exists at all.
  const lookup = await requireOwnedBracket(request, bracketId);
  if (!lookup.ok) {
    return lookup.response;
  }

  const outcome = await publishBracketCore(lookup.bracket);

  if (outcome.kind === "notDraft") {
    // A bracket that exists and is owned but isn't DRAFT is a distinct,
    // non-404 case (spec §4.9) - publish is one-way, so this also covers
    // "already published" for a stale tab / double click / direct
    // re-request.
    return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_PUBLISH_MESSAGE);
  }

  if (outcome.kind === "tooFewItems") {
    return errorResponse(409, "TOO_FEW_ITEMS", NOT_ENOUGH_ITEMS_ERROR);
  }

  // See `toWireBracket`'s own doc comment (issue #73) - this update only
  // touches status/publishedAt, so the column is still null when
  // round-duration has never been PATCHed for this bracket.
  return NextResponse.json(toWireBracket(outcome.bracket));
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
