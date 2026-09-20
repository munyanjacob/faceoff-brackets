"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { validateCreateBracketForm } from "./validation";

/**
 * Server Action backing the "create bracket" form (issue #10), invoked via
 * `useActionState` from `./new-bracket-form.tsx` - see the Next.js "Form
 * validation"/"Validation errors" guide
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md`) for why the
 * signature takes a leading `prevState` argument.
 */
export type CreateBracketState = {
  error: string | null;
};

export const initialCreateBracketState: CreateBracketState = { error: null };

// #13/#14 let the creator configure round durations explicitly; until then,
// `defaultRoundDurationMinutes` (NOT NULL, no column default - see
// `prisma/schema.prisma`) needs *something* to hold, so every draft created
// here gets this same placeholder. Not exposed in the form: out of scope
// for #10 per the issue's "Out of scope" list.
const PLACEHOLDER_DEFAULT_ROUND_DURATION_MINUTES = 60;

// Issue #36: a generic, user-facing fallback for a DB/Supabase failure that
// isn't one of the validation errors above - e.g. the database being
// temporarily unreachable. Rendered inline by `./new-bracket-form.tsx` the
// same way as any other `state.error`, rather than letting the exception
// propagate into Next's generic error boundary/blank page.
const UNEXPECTED_ERROR = "Something went wrong. Please try again.";

export async function createBracket(
  _prevState: CreateBracketState,
  formData: FormData
): Promise<CreateBracketState> {
  // Defensive re-check even though `/dashboard/**` is already gated by
  // `src/app/dashboard/layout.tsx` - a Server Action is its own POST
  // endpoint and must not trust that the request came through the gated
  // page (see the Next.js Server Actions security guide).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const validated = validateCreateBracketForm(formData);
  if (!validated.ok) {
    return { error: validated.error };
  }

  let bracket: { id: string };
  try {
    bracket = await prisma.bracket.create({
      data: {
        creatorId: user.id,
        title: validated.data.title,
        description: validated.data.description,
        visibility: validated.data.visibility,
        votingRequirement: validated.data.votingRequirement,
        defaultRoundDurationMinutes:
          PLACEHOLDER_DEFAULT_ROUND_DURATION_MINUTES,
        status: "DRAFT",
      },
    });
  } catch (err) {
    // `redirect()`/`notFound()` throw internally too (see below), but
    // neither is ever thrown from inside this specific `try` - only real
    // unexpected failures (e.g. the database being unreachable) land here.
    // `unstable_rethrow` is still the right guard (matches every other
    // Server Action's try/catch in this issue's changes) in case Prisma
    // itself ever wraps/re-throws one of those framework errors.
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }

  // Deliberately outside any try/catch: redirect() works by throwing, and a
  // surrounding catch would swallow the navigation (same reasoning as
  // `src/app/dashboard/actions.ts`'s `logout`).
  redirect(`/dashboard/brackets/${bracket.id}/edit`);
}
