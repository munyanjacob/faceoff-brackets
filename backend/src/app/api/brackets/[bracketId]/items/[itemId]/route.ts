import { NextResponse } from "next/server";
import { requireOwnedBracket } from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import {
  ITEM_NOT_FOUND_MESSAGE,
  NOT_DRAFT_ITEMS_MESSAGE,
} from "@/lib/api/messages";
import {
  updateBracketItemCore,
  removeBracketItemCore,
  IMAGE_UPLOAD_ERROR,
} from "@/lib/bracket/items-core";

// PATCH/DELETE /brackets/{bracketId}/items/{itemId} (issue #52,
// docs/openapi.yaml's updateBracketItem/removeBracketItem).
//
// Thin adapters (issue #77) over `@/lib/bracket/items-core.ts`'s
// `updateBracketItemCore`/`removeBracketItemCore`, which own the actual
// ownership+DRAFT-gated item lookup, validation, image-upload, and
// persistence logic shared with
// `src/app/dashboard/brackets/[id]/edit/actions.ts`'s `updateItem`/
// `removeItem` Server Actions - so validation rules, exact error strings
// (spec §4.8), and the service-role-key Storage upload all stay identical
// between the Server Actions and these endpoints. Only the request/
// response shape differs: a Route Handler's `Request`/`Response` here
// instead of a Server Action's `FormData`/`ItemFormState`, and a JSON
// `Error` body (`@/lib/api/errors`) instead of `{ error }` / `notFound()`.
//
// Order of checks mirrors `updateItem`/`removeItem` exactly: auth (401) ->
// bracket ownership (404, indistinguishable from not-found per spec §4.9,
// via the shared `requireOwnedBracket` - issue #72) -> DRAFT status (409,
// `NOT_DRAFT`) -> item lookup scoped to bracketId (404) -> (PATCH only) form
// validation (400) -> (PATCH only) image upload, if any (502,
// `IMAGE_UPLOAD_FAILED`) -> mutate.
//
// PATCH without a new `image` field leaves `imageUrl` completely untouched
// (openapi.yaml: "Omit the `image` field entirely to keep the item's
// existing image") - see `items-core.ts`'s `updateBracketItemCore` doc
// comment for why.

type RouteParams = { params: Promise<{ bracketId: string; itemId: string }> };

export const PATCH = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId, itemId } = await params;

    const lookup = await requireOwnedBracket(request, bracketId);
    if (!lookup.ok) {
      return lookup.response;
    }

    const formData = await request.formData();
    const outcome = await updateBracketItemCore(lookup.bracket, itemId, formData);

    switch (outcome.kind) {
      case "notDraft":
        return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ITEMS_MESSAGE);
      case "itemNotFound":
        return errorResponse(404, "NOT_FOUND", ITEM_NOT_FOUND_MESSAGE);
      case "validationError":
        return errorResponse(400, "VALIDATION_ERROR", outcome.message);
      case "imageUploadFailed":
        return errorResponse(502, "IMAGE_UPLOAD_FAILED", IMAGE_UPLOAD_ERROR);
      case "updated":
        return NextResponse.json(outcome.item);
    }
  })();

  return withCors(request, response);
};

export const DELETE = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId, itemId } = await params;

    const lookup = await requireOwnedBracket(request, bracketId);
    if (!lookup.ok) {
      return lookup.response;
    }

    const outcome = await removeBracketItemCore(lookup.bracket, itemId);

    switch (outcome.kind) {
      case "notDraft":
        return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ITEMS_MESSAGE);
      case "itemNotFound":
        return errorResponse(404, "NOT_FOUND", ITEM_NOT_FOUND_MESSAGE);
      case "removed":
        return new NextResponse(null, { status: 204 });
    }
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
