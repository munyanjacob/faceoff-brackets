"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateRoundDuration } from "./round-duration-actions";
import { initialRoundDurationFormState } from "./round-duration-form-state";
import { roundNameHint, type RoundDurationOverrides } from "./round-duration";

/**
 * The default/per-round duration form on a draft bracket's edit page (issue
 * #13). Only ever rendered by `./page.tsx` while `Bracket.status ===
 * "DRAFT"` - round durations lock once the bracket has started, the same
 * reasoning `./add-item-form.tsx` uses for item edits (issue #11).
 *
 * `totalRounds` is passed down already computed (`./page.tsx` derives it
 * from the live `BracketItem` count via `computeTotalRounds`) purely to
 * decide how many override rows to render and which "(Final)"/"(Semifinal)"
 * hint to show next to a row - the Server Action re-derives it itself from
 * the database rather than trusting this prop, since it's only ever used
 * here for display.
 *
 * `bracketId` is bound onto `updateRoundDuration` with
 * `Function.prototype.bind` (the Next.js forms guide's "Passing additional
 * arguments" pattern), the same as `./add-item-form.tsx` does for
 * `addItem`.
 */
export function RoundDurationForm({
  bracketId,
  defaultRoundDurationMinutes,
  overrides,
  totalRounds,
}: {
  bracketId: string;
  defaultRoundDurationMinutes: number;
  overrides: RoundDurationOverrides;
  totalRounds: number;
}) {
  const updateForThisBracket = updateRoundDuration.bind(null, bracketId);
  const [state, formAction] = useActionState(
    updateForThisBracket,
    initialRoundDurationFormState
  );

  const roundNumbers = Array.from(
    { length: totalRounds },
    (_, index) => index + 1
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 border p-3">
      <h2 className="text-lg font-semibold">Round duration</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="default-round-duration">
          Default round duration (minutes)
        </label>
        <input
          id="default-round-duration"
          name="defaultRoundDurationMinutes"
          type="number"
          min={1}
          step={1}
          defaultValue={defaultRoundDurationMinutes}
          required
        />
      </div>

      {roundNumbers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p>
            Optionally override the duration for individual rounds. Leave a
            round blank to use the default above.
          </p>
          {roundNumbers.map((roundNumber) => {
            const hint = roundNameHint(roundNumber, totalRounds);
            return (
              <div key={roundNumber} className="flex flex-col gap-1">
                <label htmlFor={`round-override-${roundNumber}`}>
                  Round {roundNumber}
                  {hint ? ` (${hint})` : ""}
                </label>
                <input
                  id={`round-override-${roundNumber}`}
                  name={`roundOverride-${roundNumber}`}
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={overrides[roundNumber] ?? ""}
                  placeholder={`Default (${defaultRoundDurationMinutes})`}
                />
              </div>
            );
          })}
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
      {pending ? "Saving..." : "Save round duration"}
    </button>
  );
}
