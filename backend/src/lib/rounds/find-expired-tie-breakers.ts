import type { PrismaClient } from "@/generated/prisma/client";
import { MatchupStatus } from "@/generated/prisma/enums";
import type { MatchupModel } from "@/generated/prisma/models";

/**
 * Issue #29: identifies every `Matchup` that is still `TIE_BREAKER` but
 * whose `tieBreakerEndsAt` has already passed, across every round/bracket,
 * in a single query.
 *
 * Deliberately read-only - it does not resolve the tie-breaker or touch any
 * row. Resolving it (tallying the tie-breaker-window votes, applying #19's
 * `determineWinner`, and re-running #20's `evaluateRound`) is
 * `resolveTieBreaker`'s job; this function only finds the candidates for
 * that later step. Style/shape mirrors #26's `findExpiredRounds` in this
 * same directory - same "pure query, PrismaClient passed in, `now`
 * injectable for tests" pattern.
 *
 * Takes a `PrismaClient` as a parameter (rather than importing the shared
 * `src/lib/prisma.ts` singleton) so this stays a plain, easily-unit-tested
 * query function decoupled from how the caller constructs its client -
 * consistent with `findExpiredRounds`, even though `src/lib/prisma.ts` does
 * exist on this branch (unlike when #26 was written).
 */
export function findExpiredTieBreakers(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<MatchupModel[]> {
  return prisma.matchup.findMany({
    where: {
      status: MatchupStatus.TIE_BREAKER,
      tieBreakerEndsAt: { lt: now },
    },
  });
}
