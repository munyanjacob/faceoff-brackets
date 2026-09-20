import type { VotingItem, VotingMatchup, VotingState } from "./voting-view-model";

/**
 * `/brackets/[id]`'s presentational content (issue #21): either the current
 * matchup's two items side by side, or an explanatory status message.
 * Follows the same "call sub-components as plain functions, not JSX
 * elements" pattern as `../../discover/discovery-groups.tsx`/
 * `../../dashboard/bracket-list.tsx`, so this codebase's page tests can
 * introspect the returned tree via `JSON.stringify` (which can't see into
 * an unrendered `<Component ... />` element, since its `type` is a function
 * reference that gets dropped).
 *
 * Layout intentionally leaves room below the two vote buttons for #23's
 * comment field (per `_docs/outdated/plan.md` SS13's mockup - image+title
 * stacked per item, a vote button under each, an optional comment field
 * below both) rather than, say, putting each item in its own bordered card
 * that would visually "close off" before a comment field could be added.
 */
export function MatchupVoting({
  bracketTitle,
  votingState,
}: {
  bracketTitle: string;
  votingState: VotingState;
}) {
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{bracketTitle}</h1>
      {votingState.kind === "no-active-matchup"
        ? StatusMessage({ message: votingState.message })
        : MatchupPanel({
            matchup: votingState.matchup,
            isTieBreaker: votingState.isTieBreaker,
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
}: {
  matchup: VotingMatchup;
  isTieBreaker: boolean;
}) {
  if (!matchup.itemA || !matchup.itemB) {
    return StatusMessage({
      message: "Voting isn't open right now - check back soon for the next round.",
    });
  }

  return (
    <section aria-label="Current matchup" className="flex flex-col gap-4">
      {isTieBreaker
        ? StatusMessage({
            message:
              "This matchup tied and is now in a tie-breaker vote.",
          })
        : null}
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
        {ItemPanel({ item: matchup.itemA })}
        {ItemPanel({ item: matchup.itemB })}
      </div>
    </section>
  );
}

function ItemPanel({ item }: { item: VotingItem }) {
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

      {/*
        Placeholder only (issue #21's last acceptance criterion): this does
        not submit a vote. #22 wires this up to a real Server Action.
      */}
      <button
        type="button"
        disabled
        title="Voting isn't available yet"
        className="mt-2 border px-4 py-1 disabled:opacity-50"
      >
        Vote
      </button>
    </div>
  );
}
