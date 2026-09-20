import type { PrismaClient } from "@/generated/prisma/client";
import { BracketStatus } from "@/generated/prisma/enums";
import type { BracketModel } from "@/generated/prisma/models";

/**
 * Issue #28: identifies every `Bracket` that is still `SCHEDULED` but whose
 * `scheduledStartAt` has already passed - the candidates for transitioning
 * to a live, `ACTIVE` bracket.
 *
 * Deliberately read-only - it does not touch `Bracket.status`, `Round`, or
 * `Matchup` rows. Making the actual transition (flipping `Bracket.status`,
 * `Round.status`, and each non-bye `Matchup.status`, and stamping round 1's
 * `startsAt`/`endsAt`) is `startScheduledBracket`'s job, in this same
 * directory; this function only finds the candidates for that later step.
 * Style/shape mirrors `findExpiredRounds` (#26) and `findExpiredTieBreakers`
 * (#29) in this same directory - same "pure query, `PrismaClient` passed in,
 * `now` injectable for tests" pattern.
 *
 * A `SCHEDULED` bracket always has a non-null `scheduledStartAt` -
 * `publishBracket` (`publish-actions.ts`, #16/#18) only ever sets
 * `status = SCHEDULED` when `scheduledStartAt` was provided at publish time,
 * and there's no code path that clears it afterwards - so filtering on
 * `status = SCHEDULED` and `scheduledStartAt: { lt: now }` together can never
 * accidentally miss a due bracket because of a null `scheduledStartAt`; a
 * `DRAFT` bracket with a `scheduledStartAt` set but not yet published is
 * correctly excluded by the `status` filter alone (it hasn't been published,
 * so its round 1 rows may not even exist yet - see #18's `buildRoundOnePlan`,
 * which only ever runs from `publishBracket`).
 *
 * Takes a `PrismaClient` as a parameter (rather than importing the shared
 * `src/lib/prisma.ts` singleton), consistent with `findExpiredRounds`/
 * `findExpiredTieBreakers`, so this stays a plain, easily-unit-tested query
 * function decoupled from how the caller constructs its client.
 */
export function findDueScheduledBrackets(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<BracketModel[]> {
  return prisma.bracket.findMany({
    where: {
      status: BracketStatus.SCHEDULED,
      scheduledStartAt: { lt: now },
    },
  });
}
