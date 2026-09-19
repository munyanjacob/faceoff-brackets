/**
 * Pure start-time logic for the bracket edit page (issue #14) - no
 * Next.js, Prisma, or Supabase import here, so it can be unit-tested
 * directly against a plain `FormData`, the same reasoning as
 * `./round-duration.ts` and `./validation.ts`.
 * `./scheduled-start-actions.ts` is a thin wrapper around this plus the
 * actual `prisma.bracket.update()` call.
 *
 * Per the issue:
 * - The form offers "Start immediately" (default) or "Schedule a start
 *   time"; choosing immediate leaves `Bracket.scheduledStartAt` null.
 * - Choosing "Schedule a start time" requires a future date/time - a past or
 *   missing value is a validation error.
 * - "Future" is judged against the server's own clock at submission time
 *   (the `now` parameter here), never trusted from client-side validation
 *   alone - `./scheduled-start-actions.ts` always passes `new Date()`, and
 *   tests pass a fixed instant to keep this pure and deterministic.
 *
 * Field naming: `startMode` (`"immediate"` or `"scheduled"`) picks the
 * radio choice, and `scheduledStartAt` holds the `<input type="datetime-
 * local">` value, only read/required when `startMode` is `"scheduled"`.
 */
export type ScheduledStartInput = {
  scheduledStartAt: Date | null;
};

export type ScheduledStartValidationResult =
  | { ok: true; data: ScheduledStartInput }
  | { ok: false; error: string };

/** Parses an `<input type="datetime-local">` value (e.g.
 * `"2026-09-20T10:00"`) into a `Date`, or `null` if it's missing/blank/not a
 * valid date - never throws. `datetime-local` values carry no timezone
 * offset, so `Date`'s own parsing treats it as local time, matching what the
 * picker showed the creator. */
export function parseDatetimeLocalValue(
  raw: FormDataEntryValue | null
): Date | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/** Formats a `Date` back into the value an `<input type="datetime-local">`
 * expects (`"YYYY-MM-DDTHH:mm"`, local time, no timezone/seconds), so a
 * previously-saved scheduled start redisplays in the picker on reload. */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Validates the start-time form. `now` is the caller's own reading of the
 * current instant - `./scheduled-start-actions.ts` passes `new Date()` at
 * the moment of submission, so "future" is always judged against the
 * server's clock, never a client-supplied value.
 */
export function validateScheduledStartForm(
  formData: FormData,
  now: Date
): ScheduledStartValidationResult {
  const startMode = formData.get("startMode");

  if (startMode !== "scheduled") {
    // Default/"immediate" - anything other than the literal "scheduled"
    // value (including missing/tampered input) leaves the bracket
    // unscheduled rather than erroring, matching "Start immediately" being
    // the default choice.
    return { ok: true, data: { scheduledStartAt: null } };
  }

  const parsed = parseDatetimeLocalValue(formData.get("scheduledStartAt"));
  if (parsed === null) {
    return {
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    };
  }

  if (parsed.getTime() <= now.getTime()) {
    return {
      ok: false,
      error: "The scheduled start time must be in the future.",
    };
  }

  return { ok: true, data: { scheduledStartAt: parsed } };
}
