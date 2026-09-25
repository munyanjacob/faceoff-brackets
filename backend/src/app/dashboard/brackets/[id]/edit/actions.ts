"use server";

import { notFound, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { NOT_DRAFT_ITEMS_MESSAGE } from "@/lib/api/messages";
import {
  addBracketItemCore,
  updateBracketItemCore,
  removeBracketItemCore,
  IMAGE_UPLOAD_ERROR,
} from "@/lib/bracket/items-core";

/**
 * Server Actions backing the item list on a draft bracket's edit page
 * (issue #11, extended by #12 for the optional item image).
 *
 * Thin adapters (issue #77) over `@/lib/bracket/items-core.ts`'s
 * `addBracketItemCore`/`updateBracketItemCore`/`removeBracketItemCore`,
 * which own the actual DRAFT-gated item validation/persistence rules
 * shared with these actions' REST siblings,
 * `../../../../api/brackets/[bracketId]/items/route.ts` and
 * `items/[itemId]/route.ts`. This file's only remaining jobs: re-derive the
 * signed-in creator from the cookie-bound Supabase session and look the
 * `Bracket` up scoped to `id` + `creatorId` (never trusting a `bracketId`
 * argument alone - a bracket that doesn't exist, or isn't this creator's,
 * 404s via `notFound()`), translate each core outcome into `ItemFormState`,
 * and this entry point's own `revalidatePath` side effect.
 *
 * `bracketId` (and, for `updateItem`/`removeItem`, `itemId`) are bound onto
 * each action with `Function.prototype.bind` in the Client Components that
 * call these (`./add-item-form.tsx`, `./item-row.tsx`) before being handed
 * to `useActionState` - the "Passing additional arguments" pattern from the
 * Next.js forms guide - rather than trusted hidden form fields.
 */
export type ItemFormState = { error: string | null };

// Issue #36: a generic, user-facing fallback for a DB/Supabase failure that
// isn't one of the specific errors above - e.g. the database being
// temporarily unreachable. Rendered inline by `./add-item-form.tsx`/
// `./item-row.tsx` the same way as any other `state.error`, rather than
// letting the exception propagate into Next's generic error boundary/blank
// page. `unstable_rethrow` (see each `catch` below) makes sure this never
// swallows `notFound()`'s own thrown navigation error.
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

export async function addItem(
  bracketId: string,
  _prevState: ItemFormState,
  formData: FormData
): Promise<ItemFormState> {
  try {
    const bracket = await requireOwnedBracket(bracketId);
    const outcome = await addBracketItemCore(bracket, formData);

    switch (outcome.kind) {
      case "notDraft":
        return { error: NOT_DRAFT_ITEMS_MESSAGE };
      case "validationError":
        return { error: outcome.message };
      case "imageUploadFailed":
        return { error: IMAGE_UPLOAD_ERROR };
      case "created":
        revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
        return { error: null };
    }
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}

export async function updateItem(
  bracketId: string,
  itemId: string,
  _prevState: ItemFormState,
  formData: FormData
): Promise<ItemFormState> {
  try {
    const bracket = await requireOwnedBracket(bracketId);
    const outcome = await updateBracketItemCore(bracket, itemId, formData);

    if (outcome.kind === "notDraft") {
      return { error: NOT_DRAFT_ITEMS_MESSAGE };
    }
    if (outcome.kind === "itemNotFound") {
      notFound();
    }
    if (outcome.kind === "validationError") {
      return { error: outcome.message };
    }
    if (outcome.kind === "imageUploadFailed") {
      return { error: IMAGE_UPLOAD_ERROR };
    }
    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}

export async function removeItem(
  bracketId: string,
  itemId: string,
  _prevState: ItemFormState,
  _formData: FormData
): Promise<ItemFormState> {
  try {
    const bracket = await requireOwnedBracket(bracketId);
    const outcome = await removeBracketItemCore(bracket, itemId);

    if (outcome.kind === "notDraft") {
      return { error: NOT_DRAFT_ITEMS_MESSAGE };
    }
    if (outcome.kind === "itemNotFound") {
      notFound();
    }
    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}
