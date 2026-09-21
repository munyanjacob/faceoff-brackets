"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "./countdown";

/**
 * Issue #25's live-updating countdown for the matchup currently being voted
 * on. A Client Component (needs `useEffect`/`useState` to re-render on a
 * timer, per `node_modules/next/dist/docs/01-app/03-api-reference/
 * 01-directives/use-client.md`) wrapped around `./countdown.ts`'s pure
 * `formatCountdown` - this file only owns "re-run the pure calculation
 * periodically and render its result". The interesting logic (the time
 * math, the terminal "closing" state) lives in `./countdown.ts` and is
 * unit-tested there with an injectable `now`; this component's own
 * timer/interval wiring has no rendering test of its own, matching this
 * codebase's established "no client-component rendering tests" convention -
 * see `./vote-button.tsx`'s top comment for the precedent and reasoning
 * (its own "Vote"/pending-state rendering is likewise only covered
 * indirectly, via `./vote-actions.ts`'s tests).
 *
 * Rendered as a real `<CountdownDisplay ... />` element (like
 * `./vote-button.tsx`'s `<VoteButton>`), not called as a plain function -
 * same reasoning as that file: a Client Component needs to actually mount
 * for its hooks to run, which calling it as a plain function wouldn't do.
 *
 * Ticks once a second, not once a minute: `formatCountdown`'s own display
 * text only changes at minute granularity, but a second-level interval means
 * the terminal "closing" state appears within a second of `endsAt` passing
 * (issue #25's "never a negative number" criterion) rather than up to a
 * minute late. The extra ticks in between are cheap - this is a single text
 * node with no other work happening on each one.
 */
export function CountdownDisplay({ endsAt }: { endsAt: Date | string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const countdown = formatCountdown(endsAt, now);

  return (
    <p aria-live="polite" className="text-sm text-gray-600">
      {countdown.status === "counting"
        ? `Voting closes in ${countdown.display}`
        : countdown.display}
    </p>
  );
}
