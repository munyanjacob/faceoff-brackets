"use server";

import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

/**
 * The "Publish" Server Action on a draft bracket's edit page (issue #16).
 * Locks the bracket in: flips `Bracket.status` from `DRAFT` to `ACTIVE` (an
 * immediate start, per #14) or `SCHEDULED` (a future `scheduledStartAt` was
 * chosen), and stamps `Bracket.publishedAt` with the current time.
 *
 * Deliberately does not import from `./actions.ts` or
 * `./scheduled-start-actions.ts` (and vice versa) - same reasoning those
 * files already give: each issue's logic lives in its own file so the
 * changesets stay easy to reconcile, at the cost of a small duplicated
 * `requireOwnedBracket` lookup.
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
 * precondition independently of whatever the UI happened to render.
 *
 * Does NOT create any `Round`/`Matchup` rows - that is explicitly out of
 * scope for this issue (#18).
 */
export type PublishFormState = { error: string | null };

export const initialPublishFormState: PublishFormState = { error: null };

const NOT_DRAFT_ERROR = "This bracket has already been published.";

const NOT_ENOUGH_ITEMS_ERROR =
  "Add at least 2 items before publishing this bracket.";

const MINIMUM_ITEM_COUNT = 2;

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

  await prisma.bracket.update({
    where: { id: bracket.id },
    data: { status, publishedAt: new Date() },
  });

  revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
  return { error: null };
}
