import { prisma } from "@/lib/prisma";
import { buildRoundOnePlan } from "@/lib/bracket/build-round-one";
import { parseStoredRoundDurationOverrides } from "@/app/dashboard/brackets/[id]/edit/round-duration";

/**
 * The "Publish" business rules (issue #16, extended by #18/#54) shared
 * between `../../app/dashboard/brackets/[id]/edit/publish-actions.ts`'s
 * `publishBracket` Server Action and `../../app/api/brackets/[bracketId]/
 * publish/route.ts`'s REST route handler (issue #77) - previously the
 * ownership/DRAFT/item-count/transaction logic was re-derived in both.
 *
 * Takes the already ownership-looked-up `Bracket` row - each entry point
 * still owns its own auth/ownership lookup (the Server Action's
 * `notFound()`-throwing local `requireOwnedBracket`, sharing that pattern
 * with its sibling Server Action files by design; the REST route's shared
 * `@/lib/api/require-owned-bracket`, issue #72) since those genuinely
 * differ in identity source and control flow (thrown navigation vs. a
 * returned `Response`) per spec §6/§4.9 - not a business rule this module
 * needs to own.
 */

/** The row shape `publishBracketCore` needs - inferred from
 * `prisma.bracket.findFirst`'s own return type (no `select`/`include`),
 * the same pattern `@/lib/api/require-owned-bracket`'s `OwnedBracket` uses,
 * so this can never drift from what either entry point's ownership lookup
 * actually returns. */
export type PublishableBracket = NonNullable<
  Awaited<ReturnType<typeof prisma.bracket.findFirst>>
>;

export const MINIMUM_ITEM_COUNT = 2;

export const NOT_ENOUGH_ITEMS_ERROR =
  "Add at least 2 items before publishing this bracket.";

export type PublishBracketOutcome =
  | { kind: "notDraft" }
  | { kind: "tooFewItems" }
  | { kind: "published"; bracket: PublishableBracket };

/**
 * Flips `bracket.status` from `DRAFT` to `ACTIVE` (an immediate start) or
 * `SCHEDULED` (a future `scheduledStartAt` was chosen), stamps
 * `publishedAt`, and creates round 1's `Round`+`Matchup` rows from the
 * bracket's current items, all inside one `prisma.$transaction` - so a
 * bracket can never be left `ACTIVE`/`SCHEDULED` with no `Round` row if
 * something fails partway.
 *
 * `bracket.status !== "DRAFT"` is a distinct, non-404/non-throw case, and
 * doubles as "no unpublish": since publishing is the only thing that ever
 * moves a bracket off `DRAFT`, calling this again (a stale tab, a direct
 * re-request, a double click) can only ever find a non-DRAFT bracket.
 *
 * Publishing with fewer than `MINIMUM_ITEM_COUNT` items is blocked here
 * too (not just by hiding the button in the UI) - this also guarantees
 * `buildRoundOnePlan`/`generateFirstRound` (#17) are never called with too
 * few items.
 *
 * Items feeding `generateFirstRound` are fetched in the exact same order
 * the edit page's preview reads them - `orderBy: { createdAt: "asc" }` -
 * so publish can never produce different pairings than whatever the
 * preview last showed for this item list.
 */
export async function publishBracketCore(
  bracket: PublishableBracket
): Promise<PublishBracketOutcome> {
  if (bracket.status !== "DRAFT") {
    return { kind: "notDraft" };
  }

  const itemCount = await prisma.bracketItem.count({
    where: { bracketId: bracket.id },
  });

  if (itemCount < MINIMUM_ITEM_COUNT) {
    return { kind: "tooFewItems" };
  }

  const status = bracket.scheduledStartAt ? "SCHEDULED" : "ACTIVE";
  const immediateStart = status === "ACTIVE";
  const publishedAt = new Date();

  const items = await prisma.bracketItem.findMany({
    where: { bracketId: bracket.id },
    orderBy: { createdAt: "asc" },
  });

  const overrides = parseStoredRoundDurationOverrides(
    bracket.roundDurationOverrides
  );
  const durationMinutes = overrides[1] ?? bracket.defaultRoundDurationMinutes;

  const roundPlan = buildRoundOnePlan(items, {
    durationMinutes,
    immediateStart,
    now: publishedAt,
  });

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

  return { kind: "published", bracket: updatedBracket };
}
