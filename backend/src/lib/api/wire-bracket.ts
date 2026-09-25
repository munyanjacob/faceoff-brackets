import {
  parseStoredRoundDurationOverrides,
  type RoundDurationOverrides,
} from "@/app/dashboard/brackets/[id]/edit/round-duration";

/**
 * Normalizes a `Bracket` row for the wire (issue #73): `Bracket
 * .roundDurationOverrides` is a nullable Prisma `Json` column, but
 * docs/openapi.yaml's `Bracket` schema documents `roundDurationOverrides`
 * as always an object, never `null` - every bracket-returning endpoint has
 * to mask that with `parseStoredRoundDurationOverrides` before responding.
 *
 * This used to be five separately hand-written `{ ...bracket,
 * roundDurationOverrides: parseStoredRoundDurationOverrides(...) }` call
 * sites - commit b6c5203 had to patch a missing one independently across
 * all five in a single commit. Routing every bracket response through this
 * one function instead makes that particular bug impossible to reintroduce.
 *
 * Generic over `T` (rather than one fixed `Bracket` type) so this works
 * for a plain `Bracket` row, one `include`-widened with `creator` or
 * `rounds`, and so on - callers that need to add further fields (e.g.
 * `[bracketId]/route.ts`'s `viewerIsOwner`) just spread this function's
 * result the same way they already spread the raw row.
 */
export function toWireBracket<T extends { roundDurationOverrides: unknown }>(
  bracket: T
): Omit<T, "roundDurationOverrides"> & {
  roundDurationOverrides: RoundDurationOverrides;
} {
  return {
    ...bracket,
    roundDurationOverrides: parseStoredRoundDurationOverrides(
      bracket.roundDurationOverrides
    ),
  };
}
