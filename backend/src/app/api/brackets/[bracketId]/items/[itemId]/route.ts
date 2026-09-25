import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireOwnedBracket,
  type OwnedBracket,
} from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import {
  ITEM_NOT_FOUND_MESSAGE,
  NOT_DRAFT_ITEMS_MESSAGE,
} from "@/lib/api/messages";
import { validateBracketItemForm } from "@/app/dashboard/brackets/[id]/edit/validation";
import { uploadBracketItemImage } from "@/app/dashboard/brackets/[id]/edit/image-upload";

// PATCH/DELETE /brackets/{bracketId}/items/{itemId} (issue #52,
// docs/openapi.yaml's updateBracketItem/removeBracketItem).
//
// Wraps the exact same logic `src/app/dashboard/brackets/[id]/edit/
// actions.ts`'s `updateItem`/`removeItem` Server Actions already use - the
// same ownership+DRAFT-gated lookup order (with the item lookup additionally
// scoped to `bracketId`, so an item id can never be reused across a
// different bracket, even one owned by the same creator - spec §4.9's last
// sentence), the same `validateBracketItemForm`
// (`../../../../../dashboard/brackets/[id]/edit/validation.ts`, #11/#12) for
// `PATCH`'s title/description/image rules, and the same
// `uploadBracketItemImage` (`.../image-upload.ts`, #12) for a replacement
// image's Storage upload - never re-derived, so validation rules, exact
// error strings (spec §4.8), and the service-role-key usage all stay
// identical between the Server Actions and these endpoints. Only the
// request/response shape differs: a Route Handler's `Request`/`Response`
// here instead of a Server Action's `FormData`/`ItemFormState`, and a JSON
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
// existing image") - `updateItem`'s own comment explains why: `imageUrl`
// stays `undefined` when no file was chosen, so the conditional spread onto
// Prisma's `data` omits the key entirely rather than ever passing `null`/
// clearing it.

const IMAGE_UPLOAD_ERROR = "Failed to upload the image. Please try again.";

type RouteParams = { params: Promise<{ bracketId: string; itemId: string }> };

type OwnedDraftItemLookup =
  | {
      ok: true;
      bracket: OwnedBracket;
      item: { id: string; imageUrl: string | null };
    }
  | { ok: false; response: Response };

/**
 * The ownership -> DRAFT-status -> item-lookup pipeline shared by `PATCH`
 * and `DELETE` below, in the same order
 * `src/app/dashboard/brackets/[id]/edit/actions.ts`'s `updateItem`/
 * `removeItem` already use. Layers the DRAFT-status check and the item
 * lookup on top of the shared `requireOwnedBracket` (issue #72), which
 * already covers the auth -> ownership part of this same pipeline.
 */
async function requireOwnedDraftItem(
  request: Request,
  bracketId: string,
  itemId: string
): Promise<OwnedDraftItemLookup> {
  const bracketLookup = await requireOwnedBracket(request, bracketId);
  if (!bracketLookup.ok) {
    return bracketLookup;
  }
  const { bracket } = bracketLookup;

  if (bracket.status !== "DRAFT") {
    return {
      ok: false,
      response: errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ITEMS_MESSAGE),
    };
  }

  const item = await prisma.bracketItem.findFirst({
    where: { id: itemId, bracketId: bracket.id },
  });

  if (!item) {
    return {
      ok: false,
      response: errorResponse(404, "NOT_FOUND", ITEM_NOT_FOUND_MESSAGE),
    };
  }

  return { ok: true, bracket, item };
}

export const PATCH = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId, itemId } = await params;

    const lookup = await requireOwnedDraftItem(request, bracketId, itemId);
    if (!lookup.ok) {
      return lookup.response;
    }

    const formData = await request.formData();
    const validated = validateBracketItemForm(formData);
    if (!validated.ok) {
      return errorResponse(400, "VALIDATION_ERROR", validated.error);
    }

    // No new file was chosen: `imageUrl` stays `undefined`, so the spread
    // below omits the key entirely and Prisma leaves the existing
    // `image_url` untouched - see `updateItem`'s identical comment.
    let imageUrl: string | undefined;
    if (validated.data.image) {
      try {
        imageUrl = await uploadBracketItemImage(
          lookup.bracket.id,
          validated.data.image
        );
      } catch {
        return errorResponse(502, "IMAGE_UPLOAD_FAILED", IMAGE_UPLOAD_ERROR);
      }
    }

    const updated = await prisma.bracketItem.update({
      where: { id: lookup.item.id },
      data: {
        title: validated.data.title,
        description: validated.data.description,
        ...(imageUrl ? { imageUrl } : {}),
      },
    });

    return NextResponse.json(updated);
  })();

  return withCors(request, response);
};

export const DELETE = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId, itemId } = await params;

    const lookup = await requireOwnedDraftItem(request, bracketId, itemId);
    if (!lookup.ok) {
      return lookup.response;
    }

    await prisma.bracketItem.delete({ where: { id: lookup.item.id } });

    return new NextResponse(null, { status: 204 });
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
