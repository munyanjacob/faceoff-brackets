"use server";

import { notFound, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { NOT_DRAFT_PUBLISH_MESSAGE } from "@/lib/api/messages";
import {
  publishBracketCore,
  NOT_ENOUGH_ITEMS_ERROR,
} from "@/lib/bracket/publish-core";

/**
 * The "Publish" Server Action on a draft bracket's edit page (issue #16,
 * extended by #18).
 *
 * A thin adapter (issue #77) over `@/lib/bracket/publish-core.ts`'s
 * `publishBracketCore`, which owns the actual ownership-gated DRAFT/
 * item-count/transaction rules shared with this action's REST sibling,
 * `../../../../api/brackets/[bracketId]/publish/route.ts`. This file's only
 * remaining jobs: re-derive the signed-in creator from the cookie-bound
 * Supabase session and look the `Bracket` up scoped to `id` + `creatorId`
 * (never trusting a `bracketId` argument alone - a bracket that doesn't
 * exist, or isn't this creator's, 404s via `notFound()`), and translate
 * `publishBracketCore`'s outcome into `PublishFormState` plus this entry
 * point's own `revalidatePath` side effect.
 *
 * Deliberately does not import from `./actions.ts` or
 * `./scheduled-start-actions.ts` (and vice versa) - same reasoning those
 * files already give: each issue's logic lives in its own file so the
 * changesets stay easy to reconcile, at the cost of a small duplicated
 * `requireOwnedBracket` lookup.
 */
export type PublishFormState = { error: string | null };

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
    const outcome = await publishBracketCore(bracket);

    if (outcome.kind === "notDraft") {
      return { error: NOT_DRAFT_PUBLISH_MESSAGE };
    }

    if (outcome.kind === "tooFewItems") {
      return { error: NOT_ENOUGH_ITEMS_ERROR };
    }

    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}
