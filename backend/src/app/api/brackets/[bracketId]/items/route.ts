import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedBracket } from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { NOT_DRAFT_ITEMS_MESSAGE } from "@/lib/api/messages";
import { validateBracketItemForm } from "@/app/dashboard/brackets/[id]/edit/validation";
import { uploadBracketItemImage } from "@/app/dashboard/brackets/[id]/edit/image-upload";

// GET /brackets/{bracketId}/items (issue #51, docs/openapi.yaml's
// listBracketItems)
//
// Creator-only - wraps the same ownership-scoped lookup and items query
// `src/app/dashboard/brackets/[id]/edit/page.tsx` (#11) already runs:
// `prisma.bracket.findFirst({ where: { id, creatorId } })` (never `id`
// alone, via the shared `requireOwnedBracket` - issue #72), then
// `prisma.bracketItem.findMany` scoped to that bracket's id, newest-item-
// last (`createdAt: "asc"`, i.e. creation order).
//
// Per spec §4.9's authorization pattern: not found *and* not-owned are
// indistinguishable, both 404 via the same `NOT_FOUND` body - never a 403,
// so a non-owner can't learn a bracket with this id exists at all. A
// missing/invalid bearer token is the separate 401 case, checked first
// (inside `requireOwnedBracket`) so an anonymous caller never even reaches
// the ownership lookup.
//
// POST /brackets/{bracketId}/items (issue #52, docs/openapi.yaml's
// addBracketItem) lands below GET in this same file, matching #51's plan.
//
// Wraps the exact same logic `src/app/dashboard/brackets/[id]/edit/
// actions.ts`'s `addItem` Server Action already uses - the same
// ownership+DRAFT-gated lookup order, the same `validateBracketItemForm`
// (`../../../../dashboard/brackets/[id]/edit/validation.ts`, #11/#12) for
// title/description/image rules, and the same `uploadBracketItemImage`
// (`.../image-upload.ts`, #12) for the Storage upload - never re-derived,
// so the validation rules, exact error strings (spec §4.8), and the
// service-role-key usage all stay identical between the Server Action and
// this endpoint. Only the request/response shape differs: a Route
// Handler's `Request`/`Response` here instead of a Server Action's
// `FormData`/`ItemFormState`, and a JSON `Error` body (`@/lib/api/errors`)
// instead of `{ error }`.
//
// Order of checks mirrors `addItem` exactly: auth (401) -> ownership (404,
// indistinguishable from not-found per spec §4.9) -> DRAFT status (409,
// `NOT_DRAFT`) -> form validation (400) -> image upload, if any (502,
// `IMAGE_UPLOAD_FAILED`, per openapi.yaml) -> create.

const IMAGE_UPLOAD_ERROR = "Failed to upload the image. Please try again.";

type RouteParams = { params: Promise<{ bracketId: string }> };

export const GET = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId } = await params;

    const lookup = await requireOwnedBracket(request, bracketId);
    if (!lookup.ok) {
      return lookup.response;
    }

    const items = await prisma.bracketItem.findMany({
      where: { bracketId: lookup.bracket.id },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(items);
  })();

  return withCors(request, response);
};

export const POST = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId } = await params;

    const lookup = await requireOwnedBracket(request, bracketId);
    if (!lookup.ok) {
      return lookup.response;
    }
    const { bracket } = lookup;

    if (bracket.status !== "DRAFT") {
      return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ITEMS_MESSAGE);
    }

    const formData = await request.formData();
    const validated = validateBracketItemForm(formData);
    if (!validated.ok) {
      return errorResponse(400, "VALIDATION_ERROR", validated.error);
    }

    // Mirrors `addItem`: only a validated, non-null `image` triggers an
    // upload; a bad title never reaches this (validation ran first), so a
    // rejected title can never trigger a needless upload either.
    let imageUrl: string | null = null;
    if (validated.data.image) {
      try {
        imageUrl = await uploadBracketItemImage(
          bracket.id,
          validated.data.image
        );
      } catch {
        return errorResponse(502, "IMAGE_UPLOAD_FAILED", IMAGE_UPLOAD_ERROR);
      }
    }

    const item = await prisma.bracketItem.create({
      data: {
        bracketId: bracket.id,
        title: validated.data.title,
        description: validated.data.description,
        imageUrl,
      },
    });

    return NextResponse.json(item, { status: 201 });
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
