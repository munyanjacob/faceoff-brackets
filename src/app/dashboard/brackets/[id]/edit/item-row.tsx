"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateItem, removeItem, initialItemFormState } from "./actions";

export type BracketItemRow = {
  id: string;
  title: string;
  description: string | null;
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
