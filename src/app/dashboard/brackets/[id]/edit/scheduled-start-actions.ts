"use server";

import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { validateScheduledStartForm } from "./scheduled-start";

/**
 * Server Action backing the "start immediately vs. scheduled" form on a
 * draft bracket's edit page (issue #14). `./scheduled-start.ts` has the
 * pure validation logic; this wraps it with the actual `prisma.bracket`
 * call, following the same shape/signature as `./round-duration-actions.ts`
 * (issue #13) - see that file for the fuller rationale on the
 * `useActionState` `prevState` signature and the Next.js Server Actions
 * security guide (`node_modules/next/dist/docs/01-app/02-guides/server-
 * actions.md`).
 *
 * This intentionally does not import from `./actions.ts` or
 * `./round-duration-actions.ts` (and vice versa): #12 and #13 touch this
 * same edit page on their own branches, so this issue's logic lives in its
 * own files to keep the changesets easy to reconcile, at the cost of a
 * small duplicated `requireOwnedBracket` lookup - same tradeoff
 * `./round-duration-actions.ts` already made.
 *
 * Every action re-derives the signed-in creator from the session and looks
 * the `Bracket` up scoped to `id` + `creatorId`, never trusting a
 * `bracketId` argument alone - a bracket that doesn't exist, or isn't this
 * creator's, 404s. `bracket.status !== "DRAFT"` is a distinct, non-404 case
 * (the start time locks once the bracket has started/published, the same
 * reasoning `./round-duration-actions.ts` uses) so it returns a normal
 * validation-style error instead.
 *
 * "Future" is judged against `new Date()` read here, at submission time on
 * the server - never anything trusted from the client - per the issue.
 */
export type ScheduledStartFormState = { error: string | null };

export const initialScheduledStartFormState: ScheduledStartFormState = {
  error: null,
};

const NOT_DRAFT_ERROR =
  "This bracket is no longer a draft, so its start time can't be changed.";

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

export async function updateScheduledStart(
  bracketId: string,
  _prevState: ScheduledStartFormState,
  formData: FormData
): Promise<ScheduledStartFormState> {
  const bracket = await requireOwnedBracket(bracketId);

  if (bracket.status !== "DRAFT") {
    return { error: NOT_DRAFT_ERROR };
  }

  const validated = validateScheduledStartForm(formData, new Date());
  if (!validated.ok) {
    return { error: validated.error };
  }

  await prisma.bracket.update({
    where: { id: bracket.id },
    data: { scheduledStartAt: validated.data.scheduledStartAt },
  });

  revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
  return { error: null };
}
