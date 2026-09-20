"use server";

import { redirect } from "next/navigation";
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

  const bracket = await prisma.bracket.create({
    data: {
      creatorId: user.id,
      title: validated.data.title,
      description: validated.data.description,
      visibility: validated.data.visibility,
      votingRequirement: validated.data.votingRequirement,
      defaultRoundDurationMinutes: PLACEHOLDER_DEFAULT_ROUND_DURATION_MINUTES,
      status: "DRAFT",
    },
  });

  // Deliberately outside any try/catch: redirect() works by throwing, and a
  // surrounding catch would swallow the navigation (same reasoning as
  // `src/app/dashboard/actions.ts`'s `logout`).
  redirect(`/dashboard/brackets/${bracket.id}/edit`);
}
