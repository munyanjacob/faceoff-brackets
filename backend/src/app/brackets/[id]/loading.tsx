/**
 * Instant loading state for `/brackets/[id]` (issue #36) - see
 * `../../dashboard/loading.tsx` for the `loading.js` convention this
 * follows. Also covers the nested `./matchups/[matchupId]` and
 * `./tree` segments while their own bracket lookup is in flight, unless
 * those segments have a more specific `loading.tsx` of their own (they do -
 * `loading.js` only applies to its own segment and anything below it that
 * doesn't supply its own).
 */
export default function BracketVotingLoading() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <p role="status" aria-live="polite">
        Loading matchup...
      </p>
    </main>
  );
}
