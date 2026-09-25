import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/api/auth";
import { errorResponse } from "@/lib/api/errors";
import { BRACKET_NOT_FOUND_MESSAGE } from "@/lib/api/messages";

/** The exact row shape `requireOwnedBracket` resolves - inferred from the
 * `prisma.bracket.findFirst` call itself (no `include`/`select`), rather
 * than hardcoding a separate type, so this can never drift from what the
 * query actually returns. */
export type OwnedBracket = NonNullable<
  Awaited<ReturnType<typeof prisma.bracket.findFirst>>
>;

export type OwnedBracketLookup =
  | { ok: true; bracket: OwnedBracket }
  | { ok: false; response: Response };

/**
 * The auth -> ownership-lookup pipeline shared by every creator-only REST
 * endpoint under `/brackets/{bracketId}/...` (issue #72) -
 * `getAuthenticatedUserId` -> `unauthorizedResponse()` if there's no signed-
 * in caller -> `prisma.bracket.findFirst({ id, creatorId })` (never `id`
 * alone) -> `errorResponse(404, "NOT_FOUND", ...)` if it's missing or not
 * owned by the caller. This exact sequence used to be hand-copied into every
 * creator-scoped route; `items/[itemId]/route.ts`'s `requireOwnedDraftItem`
 * already proved this out for its own DRAFT-status + item-lookup pipeline -
 * that helper now layers its extra checks on top of this shared one instead
 * of re-deriving the ownership lookup itself.
 *
 * Per spec §4.9: a missing/invalid bearer token is 401 (checked first, so an
 * anonymous caller never even reaches the ownership lookup); "doesn't
 * exist" and "exists but isn't owned by the caller" are indistinguishable,
 * both the same 404 `NOT_FOUND` (never a 403) - a non-owner can't learn a
 * bracket with this id exists at all.
 */
export async function requireOwnedBracket(
  request: Request,
  bracketId: string
): Promise<OwnedBracketLookup> {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return { ok: false, response: unauthorizedResponse() };
  }

  const bracket = await prisma.bracket.findFirst({
    where: { id: bracketId, creatorId: userId },
  });

  if (!bracket) {
    return {
      ok: false,
      response: errorResponse(404, "NOT_FOUND", BRACKET_NOT_FOUND_MESSAGE),
    };
  }

  return { ok: true, bracket };
}
