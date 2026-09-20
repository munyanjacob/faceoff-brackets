"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateScheduledStart } from "./scheduled-start-actions";
import { initialScheduledStartFormState } from "./scheduled-start-form-state";
import { toDatetimeLocalValue } from "./scheduled-start";

/**
 * The "start immediately vs. scheduled" form on a draft bracket's edit page
 * (issue #14). Only ever rendered by `./page.tsx` while `Bracket.status ===
 * "DRAFT"` - the start time locks once the bracket has started/published,
 * the same reasoning `./round-duration-form.tsx` uses (issue #13).
 *
 * `scheduledStartAt` is passed down as the `Bracket` row's current value (or
 * `null`) so the radio choice and, if applicable, the date/time picker
 * redisplay correctly after a page reload of the draft - the whole point of
 * this issue being that the choice is actually persisted, not just held in
 * local component state. The picker is only ever revealed/enabled while
 * "Schedule a start time" is selected; local `useState` here is just this
 * page's own show/hide toggle, not the source of truth for what's saved.
 *
 * `bracketId` is bound onto `updateScheduledStart` with
 * `Function.prototype.bind` (the Next.js forms guide's "Passing additional
 * arguments" pattern), the same as `./round-duration-form.tsx` does for
 * `updateRoundDuration`.
 */
export function ScheduledStartForm({
  bracketId,
  scheduledStartAt,
}: {
  bracketId: string;
  scheduledStartAt: Date | null;
}) {
  const updateForThisBracket = updateScheduledStart.bind(null, bracketId);
  const [state, formAction] = useActionState(
    updateForThisBracket,
    initialScheduledStartFormState
  );

  const [startMode, setStartMode] = useState<"immediate" | "scheduled">(
    scheduledStartAt ? "scheduled" : "immediate"
  );

  const defaultScheduledStartAtValue = scheduledStartAt
    ? toDatetimeLocalValue(scheduledStartAt)
    : "";

  return (
    <form action={formAction} className="flex flex-col gap-3 border p-3">
      <h2 className="text-lg font-semibold">Start time</h2>

      <div className="flex flex-col gap-1">
        <label>
          <input
            type="radio"
            name="startMode"
            value="immediate"
            checked={startMode === "immediate"}
            onChange={() => setStartMode("immediate")}
          />{" "}
          Start immediately
        </label>
        <label>
          <input
            type="radio"
            name="startMode"
            value="scheduled"
            checked={startMode === "scheduled"}
            onChange={() => setStartMode("scheduled")}
          />{" "}
          Schedule a start time
        </label>
      </div>

      {startMode === "scheduled" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="scheduled-start-at">Start date and time</label>
          <input
            id="scheduled-start-at"
            name="scheduledStartAt"
            type="datetime-local"
            defaultValue={defaultScheduledStartAtValue}
            required
          />
        </div>
      ) : null}

      <p aria-live="polite">{state.error}</p>

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save start time"}
    </button>
  );
}
