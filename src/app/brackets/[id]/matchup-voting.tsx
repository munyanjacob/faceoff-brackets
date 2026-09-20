import { CommentField, CommentProvider } from "./comment-field";
import { VoteButton } from "./vote-button";
import type {
  VoterContext,
  VotingItem,
  VotingMatchup,
  VotingState,
} from "./voting-view-model";

/**
 * `/brackets/[id]`'s presentational content (issue #21, vote buttons wired
 * up for real by issue #22): either one matchup's two items side by side, or
 * an explanatory status message. Shared, unchanged, by two routes as of
 * issue #40 - `/brackets/[id]/page.tsx` (the common case: its round has
 * exactly one votable matchup, so it redirects straight into the matchup
 * route below rather than ever calling this itself - see that file and
 * `./voting-view-model.ts`'s top comment) and the new
 * `./matchups/[matchupId]/page.tsx` (every case, including that common one,
 * now scoped to one specific matchup id from the URL instead of "whichever
 * one `determineVotingState` picks"). `/brackets/[id]/page.tsx` still calls
 * this directly for its own bracket-level status messages (not-started/
 * completed/between-rounds - see `./matchup-index.tsx`'s doc comment for
 * why those don't move to the matchup route). Follows the same "call
 * sub-components as plain functions, not JSX elements" pattern as
 * `../../discover/discovery-groups.tsx`/`../../dashboard/bracket-list.tsx`,
 * so this codebase's page tests can introspect the returned tree via
 * `JSON.stringify` (which can't see into an unrendered `<Component ... />`
 * element, since its `type` is a function reference that gets dropped) -
 * `./vote-button.tsx`'s `<VoteButton>` is the one deliberate exception:
 * it's a real client component (it needs `useActionState`/`useFormStatus`),
 * so it's rendered as an actual element, not called as a plain function -
 * its own internal render (the "Vote" text, pending/error state) is
 * intentionally opaque to `JSON.stringify` for that reason, and is instead
 * covered by `./vote-actions.ts`'s tests, not a rendering test here (this
 * codebase has no client-component rendering tests anywhere else either -
 * see e.g. `../../dashboard/brackets/[id]/edit/item-row.tsx` having no
 * `item-row.test.tsx`).
 *
 * Issue #23's comment field is rendered below both items (per
 * `_docs/outdated/plan.md` SS13's mockup - image+title stacked per item, a
 * vote button under each, an optional comment field below both), not
 * duplicated per item - see `./comment-field.tsx`'s top comment for how its
 * value reaches whichever of the two `<VoteButton>`s actually gets
 * submitted. `MatchupPanel` below only renders it (wrapped in a
 * `CommentProvider`) when at least one `<VoteButton>` is actually being
 * shown - blocked voters and voters who've already voted see neither.
 */
export function MatchupVoting({
  bracketTitle,
  votingState,
  voterContext,
}: {
  bracketTitle: string;
  votingState: VotingState;
  voterContext: VoterContext;
}) {
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{bracketTitle}</h1>
      {votingState.kind === "no-active-matchup"
        ? StatusMessage({ message: votingState.message })
        : MatchupPanel({
            matchup: votingState.matchup,
            isTieBreaker: votingState.isTieBreaker,
            voterContext,
          })}
    </main>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite">
      {message}
    </p>
  );
}

/**
 * `matchup.itemA`/`matchup.itemB` are guaranteed non-null by
 * `determineVotingState`'s own `votableMatchup` filter (see
 * `./voting-view-model.ts`) before a `{ kind: "matchup" }` state is ever
 * produced - the null check here is only a defensive type-narrowing guard
 * (same reasoning as `./page.tsx`'s `if (!user)` after the layout already
 * guarantees a signed-in user), not a second real branch this page expects
 * to hit.
 */
