"use client";

/**
 * Root-layout error boundary (issue #36), via the Next.js `global-error.js`
 * convention (see `./error.tsx`'s top comment). `./error.tsx` cannot catch
 * an exception thrown by `./layout.tsx` itself (e.g. its font setup) since
 * they're in the same segment - this is the last-resort fallback for that
 * case, and must define its own `<html>`/`<body>` since it replaces the
 * root layout entirely while active.
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ padding: "2rem", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p role="alert">
            We couldn&apos;t load this page. Please try again in a moment.
          </p>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
