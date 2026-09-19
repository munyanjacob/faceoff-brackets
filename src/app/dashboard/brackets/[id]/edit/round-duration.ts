/**
 * Pure round-duration logic for the bracket edit page (issue #13) - no
 * Next.js, Prisma, or Supabase import here, so it can be unit-tested
 * directly, the same reasoning as `./validation.ts`.
 * `./round-duration-actions.ts` is a thin wrapper around this plus the
 * actual `prisma.bracket.update()` call.
 *
 * Per the issue:
 * - Overrides are keyed by absolute round number (1, 2, 3, ...), never by a
 *   name like "Semifinal"/"Final" - those are only ever a display hint,
 *   computed live from the current item count, since they're relative to a
 *   total round count that can shift while items are being added/removed.
 * - The total round count is `ceil(log2(item count))`.
 * - A duration of zero or negative is a validation error, for both the
 *   default and any override.
 * - Leaving every round at the default is valid - no override input is
 *   required.
 * - Stale overrides (a round number beyond the currently-computed total)
 *   are #18's problem to *apply* correctly at publish time; this module's
 *   job is just to never crash on one, per the issue and the task brief.
 */

/** `ceil(log2(itemCount))`, defined down to 0 for fewer than 2 items - no
 * matchup, and so no round, is possible below that. */
export function computeTotalRounds(itemCount: number): number {
  if (itemCount < 2) {
    return 0;
  }
  return Math.ceil(Math.log2(itemCount));
}

/** The "(Final)" / "(Semifinal)" display hint for a given round number,
 * given the current total round count - or `null` when neither applies.
 * Purely cosmetic: the stored key is always the round number regardless of
 * this hint (see the file header). */
export function roundNameHint(
  roundNumber: number,
  totalRounds: number
): string | null {
  if (totalRounds < 1 || roundNumber < 1 || roundNumber > totalRounds) {
    return null;
  }
  if (roundNumber === totalRounds) {
    return "Final";
  }
  if (totalRounds >= 2 && roundNumber === totalRounds - 1) {
    return "Semifinal";
  }
  return null;
}

export type RoundDurationOverrides = Record<number, number>;

export type RoundDurationInput = {
  defaultRoundDurationMinutes: number;
  overrides: RoundDurationOverrides;
};

export type RoundDurationValidationResult =
  | { ok: true; data: RoundDurationInput }
  | { ok: false; error: string };

/** Parses whatever is stored in `Bracket.round_duration_overrides` (a
 * nullable Prisma `Json` column - so, at the type level, entirely
 * untrusted) into a clean `{ roundNumber: minutes }` map. Anything that
 * doesn't look like a positive integer round number mapped to a positive
 * integer duration is dropped rather than thrown on - this is the "don't
 * crash on a stale/malformed entry" side of the issue's tolerance, since a
 * round number here may no longer exist against the current item count (or,
 * in principle, may never have been valid). */
export function parseStoredRoundDurationOverrides(
  value: unknown
): RoundDurationOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const result: RoundDurationOverrides = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const roundNumber = Number(key);
    const minutes = typeof raw === "number" ? raw : Number(raw);
    if (
      !Number.isInteger(roundNumber) ||
      roundNumber < 1 ||
      !Number.isInteger(minutes) ||
      minutes <= 0
    ) {
      continue;
    }
    result[roundNumber] = minutes;
  }
  return result;
}

function parsePositiveIntField(
  formData: FormData,
  fieldName: string
): { ok: true; value: number } | { ok: false } {
  const raw = formData.get(fieldName);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Validates the round-duration form. `totalRounds` is the *server's own*
 * live computation (from the current `BracketItem` count), not anything
 * trusted from the client - so a stale/tampered form field for a round
 * beyond it is simply never read, never mind rejected.
 *
 * Field naming: `defaultRoundDurationMinutes` for the default, and
 * `roundOverride-<n>` for each round `1..totalRounds`'s optional override
 * (left blank/absent to use the default for that round).
 */
export function validateRoundDurationForm(
  formData: FormData,
  totalRounds: number
): RoundDurationValidationResult {
  const defaultField = parsePositiveIntField(
    formData,
    "defaultRoundDurationMinutes"
  );
  if (!defaultField.ok) {
    return {
      ok: false,
      error: "Default round duration is required.",
    };
  }
  if (defaultField.value <= 0) {
    return {
      ok: false,
      error: "Default round duration must be a positive number of minutes.",
    };
  }

  const overrides: RoundDurationOverrides = {};
  for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
    const raw = formData.get(`roundOverride-${roundNumber}`);
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }

    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
      return {
        ok: false,
        error: `Round ${roundNumber}'s duration must be a whole number of minutes.`,
      };
    }
    if (minutes <= 0) {
      return {
        ok: false,
        error: `Round ${roundNumber}'s duration must be a positive number of minutes.`,
      };
    }
    overrides[roundNumber] = minutes;
  }

  return {
    ok: true,
    data: {
      defaultRoundDurationMinutes: defaultField.value,
      overrides,
    },
  };
}

/** Converts a `{ roundNumber: minutes }` map into the plain JSON object
 * shape stored in `Bracket.round_duration_overrides` (object keys are
 * always strings in JSON). Empty overrides serialize to `{}`, matching the
 * issue's "leaving every round at the default...requires no extra input" -
 * an empty object, not `null`, is treated as a normal "no overrides" case
 * here; either is a valid empty state to read back via
 * `parseStoredRoundDurationOverrides`. */
export function serializeRoundDurationOverrides(
  overrides: RoundDurationOverrides
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [roundNumber, minutes] of Object.entries(overrides)) {
    result[roundNumber] = minutes;
  }
  return result;
}
