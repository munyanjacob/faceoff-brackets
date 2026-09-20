import type { VoteFormState } from "./vote-actions";

/**
 * Split out of `./vote-actions.ts` (a "use server" file): Next.js 16 only
 * allows async functions to be exported from a "use server" module - see
 * `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`.
 * These are plain constants (`useActionState`'s initial state, user-facing
 * error strings, and the comment/rate-limit thresholds) that `./vote-actions.ts`
 * itself, `./vote-button.tsx`, and this feature's tests all need to reach -
 * none of them can be exported from the Server Action module anymore, so
 * they live here instead.
 */

export const initialVoteFormState: VoteFormState = {
  error: null,
  votedItemId: null,
};

export const SIGN_IN_TO_VOTE_ERROR = "Sign in to vote on this bracket.";
export const ROUND_CLOSED_ERROR = "Voting has closed for this round.";
export const MATCHUP_NOT_VOTABLE_ERROR =
  "Voting isn't open for this matchup.";
export const INVALID_ITEM_ERROR = "That's not a valid choice for this matchup.";
export const MATCHUP_NOT_FOUND_ERROR = "This matchup no longer exists.";
export const RATE_LIMIT_ERROR =
  "You've cast a lot of votes very quickly - please wait a few minutes and try again.";

/**
 * Issue #23's optional vote comment. 500 characters is comfortably more
 * than a short reaction (a couple of sentences) while still keeping a
 * `Vote` row's comment skimmable in a results list - the same "casual
 * polling, not a discussion forum" scope `./vote-actions.ts`'s rate-limit
 * comment above cites from `_docs/outdated/plan.md` SS7/SS8 (comment
 * *threads*, replies, likes are explicitly out of scope for the whole
 * MVP). Stated here, not just picked silently, per the issue's "pick a
 * specific number and state it" ask - also called out in the issue #23
 * comment.
 */
export const MAX_COMMENT_LENGTH = 500;
export const COMMENT_TOO_LONG_ERROR = `Comments can be at most ${MAX_COMMENT_LENGTH} characters.`;

/**
 * Basic anti-abuse rate limit (issue #35). Caps how many `Vote` rows a
 * single voter identifier - signed-in `userId` or anonymous
 * `anonymousVoterIdentifier`, i.e. `VoterLookupKey` - can create within a
 * rolling window, counted directly against the `Vote` table
 * (`prisma.vote.count`) rather than an external rate-limiting
 * library/service: AGENTS.md pins this project's dependencies and forbids
 * adding one without asking, and the `Vote.createdAt` column already gives
 * us everything a simple rolling-window count needs.
 *
 * Chosen threshold: 20 votes per identifier per rolling 10-minute window.
 * Reasoning (stated here and in the #35 issue comment/commit):
 *   - Generous for real usage: hitting 20 votes in 10 minutes means a
 *     distinct, deliberate matchup vote roughly every 30 seconds sustained
 *     for a full 10 minutes - well beyond "a handful of votes across
 *     different matchups/brackets in a session". A real voter casually
 *     browsing several brackets is never blocked.
 *   - Still meaningful against scripted abuse: a script trying to skew many
 *     matchups by voting through them in a tight loop is capped at 20
 *     inserts per 10 minutes (120/hour at best even retrying constantly),
 *     which meaningfully blunts a casual scripted attack without needing
 *     it to be airtight - this app is explicitly "casual polling, not
 *     election-grade" (`_docs/outdated/plan.md` SS7).
 *   - Does not, and per #35 is not meant to, stop an attacker who clears
 *     cookies between batches to get a fresh identifier - that reset is
 *     explicitly accepted as out of scope (it's inherent to a
 *     cookie-identifier approach; #35 only closes the *tamper* gap via
 *     cookie signing, not the *reset* gap).
 */
export const VOTE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const VOTE_RATE_LIMIT_MAX_VOTES = 20;

// Issue #36: a generic, user-facing fallback for a DB/Supabase failure that
// isn't one of the specific errors above - e.g. the database being
// temporarily unreachable. Rendered inline by `./vote-button.tsx` the same
// way as any other `state.error`, rather than letting the exception
// propagate into Next's generic error boundary/blank page.
export const UNEXPECTED_ERROR = "Something went wrong. Please try again.";
