import { prisma } from "@/lib/prisma";
import { findExpiredRounds } from "@/lib/rounds/find-expired-rounds";
import { evaluateRound } from "@/lib/rounds/evaluate-round";

// GET /api/cron/advance-rounds
//
// Invoked on a schedule by Vercel Cron (see vercel.json), which always
// calls scheduled routes with GET. Authenticates the caller against the
// CRON_SECRET environment variable via a bearer token (#9).
//
// Issue #27: step 1 of a two-step sequence (step 2 - resolving a Matchup
// that's already in TIE_BREAKER - is #29's job, wired up later in this same
// handler). On every authenticated invocation:
//   1. Find every Round that's still ACTIVE but whose endsAt has passed
//      (#26's findExpiredRounds).
//   2. Call #20's evaluateRound on each one, which does all of the actual
//      closing/tie-breaking/next-round-creation work.
//
// Each Round is evaluated independently - one Round's evaluateRound call
// throwing (a data anomaly, a transient DB error, etc.) is logged and
// skipped rather than aborting the rest of the batch, so a single bad
// Round/Bracket can never block every other expired Round from advancing.
// No expired Rounds is a safe no-op that still returns 200.
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

  return Response.json({ ok: true, expired: expiredRounds.length, evaluated, failed });
}
