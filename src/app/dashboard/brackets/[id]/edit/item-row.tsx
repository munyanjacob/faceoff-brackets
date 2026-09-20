"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateItem, removeItem } from "./actions";
import { initialItemFormState } from "./item-form-state";
import { ALLOWED_IMAGE_MIME_TYPES } from "./validation";

export type BracketItemRow = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
};

/**
 * One existing `BracketItem` on a draft bracket's edit page (issue #11):
 * editable and removable while `isDraft`, read-only otherwise (`./page.tsx`
 * computes `isDraft` from `Bracket.status` and passes it down - see that
 * file for why the *controls*, not the item's existence, are what's
 * gated).
 *
 * `bracketId`/`item.id` are bound onto `updateItem`/`removeItem` with
 * `Function.prototype.bind` (the Next.js forms guide's "Passing additional
 * arguments" pattern), the same as `./add-item-form.tsx` does for
 * `addItem`.
 *
 * Issue #12 adds `item.imageUrl`: rendered (when present) both read-only
 * and in the edit form, plus a file input in the edit form to upload a new
 * image or replace the existing one. Leaving the file input empty on save
 * keeps the current image - `./validation.ts`/`./actions.ts` only touch
 * `image_url` when a new file was actually chosen. A plain `<img>` (rather
 * than `next/image`) is used deliberately: these are user-uploaded, unknown
 * aspect ratio images from an external (Supabase Storage) domain, and
 * `next/image` needs either explicit `width`/`height` or a `next.config.ts`
 * `images.remotePatterns` entry - out of scope for this MVP thumbnail.
 */
export function ItemRow({
  bracketId,
  item,
  isDraft,
}: {
  bracketId: string;
  item: BracketItemRow;
  isDraft: boolean;
}) {
  const updateThisItem = updateItem.bind(null, bracketId, item.id);
  const removeThisItem = removeItem.bind(null, bracketId, item.id);

  const [updateState, updateAction] = useActionState(
    updateThisItem,
    initialItemFormState
  );
  const [removeState, removeAction] = useActionState(
    removeThisItem,
    initialItemFormState
  );

  if (!isDraft) {
    return (
      <div className="flex flex-col gap-1 border p-3">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.title}
            className="h-24 w-24 object-cover"
          />
        ) : null}
        <p className="font-medium">{item.title}</p>
        {item.description ? <p>{item.description}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border p-3">
      <form action={updateAction} className="flex flex-col gap-1">
        <label htmlFor={`item-title-${item.id}`}>Title</label>
        <input
          id={`item-title-${item.id}`}
          name="title"
          type="text"
          defaultValue={item.title}
          required
        />

        <label htmlFor={`item-description-${item.id}`}>
          Description (optional)
        </label>
        <textarea
          id={`item-description-${item.id}`}
          name="description"
          defaultValue={item.description ?? ""}
          rows={2}
        />

        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.title}
            className="h-24 w-24 object-cover"
          />
        ) : null}
        <label htmlFor={`item-image-${item.id}`}>
          {item.imageUrl ? "Replace image (optional)" : "Image (optional)"}
        </label>
        <input
          id={`item-image-${item.id}`}
          name="image"
          type="file"
          accept={ALLOWED_IMAGE_MIME_TYPES.join(",")}
        />

        <p aria-live="polite">{updateState.error}</p>

        <SaveButton />
      </form>

      <form action={removeAction}>
        <p aria-live="polite">{removeState.error}</p>
        <RemoveButton />
      </form>
    </div>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save"}
    </button>
  );
}

function RemoveButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Removing..." : "Remove"}
    </button>
  );
}
