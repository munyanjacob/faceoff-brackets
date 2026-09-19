import type { PrismaClient } from "@/generated/prisma/client";
import { RoundStatus } from "@/generated/prisma/enums";
import type { RoundModel } from "@/generated/prisma/models";

/**
 * Issue #26: identifies every `Round` that is still `ACTIVE` but whose
 * `endsAt` has already passed, across every bracket, in a single query.
 *
 * Deliberately read-only - it does not close the round or touch any
 * `Matchup` row. Closing a round and evaluating/tie-breaking its matchups
 * is #20, wired up from the cron endpoint by #27; this function only finds
 * the candidates for that later step.
 *
 * A round can be `ACTIVE` while one of its own matchups has already moved
 * to `TIE_BREAKER` (see #20/#29 - tie-breaker state lives on `Matchup`, not
 * `Round`, since a round can have some matchups decided and one still in a
 * tie-breaker). This query filters only on `Round.status`/`Round.endsAt`
 * and never joins/filters on `Matchup`, so it finds an expired round
 * regardless of what state its matchups are in.
 *
 * Takes a `PrismaClient` as a parameter rather than importing a shared
 * singleton: no `src/lib/prisma.ts` exists on this branch yet (it's being
 * added on `track-a-creator-flow` issue #8, which also had to add the
 * `@prisma/adapter-pg` dependency Prisma 7's generated client requires to
 * construct a working client at all - see that issue's comments). Issue
 * #26's constraints don't grant the same "create the one shared client"
 * exception #8 got, and AGENTS.md requires asking before adding a
 * dependency, so this function stays decoupled from how the caller
 * constructs its client - whichever `PrismaClient` instance #27's cron
 * endpoint ends up with (presumably #8's `src/lib/prisma.ts` once the
 * tracks merge) can be passed straight in.
 */
export function findExpiredRounds(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<RoundModel[]> {
  return prisma.round.findMany({
    where: {
      status: RoundStatus.ACTIVE,
      endsAt: { lt: now },
    },
  });
}
