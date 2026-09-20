/**
 * Instant loading state for `/dashboard` (issue #36), via the Next.js
 * `loading.js` convention (`node_modules/next/dist/docs/01-app/03-api-
 * reference/03-file-conventions/loading.md`) - automatically wraps
 * `./page.tsx` in a `<Suspense>` boundary, so this renders immediately while
 * the creator's brackets are being fetched, rather than a blank page during
 * that gap.
 *
 * Deliberately plain text, matching this app's existing minimal-Tailwind
 * style (e.g. `./bracket-list.tsx`'s "No drafts yet." empty-state
 * messages) - not a redesign, not a skeleton.
 */
export default function DashboardLoading() {
  return (
    <p role="status" aria-live="polite">
      Loading your brackets...
    </p>
  );
}
