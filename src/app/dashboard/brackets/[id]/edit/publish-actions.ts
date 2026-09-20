"use server";

import { notFound, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { buildRoundOnePlan } from "@/lib/bracket/build-round-one";
import { parseStoredRoundDurationOverrides } from "./round-duration";

/**
 * The "Publish" Server Action on a draft bracket's edit page (issue #16,
 * extended by #18). Locks the bracket in: flips `Bracket.status` from
 * `DRAFT` to `ACTIVE` (an immediate start, per #14) or `SCHEDULED` (a future
 * `scheduledStartAt` was chosen), stamps `Bracket.publishedAt` with the
 * current time, and - per #18 - creates round 1's `Round` and `Matchup` rows
 * from the bracket's current items in the same operation.
 *
 * Deliberately does not import from `./actions.ts` or
 * `./scheduled-start-actions.ts` (and vice versa) - same reasoning those
 * files already give: each issue's logic lives in its own file so the
 * changesets stay easy to reconcile, at the cost of a small duplicated
 * `requireOwnedBracket` lookup. `./round-duration.ts`'s pure
 * `parseStoredRoundDurationOverrides` (#13) is imported read-only, the same
 * way `./page.tsx` already does, rather than duplicating that parsing here.
 *
 * Every action re-derives the signed-in creator from the session and looks
 * the `Bracket` up scoped to `id` + `creatorId`, never trusting a
 * `bracketId` argument alone - a bracket that doesn't exist, or isn't this
 * creator's, 404s the same way `./page.tsx`/`./actions.ts` do.
 *
 * `bracket.status !== "DRAFT"` is a distinct, non-404 case, and doubles as
 * this issue's "no unpublish" rule: since publishing is the only thing that
 * ever moves a bracket off `DRAFT`, once it has happened once, calling this
 * action again (a stale tab, a direct re-request, or a double click) can
 * only ever find a non-DRAFT bracket and returns a normal validation-style
 * error rather than re-publishing, resetting `publishedAt`, or erroring
 * ungracefully - there is no code path anywhere that moves a bracket back to
 * `DRAFT`.
 *
 * Publishing with fewer than 2 items is blocked here too (not just by hiding
 * the button in `./publish-form.tsx`/`./page.tsx`) with a clear, normal
 * validation-style error - per the issue's "not just a hidden button"
 * framing for #11's item actions, this action re-checks its own
 * precondition independently of whatever the UI happened to render. This
 * also guarantees `buildRoundOnePlan`/`generateFirstRound` (#17) are never
 * called with fewer than 2 items.
 *
 * The items feeding `generateFirstRound` are fetched in the exact same
 * order `./page.tsx` fetches them for `BracketStructurePreview` (#15) -
 * `orderBy: { createdAt: "asc" }` - so publish can never produce different
 * pairings than whatever the preview last showed for this item list (#18's
 * "querying the database after publish shows the same pairings the preview
 * displayed" criterion).
 *
 * The `Bracket.status`/`publishedAt` update and the `Round`+`Matchup`
 * creation happen inside one `prisma.$transaction` so a bracket can never be
 * left `ACTIVE`/`SCHEDULED` with no `Round` row if something fails partway
 * (e.g. the round/matchup insert erroring after the bracket update already
 * landed).
 */
export type PublishFormState = { error: string | null };

export const initialPublishFormState: PublishFormState = { error: null };

const NOT_DRAFT_ERROR = "This bracket has already been published.";

const NOT_ENOUGH_ITEMS_ERROR =
  "Add at least 2 items before publishing this bracket.";

const MINIMUM_ITEM_COUNT = 2;

// Issue #36: a generic, user-facing fallback for a DB failure that isn't one
// of the specific errors above - e.g. the database being temporarily
// unreachable. Rendered inline by `./publish-form.tsx` the same way as any
// other `state.error`, rather than letting the exception propagate into
// Next's generic error boundary/blank page.
const UNEXPECTED_ERROR = "Something went wrong. Please try again.";

async function requireOwnedBracket(bracketId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    notFound();
  }

  const bracket = await prisma.bracket.findFirst({
    where: { id: bracketId, creatorId: user.id },
  });

  if (!bracket) {
    notFound();
  }

  return bracket;
}

export async function publishBracket(
  bracketId: string,
  _prevState: PublishFormState,
  _formData: FormData
): Promise<PublishFormState> {
  try {
    const bracket = await requireOwnedBracket(bracketId);

    if (bracket.status !== "DRAFT") {
      return { error: NOT_DRAFT_ERROR };
    }

    const itemCount = await prisma.bracketItem.count({
      where: { bracketId: bracket.id },
    });

    if (itemCount < MINIMUM_ITEM_COUNT) {
      return { error: NOT_ENOUGH_ITEMS_ERROR };
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
    const durationMinutes =
      overrides[1] ?? bracket.defaultRoundDurationMinutes;

    const roundPlan = buildRoundOnePlan(items, {
      durationMinutes,
      immediateStart,
      now: publishedAt,
    });

    await prisma.$transaction(async (tx) => {
      await tx.bracket.update({
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
    });

    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}
