import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findExpiredRounds } from "@/lib/rounds/find-expired-rounds";
import { evaluateRound } from "@/lib/rounds/evaluate-round";
import { findExpiredTieBreakers } from "@/lib/rounds/find-expired-tie-breakers";
import { resolveTieBreaker } from "@/lib/rounds/resolve-tie-breaker";
import { findDueScheduledBrackets } from "@/lib/rounds/find-due-scheduled-brackets";
import { startScheduledBracket } from "@/lib/rounds/start-scheduled-bracket";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { preflightResponse, withCors } from "@/lib/api/cors";

// GET /api/cron/advance-rounds
//
// Invoked on a schedule by Vercel Cron (see vercel.json), which always
// calls scheduled routes with GET. Authenticates the caller against the
// CRON_SECRET environment variable via a bearer token (#9) - a static
// shared secret (docs/openapi.yaml's `cronSecret` security scheme), not a
// user-identity token, so unlike the creator-only endpoints this doesn't
// go through `@/lib/api/auth`'s Supabase-backed
// `getAuthenticatedUserId`/`unauthorizedResponse`.
//
// Three independent steps run on every authenticated invocation:
//
// Step 1 (#27): closes out Rounds whose time has expired.
//   1. Find every Round that's still ACTIVE but whose endsAt has passed
//      (#26's findExpiredRounds).
//   2. Call #20's evaluateRound on each one, which does all of the actual
//      closing/tie-breaking/next-round-creation work - including possibly
//      moving one of that Round's Matchups into TIE_BREAKER, which step 2
//      below later picks up once its own window expires.
//
// Step 2 (#29): resolves tie-breakers whose revote window has expired.
//   1. Find every Matchup that's still TIE_BREAKER but whose
//      tieBreakerEndsAt has passed (#29's findExpiredTieBreakers).
//   2. Call #29's resolveTieBreaker on each one, which tallies only the
//      votes cast during the tie-breaker window, applies #19's
//      determineWinner (falling back to a random pick if it ties again),
//      marks the Matchup COMPLETED, and re-runs evaluateRound for its Round
//      - since resolving the tie-breaker may be the last thing blocking
//      that Round from closing.
//
// Step 3 (#28): starts scheduled brackets whose start time has arrived.
//   1. Find every Bracket that's still SCHEDULED but whose scheduledStartAt
//      has passed (#28's findDueScheduledBrackets).
//   2. Call #28's startScheduledBracket on each one, which flips
//      Bracket.status to ACTIVE, flips round 1's Round.status and each
//      non-bye Matchup.status to ACTIVE, and stamps round 1's
//      startsAt/endsAt from the actual transition time (now) rather than
//      the originally scheduled time - so a late cron run doesn't
//      shortchange the round's effective duration.
//
// Steps run in order on every invocation regardless of what an earlier step
// found - none of them depend on another step having found (or not found)
// anything: a Matchup's tie-breaker window can expire independently of any
// Round's endsAt, and a Bracket's scheduled start is independent of both.
//
// Every unit of work (each Round in step 1, each Matchup in step 2, each
// Bracket in step 3) is evaluated/resolved/started independently - one
// throwing (a data anomaly, a transient DB error, etc.) is logged and
// skipped rather than aborting the rest of the batch, so a single bad
// Round/Bracket/Matchup can never block every other one from advancing.
// `runBatch` below is the one place that "for-await + try/catch + count"
// shape lives, shared by all three steps. Nothing due in any step is a
// safe no-op that still returns 200.

/**
 * Runs `fn` once per item in `items`, catching (rather than propagating)
 * any individual failure so one bad item never blocks the rest of the
 * batch - see the module doc comment above. Each failure is logged with
 * `label` and the failing item's id, e.g. `"evaluate round"` ->
 * `"failed to evaluate round <id>:"`.
 *
 * Returns how many items were in the batch and how many of those
 * succeeded vs. failed - `count` is always `succeeded + failed`.
 */
async function runBatch<T extends { id: string }>(
  items: T[],
  fn: (item: T) => Promise<void>,
  label: string
): Promise<{ count: number; succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    try {
      await fn(item);
      succeeded++;
    } catch (error) {
      failed++;
      console.error(
        `[cron/advance-rounds] failed to ${label} ${item.id}:`,
        error
      );
    }
  }

  return { count: items.length, succeeded, failed };
}

export const GET = async (request: Request): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return errorResponse(
        401,
        "UNAUTHORIZED",
        "Missing or incorrect bearer secret."
      );
    }

    const expiredRounds = await findExpiredRounds(prisma);
    const rounds = await runBatch(
      expiredRounds,
      (round) => evaluateRound(round.id),
      "evaluate round"
    );

    const expiredTieBreakers = await findExpiredTieBreakers(prisma);
    const tieBreakers = await runBatch(
      expiredTieBreakers,
      (matchup) => resolveTieBreaker(matchup.id),
      "resolve tie-breaker for matchup"
    );

    const dueScheduledBrackets = await findDueScheduledBrackets(prisma);
    const brackets = await runBatch(
      dueScheduledBrackets,
      (bracket) => startScheduledBracket(bracket.id),
      "start scheduled bracket"
    );

    return NextResponse.json({
      ok: true,
      expired: rounds.count,
      evaluated: rounds.succeeded,
      failed: rounds.failed,
      expiredTieBreakers: tieBreakers.count,
      tieBreakersResolved: tieBreakers.succeeded,
      tieBreakersFailed: tieBreakers.failed,
      dueScheduledBrackets: brackets.count,
      bracketsStarted: brackets.succeeded,
      bracketsStartFailed: brackets.failed,
    });
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
