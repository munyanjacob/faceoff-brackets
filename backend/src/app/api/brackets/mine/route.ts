import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/api/auth";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { withErrorHandling } from "@/lib/api/errors";
import { parseStoredRoundDurationOverrides } from "@/app/dashboard/brackets/[id]/edit/round-duration";

// GET /brackets/mine (issue #51, docs/openapi.yaml's listMyBrackets)
//
// The authenticated creator's own brackets, newest first, each with a
// minimal `rounds: [{roundNumber}]` summary - the exact same query
// `src/app/dashboard/page.tsx` (#8) already runs for the dashboard's
// Server Component, just returned as JSON instead of rendered. `rounds` is
// selected down to `roundNumber` only (never the full relation), matching
// `BracketWithRounds`'s schema and `page.tsx`'s own comment on why only
// that field is needed.
//
// `bearerAuth` only (no anonymous variant) per docs/openapi.yaml - this is
// creator-owned resource management (spec §7.2), not a public read.

export const GET = async (request: Request): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return unauthorizedResponse();
    }

    const brackets = await prisma.bracket.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: "desc" },
      include: { rounds: { select: { roundNumber: true } } },
    });

    return NextResponse.json(
      brackets.map((bracket) => ({
        ...bracket,
        // See brackets/[bracketId]/route.ts's identical normalization.
        roundDurationOverrides: parseStoredRoundDurationOverrides(
          bracket.roundDurationOverrides
        ),
      }))
    );
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