function MatchupPanel({
  matchup,
  isTieBreaker,
  voterContext,
}: {
  matchup: VotingMatchup;
  isTieBreaker: boolean;
  voterContext: VoterContext;
}) {
  if (!matchup.itemA || !matchup.itemB) {
    return StatusMessage({
      message: "Voting isn't open right now - check back soon for the next round.",
    });
  }
  const completeMatchup = matchup as VotingMatchup & {
    itemA: VotingItem;
    itemB: VotingItem;
  };

  return (
    <section aria-label="Current matchup" className="flex flex-col gap-4">
      {isTieBreaker
        ? StatusMessage({
            message:
              "This matchup tied and is now in a tie-breaker vote.",
          })
        : null}
      {/*
        issue #22's "voting is blocked with a message directing them to
        sign in" criterion - shown once for the matchup, not duplicated per
        item. Both items still render (read-only, no vote control) below -
        the block is only on the *action*, not on seeing the matchup.
      */}
      {voterContext.kind === "blocked"
        ? StatusMessage({ message: voterContext.message })
        : null}
      {VotingArea({ matchup: completeMatchup, voterContext })}
    </section>
  );
}

/**
 * The two `ItemPanel`s side by side, plus issue #23's shared comment field
 * below them when there's actually a vote to attach it to - `voterContext`
 * is blocked, or the voter already has a `Vote` on this matchup, means
 * neither item renders a `<VoteButton>` (see `VoteControl` below), so
 * there's nothing for a comment to attach to either.
 */
function VotingArea({
  matchup,
  voterContext,
}: {
  matchup: VotingMatchup & { itemA: VotingItem; itemB: VotingItem };
  voterContext: VoterContext;
}) {
  const itemsRow = (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
      {ItemPanel({ matchupId: matchup.id, item: matchup.itemA, voterContext })}
      {ItemPanel({ matchupId: matchup.id, item: matchup.itemB, voterContext })}
    </div>
  );

  const canStillVote =
    voterContext.kind === "eligible" && voterContext.existingVoteItemId === null;

  if (!canStillVote) {
    return itemsRow;
  }

  return (
    <CommentProvider>
      {itemsRow}
      <CommentField />
    </CommentProvider>
  );
}

function ItemPanel({
  matchupId,
  item,
  voterContext,
}: {
  matchupId: string;
  item: VotingItem;
  voterContext: VoterContext;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-2 border p-4 sm:w-72" key={item.id}>
      {item.imageUrl ? (
        // A plain <img> is used deliberately here, not next/image - same
        // reasoning as ../../dashboard/brackets/[id]/edit/item-row.tsx's
        // comment: these are user-uploaded, unknown-aspect-ratio images
        // from an external (Supabase Storage) domain.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt={item.title}
          className="h-48 w-48 object-cover"
        />
      ) : (
        <div
          role="img"
          aria-label={`No image provided for ${item.title}`}
          className="flex h-48 w-48 items-center justify-center border border-dashed bg-gray-100 text-sm text-gray-500"
        >
          No image
        </div>
      )}

      <p className="text-center text-lg font-medium">{item.title}</p>
      {item.description ? (
        <p className="text-center text-sm text-gray-600">{item.description}</p>
      ) : null}

      {VoteControl({ matchupId, item, voterContext })}
    </div>
  );
}

/**
 * Issue #22's three post-#21 states for the area below an item's
 * title/description, in order of precedence:
 *  1. `voterContext.kind === "blocked"` (ACCOUNT_REQUIRED, signed out) - no
 *     control at all; the single explanatory message above already covers
 *     both items.
 *  2. An existing vote already found for this matchup (whether from before
 *     this page load, or from a just-submitted `<VoteButton>` reporting its
 *     result) - show which item it was for, nothing on the other.
 *  3. Otherwise, a real `<VoteButton>` (issue #22's actual submission path -
 *     see `./vote-button.tsx`).
 */
function VoteControl({
  matchupId,
  item,
  voterContext,
}: {
  matchupId: string;
  item: VotingItem;
  voterContext: VoterContext;
}) {
  if (voterContext.kind === "blocked") {
    return null;
  }

  if (voterContext.existingVoteItemId) {
    return voterContext.existingVoteItemId === item.id
      ? (
          <p aria-live="polite" className="mt-2 text-sm font-medium">
            Your vote
          </p>
        )
      : null;
  }

  return <VoteButton matchupId={matchupId} itemId={item.id} />;
}
