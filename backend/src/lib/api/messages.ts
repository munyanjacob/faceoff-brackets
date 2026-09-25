// Centralized user-facing strings/error messages shared between the
// dashboard's Server Actions (`app/dashboard/brackets/[id]/edit/*.ts`) and
// their REST counterparts (`app/api/brackets/[bracketId]/...`) (issue #74).
//
// Every affected route/action file's own doc-comment already says its
// message "must stay identical" to its Server Action/REST pair - previously
// that was only true because each copy happened to be hand-typed the same
// way, with nothing enforcing it. Importing these constants instead of
// retyping the string is what actually guarantees that.
//
// `NOT_DRAFT_*_MESSAGE` is split into one constant per concept (items,
// publish, round duration, schedule) rather than a single shared string -
// the four existing wordings are genuinely different per context (e.g.
// publish's "has already been published" vs. round-duration's "so its round
// durations can't be changed"), not an accidental drift, so each keeps its
// own exact existing wording.

/** The 404 `NOT_FOUND` message for a bracket id that doesn't exist, or
 * isn't owned by the caller - used by every creator-scoped bracket
 * lookup. */
export const BRACKET_NOT_FOUND_MESSAGE = "This bracket no longer exists.";

/** The 404 `NOT_FOUND` message for an item id that doesn't exist within its
 * bracket. */
export const ITEM_NOT_FOUND_MESSAGE = "This item no longer exists.";

/** `NOT_DRAFT` message for the item-mutation endpoints/actions
 * (`items/route.ts`'s `POST`, `items/[itemId]/route.ts`, `./actions.ts`). */
export const NOT_DRAFT_ITEMS_MESSAGE =
  "This bracket is no longer a draft, so its items can't be changed.";

/** `NOT_DRAFT` message for the publish endpoint/action - publishing is
 * one-way, so a non-DRAFT bracket here specifically means "already
 * published" rather than the generic "can't be changed" wording the other
 * three use. */
export const NOT_DRAFT_PUBLISH_MESSAGE =
  "This bracket has already been published.";

/** `NOT_DRAFT` message for the round-duration endpoint/action. */
export const NOT_DRAFT_ROUND_DURATION_MESSAGE =
  "This bracket is no longer a draft, so its round durations can't be changed.";

/** `NOT_DRAFT` message for the scheduled-start endpoint/action. */
export const NOT_DRAFT_SCHEDULE_MESSAGE =
  "This bracket is no longer a draft, so its start time can't be changed.";
