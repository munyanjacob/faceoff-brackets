"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { MAX_COMMENT_LENGTH, useVoteComment } from "./comment-field";
import { castVote, initialVoteFormState } from "./vote-actions";

/**
 * The real "Vote" button for one item in the current matchup (issue #22),
 * replacing #21's disabled placeholder in `./matchup-voting.tsx`'s
 * `ItemPanel`. `matchupId`/`itemId` are bound onto `castVote` with
 * `Function.prototype.bind` - the same pattern as
 * `../../dashboard/brackets/[id]/edit/item-row.tsx`'s
 * `updateItem.bind(null, bracketId, item.id)` - so this component needs no
 * hidden form fields.
 *
 * One `VoteButton` per item, each with its own `useActionState` instance
 * (rather than one shared form covering both items of the matchup): a
 * click on this button only ever needs to know about *its own* item's
 * outcome. When `castVote` instead reports the *other* item as the voter's
 * existing choice (e.g. they already voted, or a race resolved in the
 * other item's favor), this button simply goes back to a plain "Vote"
 * state and the page's own revalidated re-render (see `./vote-actions.ts`'s
 * `revalidatePath` call, which as of issue #40 revalidates both
 * `/brackets/[id]` and this matchup's own `/brackets/[id]/matchups/
 * [matchupId]`) - which recomputes `existingVoteItemId` for the whole
 * matchup from `./matchups/[matchupId]/page.tsx` - supplies the correct,
 * consistent "Your vote" label on the right item moments later. This transient gap is
 * a deliberate simplicity trade-off, not an oversight.
 *
 * Issue #23's comment field lives outside this form entirely
 * (`./comment-field.tsx`'s `CommentField`, rendered once per matchup by
 * `./matchup-voting.tsx`) - a hidden `name="comment"` input mirrors its
 * current value (read via `useVoteComment`) into *this* button's own form,
 * so whichever of the matchup's two `<VoteButton>`s actually gets clicked
 * submits the same comment text alongside its vote. This is also why a
 * comment can never be submitted on its own: it only ever travels inside
 * one of these two vote forms, neither of which has any other submit path.
 */
export function VoteButton({
  matchupId,
  itemId,
}: {
  matchupId: string;
  itemId: string;
}) {
  const comment = useVoteComment();
  const commentTooLong = comment.length > MAX_COMMENT_LENGTH;
  const castVoteForThisItem = castVote.bind(null, matchupId, itemId);
  const [state, formAction] = useActionState(
    castVoteForThisItem,
    initialVoteFormState
  );

  if (state.votedItemId === itemId) {
    return (
      <p aria-live="polite" className="mt-2 text-sm font-medium">
        Your vote
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-2 flex flex-col items-center gap-1">
      <input type="hidden" name="comment" value={comment} />
      <SubmitButton disabled={commentTooLong} />
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="border px-4 py-1 disabled:opacity-50"
    >
      {pending ? "Voting..." : "Vote"}
    </button>
  );
}
