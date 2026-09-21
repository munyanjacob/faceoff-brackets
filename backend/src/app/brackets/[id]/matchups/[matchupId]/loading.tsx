/**
 * Instant loading state for `/brackets/[id]/matchups/[matchupId]` (issue
 * #36) - see `../../../../dashboard/loading.tsx` for the `loading.js`
 * convention this follows.
 */
export default function MatchupVotingLoading() {
  return (
    <main className="flex flex-col gap-6 p-6">
      <p role="status" aria-live="polite">
        Loading matchup...
      </p>
    </main>
  );
}
