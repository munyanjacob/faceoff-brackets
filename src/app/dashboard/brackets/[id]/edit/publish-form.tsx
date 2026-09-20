"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { publishBracket } from "./publish-actions";
import { initialPublishFormState } from "./publish-form-state";

/**
 * The "Publish" action on a draft bracket's edit page (issue #16). Only ever
 * rendered by `./page.tsx` while `Bracket.status === "DRAFT"` *and* the
 * bracket has at least 2 items - see that file for the "fewer than 2 items"
 * message shown in place of this form otherwise. `./publish-actions.ts`
 * re-checks both the draft status and the item count itself regardless (a
 * direct call to the Server Action is reachable independently of whether
 * this form ever rendered a submit button for it), so this component is
 * purely about *visibility*, not the actual guard.
 *
 * No fields - publishing takes no input - so this is just a plain
 * `useActionState`-backed submit button, the same `Function.prototype.bind`
 * pattern (the Next.js forms guide's "Passing additional arguments") as
 * every other action on this page.
 *
 * There is deliberately no "unpublish" control anywhere in this file or
 * `./page.tsx` - publishing is one-way in this issue's scope.
 */
export function PublishForm({ bracketId }: { bracketId: string }) {
  const publishThisBracket = publishBracket.bind(null, bracketId);
  const [state, formAction] = useActionState(
    publishThisBracket,
    initialPublishFormState
  );

  return (
    <form action={formAction} className="flex flex-col gap-2 border p-3">
      <p>
        Publishing locks the bracket&apos;s items, round durations, and start
        time, and makes it live.
      </p>

      <p aria-live="polite">{state.error}</p>

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Publishing..." : "Publish"}
    </button>
  );
}
