/**
 * Instant loading state for `/dashboard/brackets/[id]/edit` (issue #36) -
 * see `../../../loading.tsx` for the `loading.js` convention this follows.
 * Not one of the pages issue #36's data-fetching criterion enumerates
 * (#8/#21/#40/#30/#33/#34), but this route fetches the bracket + its items
 * on every load and directly hosts the #11-#14 forms this same issue
 * already touches, so it gets the same treatment at effectively no extra
 * cost.
 */
export default function EditBracketLoading() {
  return (
    <p role="status" aria-live="polite">
      Loading bracket...
    </p>
  );
}
