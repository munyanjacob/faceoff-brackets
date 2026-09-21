"use client";

/**
 * Root error boundary (issue #36), via the Next.js `error.js` convention
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-
 * conventions/error.md`). Catches any uncaught exception thrown while
 * rendering a Server Component below the root layout - most importantly, a
 * data-fetching page's `prisma`/Supabase call failing (e.g. the database
 * being temporarily unreachable) - and shows a plain, user-facing message
 * instead of Next's generic error page or a blank screen.
 *
 * `error.js` wraps every nested `layout.js`/`page.js` below the root layout
 * (including `../dashboard/layout.tsx`'s auth check and every route's own
 * `page.tsx`), so this single boundary covers the whole app without a
 * per-route copy - consistent with this being a review-and-patch pass, not a
 * redesign. It does not, and cannot, wrap `./layout.tsx` itself (the root
 * layout is in the same segment as this file) - `./global-error.tsx` is the
 * fallback for that case.
 *
 * Error boundaries must be Client Components (per the convention). Uses the
 * `retry` prop (stable as of this project's Next.js version - see
 * `error.md`'s Version History) rather than the older `reset`, so "Try
 * again" re-fetches and re-renders the failed segment instead of just
 * clearing local error state.
 */
export default function GlobalErrorBoundary({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p role="alert" className="text-sm text-gray-600">
        We couldn&apos;t load this page. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="border px-4 py-1"
      >
        Try again
      </button>
    </main>
  );
}
