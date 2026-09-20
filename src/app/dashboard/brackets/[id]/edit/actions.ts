"use server";

import { notFound, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { validateBracketItemForm } from "./validation";
import { uploadBracketItemImage } from "./image-upload";

/**
 * Server Actions backing the item list on a draft bracket's edit page
 * (issue #11, extended by #12 for the optional item image).
 * `./validation.ts` has the pure title/description/image validation; these
 * wrap it with the actual `prisma.bracketItem` calls and, when a validated
 * image file is present, `./image-upload.ts`'s Supabase Storage upload.
 * Signature/`prevState` shape follows the same pattern as `../new/actions.ts`
 * (issue #10) - see the Next.js "Validation errors" guide
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md`).
 *
 * A validated image is uploaded *after* the title/description validation
 * and *before* the `prisma.bracketItem` call, so a bad title never triggers
 * a needless upload, and an upload failure (network/Storage error) returns
 * a normal validation-style error instead of creating/updating a row with
 * no image.
 *
 * `bracketId` (and, for `updateItem`/`removeItem`, `itemId`) are bound onto
 * each action with `Function.prototype.bind` in the Client Components that
 * call these (`./add-item-form.tsx`, `./item-row.tsx`) before being handed
 * to `useActionState` - the "Passing additional arguments" pattern from the
 * Next.js forms guide - rather than trusted hidden form fields.
 *
 * Every action re-derives the signed-in creator from the session (a Server
 * Action is its own POST endpoint, reachable independently of whether
 * `./page.tsx` ever rendered a form for it - see the Next.js Server Actions
 * security guide, `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`)
 * and looks the `Bracket` up scoped to `id` + `creatorId`, never trusting a
 * `bracketId` argument alone. `updateItem`/`removeItem` additionally scope
 * the `BracketItem` lookup to `bracketId`, so an item id can never be used
 * to reach into a bracket the caller doesn't own, or a different bracket of
 * their own. A bracket/item that doesn't exist, or isn't this creator's,
 * 404s the same way `./page.tsx` does.
 *
 * `bracket.status !== "DRAFT"` is a distinct, non-404 case (the bracket is
 * real and does belong to this creator - it's just no longer editable) so
 * it returns a normal validation-style error instead, in case a stale tab
 * has the edit form open past publishing.
 */
export type ItemFormState = { error: string | null };

export const initialItemFormState: ItemFormState = { error: null };

const NOT_DRAFT_ERROR =
  "This bracket is no longer a draft, so its items can't be changed.";

const IMAGE_UPLOAD_ERROR = "Failed to upload the image. Please try again.";

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

    if (bracket.status !== "DRAFT") {
      return { error: NOT_DRAFT_ERROR };
    }

    const validated = validateBracketItemForm(formData);
    if (!validated.ok) {
      return { error: validated.error };
    }

    let imageUrl: string | null = null;
    if (validated.data.image) {
      try {
        imageUrl = await uploadBracketItemImage(bracket.id, validated.data.image);
      } catch {
        return { error: IMAGE_UPLOAD_ERROR };
      }
    }

    await prisma.bracketItem.create({
      data: {
        bracketId: bracket.id,
        title: validated.data.title,
        description: validated.data.description,
        imageUrl,
      },
    });

    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
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

    if (bracket.status !== "DRAFT") {
      return { error: NOT_DRAFT_ERROR };
    }

    const item = await prisma.bracketItem.findFirst({
      where: { id: itemId, bracketId: bracket.id },
    });
    if (!item) {
      notFound();
    }

    const validated = validateBracketItemForm(formData);
    if (!validated.ok) {
      return { error: validated.error };
    }

    // No new file was chosen: `imageUrl` stays `undefined`, so the spread
    // below omits the key entirely and Prisma leaves the existing
    // `image_url` untouched - the image is optional and replacing it is only
    // supposed to happen when a new file is actually uploaded (issue #12).
    let imageUrl: string | undefined;
    if (validated.data.image) {
      try {
        imageUrl = await uploadBracketItemImage(bracket.id, validated.data.image);
      } catch {
        return { error: IMAGE_UPLOAD_ERROR };
      }
    }

    await prisma.bracketItem.update({
      where: { id: item.id },
      data: {
        title: validated.data.title,
        description: validated.data.description,
        ...(imageUrl ? { imageUrl } : {}),
      },
    });

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

    if (bracket.status !== "DRAFT") {
      return { error: NOT_DRAFT_ERROR };
    }

    const item = await prisma.bracketItem.findFirst({
      where: { id: itemId, bracketId: bracket.id },
    });
    if (!item) {
      notFound();
    }

    await prisma.bracketItem.delete({ where: { id: item.id } });

    revalidatePath(`/dashboard/brackets/${bracket.id}/edit`);
    return { error: null };
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR };
  }
}
