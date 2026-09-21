import { prisma } from "@/lib/prisma";
import { BracketStatus, RoundStatus, MatchupStatus } from "@/generated/prisma/enums";

/**
 * Issue #28: transitions a single `Bracket` whose scheduled start time has
 * arrived from `SCHEDULED` to a live, `ACTIVE` bracket. Detecting *which*
 * brackets are due is `findDueScheduledBrackets`'s job, in this same
 * directory; this only performs the actual transition for one already-due
 * bracket id, the same "find, then act" split #26/#20 and #29/#29 already
 * established for round-expiry and tie-breaker resolution.
 *
 * What it does, for the given `Bracket`'s round 1 (created `PENDING`,
 * already paired, by #18's `buildRoundOnePlan` at publish time):
 * - `Bracket.status` -> `ACTIVE`.
 * - `Round.status` -> `ACTIVE` for round 1.
 * - Round 1's `startsAt` is set to `now` (the actual transition time - i.e.
 *   whenever this cron check happens to run, not the originally scheduled
 *   `scheduledStartAt`) and `endsAt = startsAt + durationMinutes` - so a
 *   cron run that's late (e.g. Vercel Hobby's up-to-an-hour cron timing
 *   slop) never shortchanges the round's effective voting window.
 * - Every round-1 `Matchup` still `PENDING` -> `ACTIVE`. A bye matchup is
 *   never `PENDING` at this point - `buildRoundOnePlan` always creates a bye
 *   as `COMPLETED` with `winnerItemId` already set, for both an immediate
 *   and a scheduled start - so filtering the update on `status: PENDING`
 *   naturally flips only the real (non-bye) matchups and leaves byes alone,
 *   with no separate `itemBId` check needed.
 *
 * All three writes happen inside one `prisma.$transaction`, the same
 * reasoning `evaluateRound` (#20) and `publishBracket` (#16/#18) already
 * give for their own multi-row transitions: a bracket can never be left
 * half-transitioned (e.g. `Bracket.status = ACTIVE` with round 1 still
 * `PENDING`) if a write fails partway through.
 *
 * Re-checking `Bracket.status === SCHEDULED` before writing anything makes a
 * duplicate/concurrent cron invocation for the same bracket id a safe no-op
 * rather than a double-transition or a thrown error - the same
 * "no longer in the expected state -> nothing left to do" convention
 * `resolveTieBreaker` (#29) already uses for a `Matchup` that's no longer
 * `TIE_BREAKER` when it's read.
 *
 * Uses the shared `src/lib/prisma.ts` singleton rather than taking a
 * `PrismaClient` parameter - the same convention `evaluateRound`/
 * `resolveTieBreaker` already use for code that performs the actual
 * closing/starting writes (only the read-only "find due X" queries take a
 * `PrismaClient` parameter, per those files' own doc comments).
 *
 * @param bracketId The `SCHEDULED` bracket to start.
 * @param now Injectable for tests; defaults to the real current time. Used
 * for round 1's `startsAt`/`endsAt`.
 */
export async function startScheduledBracket(
  bracketId: string,
  now: Date = new Date()
): Promise<void> {
  const bracket = await prisma.bracket.findUnique({
    where: { id: bracketId },
    include: {
      rounds: { where: { roundNumber: 1 } },
    },
  });

  if (!bracket) {
    throw new Error(
      `startScheduledBracket: no Bracket found with id ${bracketId}`
    );
  }

  if (bracket.status !== BracketStatus.SCHEDULED) {
    // Already started (e.g. a previous/concurrent cron invocation got to it
    // first) - nothing left to do.
    return;
  }

  const round1 = bracket.rounds[0];
  if (!round1) {
    // Shouldn't happen - a SCHEDULED bracket always got its round 1 created
    // (PENDING) by publishBracket (#16/#18) in the same transaction that set
    // status = SCHEDULED. Fail loudly rather than silently leaving the
    // bracket ACTIVE with no round to show.
    throw new Error(
      `startScheduledBracket: Bracket ${bracketId} is SCHEDULED but has no round 1`
    );
  }

  const startsAt = now;
  const endsAt = new Date(startsAt.getTime() + round1.durationMinutes * 60_000);

  await prisma.$transaction(async (tx) => {
    await tx.bracket.update({
      where: { id: bracketId },
      data: { status: BracketStatus.ACTIVE },
    });

    await tx.round.update({
      where: { id: round1.id },
      data: { status: RoundStatus.ACTIVE, startsAt, endsAt },
    });

    await tx.matchup.updateMany({
      where: { roundId: round1.id, status: MatchupStatus.PENDING },
      data: { status: MatchupStatus.ACTIVE },
    });
  });
}
