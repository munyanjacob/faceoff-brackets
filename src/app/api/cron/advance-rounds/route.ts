import { prisma } from "@/lib/prisma";
import { findExpiredRounds } from "@/lib/rounds/find-expired-rounds";
import { evaluateRound } from "@/lib/rounds/evaluate-round";
import { findExpiredTieBreakers } from "@/lib/rounds/find-expired-tie-breakers";
import { resolveTieBreaker } from "@/lib/rounds/resolve-tie-breaker";

// GET /api/cron/advance-rounds
//
// Invoked on a schedule by Vercel Cron (see vercel.json), which always
// calls scheduled routes with GET. Authenticates the caller against the
// CRON_SECRET environment variable via a bearer token (#9).
//
// Two independent steps run on every authenticated invocation:
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
// Step 2 runs after step 1 on every invocation (not only when step 1 finds
// nothing) - a Matchup's tie-breaker window can expire independently of any
// Round's endsAt.
//
// Every unit of work (each Round in step 1, each Matchup in step 2) is
// evaluated/resolved independently - one throwing (a data anomaly, a
// transient DB error, etc.) is logged and skipped rather than aborting the
// rest of the batch, so a single bad Round/Bracket/Matchup can never block
// every other one from advancing. Nothing expired in either step is a safe
// no-op that still returns 200.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const expiredRounds = await findExpiredRounds(prisma);

  let evaluated = 0;
  let failed = 0;
  for (const round of expiredRounds) {
    try {
      await evaluateRound(round.id);
      evaluated++;
    } catch (error) {
      failed++;
      console.error(
        `[cron/advance-rounds] failed to evaluate round ${round.id}:`,
        error
      );
    }
  }

  const expiredTieBreakers = await findExpiredTieBreakers(prisma);

  let tieBreakersResolved = 0;
  let tieBreakersFailed = 0;
  for (const matchup of expiredTieBreakers) {
    try {
      await resolveTieBreaker(matchup.id);
      tieBreakersResolved++;
    } catch (error) {
      tieBreakersFailed++;
      console.error(
        `[cron/advance-rounds] failed to resolve tie-breaker for matchup ${matchup.id}:`,
        error
      );
    }
  }

  return Response.json({
    ok: true,
    expired: expiredRounds.length,
    evaluated,
    failed,
    expiredTieBreakers: expiredTieBreakers.length,
    tieBreakersResolved,
    tieBreakersFailed,
  });
}
