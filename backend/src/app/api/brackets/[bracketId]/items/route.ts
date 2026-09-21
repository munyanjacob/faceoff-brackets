import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/api/auth";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";

// GET /brackets/{bracketId}/items (issue #51, docs/openapi.yaml's
// listBracketItems)
//
// Creator-only - wraps the same ownership-scoped lookup and items query
// `src/app/dashboard/brackets/[id]/edit/page.tsx` (#11) already runs:
// `prisma.bracket.findFirst({ where: { id, creatorId } })` (never `id`
// alone), then `prisma.bracketItem.findMany` scoped to that bracket's id,
// newest-item-last (`createdAt: "asc"`, i.e. creation order).
//
// Per spec §4.9's authorization pattern: not found *and* not-owned are
// indistinguishable, both 404 via the same `NOT_FOUND` body - never a 403,
// so a non-owner can't learn a bracket with this id exists at all. A
// missing/invalid bearer token is the separate 401 case
// (`unauthorizedResponse()`), checked first so an anonymous caller never
// even reaches the ownership lookup.
//
// POST (add item, #52) lands in this same file later - out of scope here
// per issue #51's "Out of scope" list.

type RouteParams = { params: Promise<{ bracketId: string }> };

export const GET = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return unauthorizedResponse();
    }

    const { bracketId } = await params;

    const bracket = await prisma.bracket.findFirst({
      where: { id: bracketId, creatorId: userId },
    });

    if (!bracket) {
      return errorResponse(
        404,
        "NOT_FOUND",
        "This bracket no longer exists."
      );
    }

    const items = await prisma.bracketItem.findMany({
      where: { bracketId: bracket.id },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(items);
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
