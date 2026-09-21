"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Issue #23's optional vote comment: a single textarea shared by both of a
 * matchup's `<VoteButton>`s (`./vote-button.tsx`), rendered once "below
 * both" per `./matchup-voting.tsx`'s top comment (which itself quotes
 * `_docs/outdated/plan.md` SS13's mockup) rather than duplicated per item.
 *
 * A matchup only ever has one vote-and-comment action, but that action is
 * invoked from *two* independent `<form>`s (one per item's `<VoteButton>`,
 * each with its own `useActionState` instance - see that file's top
 * comment for why they're kept separate rather than merged into one form).
 * Whichever form is actually submitted needs the current comment text in
 * its `FormData`. Since the visible textarea below both items can't
 * physically live inside both `<form>` elements at once, this Context is
 * the shared piece of client state that both:
 *  - `CommentField` (this file) writes to as the voter types, and
 *  - `./vote-button.tsx`'s `<VoteButton>` reads from, to populate a
 *    hidden `name="comment"` input inside *its own* form - so whichever
 *    button is actually clicked submits the same, current comment text.
 *
 * The textarea itself is deliberately not inside either `<form>` - it has
 * no submit control of its own, so there is no way to submit a comment
 * without also casting a vote (issue #23's "no comment-only submission
 * path" criterion).
 */
export const MAX_COMMENT_LENGTH = 500;

type CommentContextValue = {
  comment: string;
  setComment: (value: string) => void;
};

const CommentContext = createContext<CommentContextValue | null>(null);

export function CommentProvider({ children }: { children: ReactNode }) {
  const [comment, setComment] = useState("");
  return (
    <CommentContext.Provider value={{ comment, setComment }}>
      {children}
    </CommentContext.Provider>
  );
}

/**
 * Read-only accessor for `./vote-button.tsx`. Returns `""` when rendered
 * outside a `CommentProvider` rather than throwing - defensive only;
 * `./matchup-voting.tsx` always wraps a matchup's `<VoteButton>`s in one
 * whenever it renders them at all (see that file's `MatchupPanel`), so this
 * fallback is never expected to be exercised in practice.
 */
export function useVoteComment(): string {
  const ctx = useContext(CommentContext);
  return ctx?.comment ?? "";
}

/**
 * The visible comment textarea, with a live character-count affordance.
 * Issue #23 requires an over-the-limit comment to be *rejected*, not
 * silently truncated - so this deliberately has no `maxLength` attribute
 * (which would truncate pasted text at the browser level). Instead, going
 * over `MAX_COMMENT_LENGTH` shows a visible warning and disables both
 * `<VoteButton>`s (via the same Context) until the voter shortens it -
 * client-side UX only. `./vote-actions.ts`'s `castVote` independently
 * re-validates the same limit server-side regardless (never trusting that
 * this button was actually disabled), the same "not just a hidden button"
 * reasoning as every other check in that file.
 */
export function CommentField() {
  const ctx = useContext(CommentContext);
  const comment = ctx?.comment ?? "";
  const setComment = ctx?.setComment ?? (() => {});
  const overLimit = comment.length > MAX_COMMENT_LENGTH;

  return (
    <div className="mt-4 flex flex-col gap-1">
      <label htmlFor="vote-comment" className="text-sm font-medium">
        Comment (optional)
      </label>
      <textarea
        id="vote-comment"
        rows={3}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        aria-describedby="vote-comment-count"
        aria-invalid={overLimit}
        className="border p-2 text-sm"
      />
      <p
        id="vote-comment-count"
        role={overLimit ? "alert" : undefined}
        className={overLimit ? "text-xs text-red-600" : "text-xs text-gray-500"}
      >
        {comment.length}/{MAX_COMMENT_LENGTH}
        {overLimit
          ? ` - remove ${comment.length - MAX_COMMENT_LENGTH} character${
              comment.length - MAX_COMMENT_LENGTH === 1 ? "" : "s"
            } to vote`
          : null}
      </p>
    </div>
  );
}
