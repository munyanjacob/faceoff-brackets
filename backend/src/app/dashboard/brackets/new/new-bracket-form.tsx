"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createBracket } from "./actions";
import { initialCreateBracketState } from "./action-state";

/**
 * The "create bracket" form (issue #10). A Client Component so it can use
 * `useActionState` to surface the Server Action's validation error (e.g.
 * "Title is required.") without a full page reload - see the Next.js
 * "Validation errors" guide
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md`).
 *
 * Visibility and voting-requires-account are both `required` radio groups
 * (client-side HTML validation) with a pre-checked default, so a visitor
 * only sees the server-side error for one of them in the unusual case of a
 * JS-disabled/tampered submission - the same defense-in-depth as the
 * `required` attribute on the title input.
 */
export function NewBracketForm() {
  const [state, formAction] = useActionState(
    createBracket,
    initialCreateBracketState
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Create a bracket</h1>

      <div className="flex flex-col gap-1">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" type="text" required />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="description">Description (optional)</label>
        <textarea id="description" name="description" rows={4} />
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend>Visibility</legend>
        <label>
          <input
            type="radio"
            name="visibility"
            value="PUBLIC"
            defaultChecked
            required
          />{" "}
          Public
        </label>
        <label>
          <input type="radio" name="visibility" value="PRIVATE" required />{" "}
          Private
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend>Voting requires an account?</legend>
        <label>
          <input
            type="radio"
            name="votingRequirement"
            value="ACCOUNT_REQUIRED"
            defaultChecked
            required
          />{" "}
          Yes - voters must be signed in
        </label>
        <label>
          <input
            type="radio"
            name="votingRequirement"
            value="ANONYMOUS_ALLOWED"
            required
          />{" "}
          No - anyone can vote
        </label>
      </fieldset>

      <p aria-live="polite">{state.error}</p>

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create bracket"}
    </button>
  );
}
