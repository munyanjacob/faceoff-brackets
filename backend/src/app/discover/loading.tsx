/**
 * Instant loading state for `/discover` (issue #36) - see
 * `../dashboard/loading.tsx` for the `loading.js` convention this follows.
 */
export default function DiscoverLoading() {
  return (
    <main>
      <h1>Discover brackets</h1>
      <p role="status" aria-live="polite">
        Loading brackets...
      </p>
    </main>
  );
}
