/**
 * Pure round/tie-breaker countdown math (issue #25). Kept separate from
 * `./countdown-display.tsx` (the "use client" component that re-runs this on
 * a timer) for the same reason `./voting-view-model.ts`'s pure functions are
 * split from `./matchup-voting.tsx`'s rendering - so the actual time math can
 * be unit-tested without a DOM, a timer, or React at all. Modeled on
 * `src/lib/rounds/evaluate-round.ts`'s injectable `now` parameter: tests
 * here pass a fixed `now`, `./countdown-display.tsx` passes `new Date()` on
 * every tick.
 *
 * `endsAt` is accepted as a `Date` or an ISO string - either the active
 * `Round.endsAt` or, during a tie-breaker, `Matchup.tieBreakerEndsAt` (see
 * `./countdown-display.tsx`'s and `./matchups/[matchupId]/page.tsx`'s top
 * comments for which one a caller picks and why); a plain Prisma row already
 * hands back a `Date`, but accepting a string too means a value that's been
 * round-tripped through JSON (e.g. serialized into a client bundle) doesn't
 * need to be converted back to a `Date` first.
 */
export type CountdownResult =
  | { status: "counting"; display: string }
  | { status: "closing"; display: string };

/**
 * Issue #25's third acceptance criterion: once `endsAt` has passed, show a
 * clear terminal state instead of a negative duration - this covers the gap
 * between `endsAt` passing and the cron job (#26/#27, out of scope here)
 * actually closing the round or resolving the tie-breaker.
 */
export const CLOSING_DISPLAY =
  "Closing soon - hang tight while the round wraps up.";

/**
 * Formats the time remaining until `endsAt`, or the terminal "closing" state
 * once it's passed. Deliberately minute-granularity (no seconds shown) - the
 * issue only asks for something like "23h 14m remaining", and dropping
 * seconds keeps the string stable across `./countdown-display.tsx`'s
 * once-a-second ticks except when a whole minute actually elapses.
 *
 * `msRemaining <= 0` (not `< 0`) treats the exact instant `endsAt` is reached
 * as already "closing", not "0m remaining" - matches the issue's "never a
 * negative number" criterion at the boundary too, not just once time has
 * gone negative.
 */
export function formatCountdown(
  endsAt: Date | string,
  now: Date = new Date()
): CountdownResult {
  const end = typeof endsAt === "string" ? new Date(endsAt) : endsAt;
  const msRemaining = end.getTime() - now.getTime();

  if (msRemaining <= 0) {
    return { status: "closing", display: CLOSING_DISPLAY };
  }

  const totalMinutes = Math.floor(msRemaining / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return { status: "counting", display: `${days}d ${hours}h remaining` };
  }
  if (hours > 0) {
    return { status: "counting", display: `${hours}h ${minutes}m remaining` };
  }
  if (minutes > 0) {
    return { status: "counting", display: `${minutes}m remaining` };
  }
  // Under a minute but still > 0ms left - "0m remaining" would read like
  // it's already over, which is exactly what the "closing" state above is
  // for; this is the last sliver of real time still remaining.
  return { status: "counting", display: "less than a minute remaining" };
}
