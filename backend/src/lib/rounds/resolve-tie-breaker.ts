import { prisma } from "@/lib/prisma";
import { determineWinner } from "@/lib/bracket-engine/determine-winner";
import { evaluateRound } from "@/lib/rounds/evaluate-round";
import { MatchupStatus, VotePhase } from "@/generated/prisma/enums";

/**
 * Issue #29: resolves a single `Matchup` that is (or, a moment ago, was)
 * `TIE_BREAKER` and whose `tieBreakerEndsAt` has passed - the second half of
 * tie-breaker handling. Entering a tie-breaker (`status = TIE_BREAKER` +
 * `tieBreakerEndsAt`) is #20's `evaluateRound`'s job, not this function's;
 * this only detects/resolves an *ended* one, found by
 * `findExpiredTieBreakers` in this same directory.
 *
 * Only `Vote` rows with `phase = TIE_BREAKER` for this matchup count toward
 * the tie-breaker's tally - votes cast during the original round stay in
 * the database (for history/comments) but are excluded, per #29's
 * acceptance criteria. This is why `resolveTieBreaker` re-tallies votes
 * itself rather than reusing `evaluateRound`'s unfiltered `vote.count`
 * calls.
 *
 * Issue #41: this used to reconstruct "when did the tie-breaker start?"
 * from `tieBreakerEndsAt` and the Round's `durationMinutes` (there was no
 * column recording it directly), and filtered on `Vote.createdAt` against
 * that reconstructed timestamp. Now that `Vote.phase` exists and is the
 * authoritative record of which round/window a vote belongs to - set by
 * `../../app/brackets/[id]/vote-actions.ts`'s `castVote` from the
 * matchup's status at the moment the vote was cast, not inferred
 * after the fact - the tally below filters on `phase = TIE_BREAKER`
 * directly instead. This also means a voter who already voted while the
 * matchup was `ACTIVE` and then cast an independent revote once it became
 * `TIE_BREAKER` (issue #41) has only their `TIE_BREAKER`-phase vote counted
 * here; their original vote persists in the table (per #29's "kept for
 * history" treatment) but is excluded from this tally, exactly like any
 * other `ORIGINAL`-phase vote.
 *
 * Outcome, from #19's `determineWinner` applied to that filtered tally:
 * - A clear "A"/"B" result sets `winnerItemId` and `status = COMPLETED`.
 * - A "TIE" result (tied again) picks a winner uniformly at random between
 *   the two items and sets `winnerItemId`/`status = COMPLETED` from that -
 *   there is no third tie-breaker round; the acceptance criteria only ever
 *   call for one revote window.
 *
 * After resolving, calls #20's `evaluateRound` again for the Matchup's
 * Round, since resolving the last open tie-breaker may be the only thing
 * that was blocking that Round from closing.
 *
 * A Matchup that isn't (or is no longer) `TIE_BREAKER` when read here is
 * left untouched - a safe no-op rather than an error, so a concurrent/
 * duplicate cron invocation resolving the same Matchup twice can't corrupt
 * it or throw.
 *
 * @param matchupId The `TIE_BREAKER` Matchup to resolve.
 * @param now Injectable for tests; defaults to the real current time. Passed
 * through to `evaluateRound` for its own `now`-dependent behaviour (the next
 * Round's `startsAt`/`endsAt`, or a *new* tie-breaker deadline if resolving
 * this one reveals another tied Matchup in the same Round).
 * @param random Injectable for tests; defaults to `Math.random`. Used only
 * to break a tie-breaker that ties again - `< 0.5` picks itemA, otherwise
 * itemB, giving each a uniform 50/50 chance.
 */
export async function resolveTieBreaker(
  matchupId: string,
  now: Date = new Date(),
  random: () => number = Math.random
): Promise<void> {
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
  });

  if (!matchup) {
    throw new Error(`resolveTieBreaker: no Matchup found with id ${matchupId}`);
  }

  if (matchup.status !== MatchupStatus.TIE_BREAKER) {
    // Already resolved (e.g. a previous/concurrent cron invocation got to
    // it first) - nothing left to do.
    return;
  }

  if (!matchup.itemAId || !matchup.itemBId || !matchup.tieBreakerEndsAt) {
    // Shouldn't happen - only evaluateRound's tie-breaker branch ever sets
    // status = TIE_BREAKER, and it always sets tieBreakerEndsAt and only
    // ever does so for a Matchup that already has both items. Fail loudly
    // rather than silently resolving a malformed Matchup.
    throw new Error(
      `resolveTieBreaker: Matchup ${matchupId} is TIE_BREAKER but is missing itemAId/itemBId/tieBreakerEndsAt`
    );
  }

  // Issue #41: `phase` is the authoritative record of which round/window a
  // vote belongs to - see the doc comment above. No timestamp
  // reconstruction needed.
  const [votesForA, votesForB] = await Promise.all([
    prisma.vote.count({
      where: {
        matchupId: matchup.id,
        itemId: matchup.itemAId,
        phase: VotePhase.TIE_BREAKER,
      },
    }),
    prisma.vote.count({
      where: {
        matchupId: matchup.id,
        itemId: matchup.itemBId,
        phase: VotePhase.TIE_BREAKER,
      },
    }),
  ]);

  const outcome = determineWinner(votesForA, votesForB);

  let winnerItemId: string;
  if (outcome === "A") {
    winnerItemId = matchup.itemAId;
  } else if (outcome === "B") {
    winnerItemId = matchup.itemBId;
  } else {
    // Tied again - pick uniformly at random between the two items, per
    // #29's acceptance criteria.
    winnerItemId = random() < 0.5 ? matchup.itemAId : matchup.itemBId;
  }

  await prisma.matchup.update({
    where: { id: matchup.id },
    data: {
      status: MatchupStatus.COMPLETED,
      winnerItemId,
    },
  });

  // Resolving this tie-breaker may be the last thing blocking the Round
  // from closing - let evaluateRound notice and act on that.
  await evaluateRound(matchup.roundId, now);
}
