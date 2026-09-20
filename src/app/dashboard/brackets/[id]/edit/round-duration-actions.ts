"use server";

import { notFound, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  computeTotalRounds,
  serializeRoundDurationOverrides,
  validateRoundDurationForm,
} from "./round-duration";

/**
 * Server Action backing the round-duration form on a draft bracket's edit
 * page (issue #13). `./round-duration.ts` has the pure
 * validation/round-count logic; this wraps it with the actual
 * `prisma.bracket`/`prisma.bracketItem` calls, following the same
 * shape/signature as `./actions.ts` (issue #11) - see that file for the
 * fuller rationale on the `useActionState` `prevState` signature and the
 * Next.js Server Actions security guide
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`).
 *
 * This intentionally does not import from `./actions.ts` (and vice versa):
 * #12 and #14 are concurrently changing that file and `./page.tsx` on their
 * own branches for this same edit page, so this issue's logic lives in its
 * own files to keep the three changesets easy to reconcile, at the cost of
 * a small duplicated `requireOwnedBracket` lookup.
 *
 * Every action re-derives the signed-in creator from the session and looks
 * the `Bracket` up scoped to `id` + `creatorId`, never trusting a
 * `bracketId` argument alone - a bracket that doesn't exist, or isn't this
 * creator's, 404s. `bracket.status !== "DRAFT"` is a distinct, non-404 case
 * (round durations lock once the bracket has started - see the issue's
 * "Out of scope" list) so it returns a normal validation-style error
 * instead.
 *
 * The live `BracketItem` count (not anything trusted from the client) is
 * what derives `totalRounds` here, so a stale form (opened before items
 * were added/removed) can't smuggle in an override for a round number that
 * no longer makes sense - `validateRoundDurationForm` simply never reads a
 * field beyond the server's own freshly-computed `totalRounds`.
 */
export type RoundDurationFormState = { error: string | null };

const NOT_DRAFT_ERROR =
  "This bracket is no longer a draft, so its round durations can't be changed.";

// Issue #36: a generic, user-facing fallback for a DB failure that isn't one
// of the specific errors above - e.g. the database being temporarily
// unreachable. Rendered inline by `./round-duration-form.tsx` the same way
// as any other `state.error`, rather than letting the exception propagate
// into Next's generic error boundary/blank page.
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

export async function updateRoundDuration(
  bracketId: string,
  _prevState: RoundDurationFormState,
  formData: FormData
): Promise<RoundDurationFormState> {
  try {
    const bracket = await requireOwnedBracket(bracketId);

    if (bracket.status !== "DRAFT") {
      return { error: NOT_DRAFT_ERROR };
    }

    const itemCount = await prisma.bracketItem.count({
      where: { bracketId: bracket.id },
    });
    const totalRounds = computeTotalRounds(itemCount);

    const validated = validateRoundDurationForm(formData, totalRounds);
    if (!validated.ok) {
      return { error: validated.error };
    }

    await prisma.bracket.update({
      where: { id: bracket.id },
      data: {
        defaultRoundDurationMinutes: validated.data.defaultRoundDurationMinutes,
        roundDurationOverrides: serializeRoundDurationOverrides(
          validated.data.overrides
        ),
      },
    });

    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}
