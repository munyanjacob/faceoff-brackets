import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId } from "@/lib/api/auth";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";

// GET /brackets/{bracketId} (issue #51, docs/openapi.yaml's getBracket)
//
// Public - no authentication required (openapi.yaml's `security` lists
// `bearerAuth` as *optional* here: `[{bearerAuth: []}, {}]`). Looked up by
// `id` alone (never scoped to a caller's `creatorId`, unlike the
// creator-only endpoints in this same issue) - per spec: "private brackets
// are reachable by anyone with the id (link-based privacy per the product
// rules), the creator's identity is not otherwise checked here."
//
// `getAuthenticatedUserId` is still called - it just never gates the
// response the way it does on `/brackets/mine` or
// `/brackets/{bracketId}/items`. When it resolves to this bracket's own
// creator, `viewerIsOwner` is `true`; for every other caller (anonymous, or
// signed in as someone else), it's `false`. `creator.displayName` is always
// included - it's already public information (the same `creatorName` the
// `/discover` endpoint exposes), not something that needs hiding from a
// non-owner.
//
// Never includes the raw item list (`BracketItem[]`) - openapi.yaml is
// explicit that's `GET /brackets/{bracketId}/items` (owner-only)'s job, not
// this endpoint's.

type RouteParams = { params: Promise<{ bracketId: string }> };

export const GET = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId } = await params;

    const bracket = await prisma.bracket.findUnique({
      where: { id: bracketId },
      include: { creator: { select: { displayName: true } } },
    });

    if (!bracket) {
      return errorResponse(
        404,
        "NOT_FOUND",
        "This bracket no longer exists."
      );
    }

    const viewerUserId = await getAuthenticatedUserId(request);
    const viewerIsOwner =
      viewerUserId !== null && viewerUserId === bracket.creatorId;

    return NextResponse.json({ ...bracket, viewerIsOwner });
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
