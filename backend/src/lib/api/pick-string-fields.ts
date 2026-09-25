/**
 * Picks `fields` off `body` (a parsed, untrusted JSON value) into a plain
 * object keyed by field name, converting each present `string`/`number`
 * value to a `string` and dropping anything else (missing field, `null`,
 * a boolean, an array, a nested object, ...) - never throws, regardless of
 * what shape `body` actually is.
 *
 * This is the one shared shape three endpoints' JSON-body adapters all
 * needed (issue #79): `POST /brackets`, `PATCH .../round-duration`, and
 * `PATCH .../schedule` each used to hand-roll their own "for each known
 * field, type-check then set it" loop to shoehorn a parsed JSON body into
 * the `FormData`/plain-object shape their shared dashboard validators
 * expect. `.../round-duration`'s per-round `roundOverride-<n>` fields reuse
 * this too - `overrides`' own keys (round numbers, only known at request
 * time) are simply passed as `fields`, so the dynamic case needs no special
 * handling here.
 *
 * A missing/non-string/non-number value is left off the result entirely
 * (rather than e.g. `undefined`) so `Object.entries(...)` over the result
 * only ever yields fields that were actually present and usable - exactly
 * what every call site already did field-by-field before this existed.
 */
export function pickStringFields<K extends string>(
  body: unknown,
  fields: readonly K[]
): Partial<Record<K, string>> {
  const picked: Partial<Record<K, string>> = {};
  if (body === null || typeof body !== "object") {
    return picked;
  }

  const record = body as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" || typeof value === "number") {
      picked[field] = String(value);
    }
  }
  return picked;
}
