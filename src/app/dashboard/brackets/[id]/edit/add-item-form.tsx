"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addItem } from "./actions";
import { initialItemFormState } from "./item-form-state";
import { ALLOWED_IMAGE_MIME_TYPES } from "./validation";

/**
 * The "add an item" form on a draft bracket's edit page (issue #11, extended
 * by #12 for the optional image file input). Only ever rendered by
 * `./page.tsx` while `Bracket.status === "DRAFT"` - see that file for the
 * hidden/disabled-when-not-draft rule.
 *
 * `bracketId` is bound onto `addItem` with `Function.prototype.bind` (the
 * Next.js forms guide's "Passing additional arguments" pattern) rather than
 * a hidden input, the same reasoning as `../new/new-bracket-form.tsx` uses
 * `useActionState` for the "Title is required." validation error.
 *
 * No `encType` prop here: when `action` is a function, React manages
 * `method`/`encType` itself (including for the no-JS progressive
 * enhancement fallback) and overrides/warns on any explicit value - see
 * the "Cannot specify a encType or method..." warning in
 * `node_modules/react-dom/cjs/react-dom-client.development.js`.
 */
export function AddItemForm({ bracketId }: { bracketId: string }) {
  const addItemForThisBracket = addItem.bind(null, bracketId);
  const [state, formAction] = useActionState(
    addItemForThisBracket,
    initialItemFormState
  );

  return (
    <form action={formAction} className="flex flex-col gap-2 border p-3">
      <h2 className="text-lg font-semibold">Add an item</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="new-item-title">Title</label>
        <input id="new-item-title" name="title" type="text" required />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="new-item-description">Description (optional)</label>
        <textarea id="new-item-description" name="description" rows={2} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="new-item-image">Image (optional)</label>
        <input
          id="new-item-image"
          name="image"
          type="file"
          accept={ALLOWED_IMAGE_MIME_TYPES.join(",")}
        />
      </div>

      <p aria-live="polite">{state.error}</p>

      <SubmitButton idleLabel="Add item" pendingLabel="Adding..." />
    </form>
  );
}

function SubmitButton({
  idleLabel,
  pendingLabel,
}: {
  idleLabel: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
