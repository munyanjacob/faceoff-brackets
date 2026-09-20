import { prisma } from "@/lib/prisma";
import { determineWinner } from "@/lib/bracket-engine/determine-winner";
import { generateFirstRound } from "@/lib/bracket/generate-first-round";
import { parseStoredRoundDurationOverrides } from "@/app/dashboard/brackets/[id]/edit/round-duration";
import { MatchupStatus, RoundStatus, BracketStatus } from "@/generated/prisma/enums";

/**
 * Issue #20: the single entry point that closes out a Round's still-open
 * Matchups and, once the whole Round is decided, closes the Round itself -
 * advancing winners into a freshly created next Round, or completing the
 * Bracket when a champion has just been decided.
 *
 * This is deliberately the *only* place that implements "closing" logic.
 * Both #27 (a Round's `endsAt` has passed) and #29 (a Matchup's
 * `tieBreakerEndsAt` has passed) only need to *detect* that something
 * should be re-evaluated and then call `evaluateRound(roundId)` - neither
 * reimplements any of the decision/advancement logic below.
 *
 * What it does, per Matchup still `PENDING`/`ACTIVE` with both items
 * present:
 * - Counts that Matchup's votes per item and applies #19's `determineWinner`.
 * - A clear "A"/"B" result sets `winnerItemId` and `status = COMPLETED`.
 * - A "TIE" result sets `status = TIE_BREAKER` and `tieBreakerEndsAt` to
 *   `now + max(25% of the Round's durationMinutes, 60 minutes)` (#29's
 *   rule) - and leaves `winnerItemId` unset. A Matchup already in
 *   `TIE_BREAKER` is left alone here; resolving it is #29's job, and this
 *   function only notices the outcome (whatever status it's since moved to)
 *   the next time it's called for this Round.
 *
 * After processing, this function only ever does one of three things:
 * 1. If at least one Matchup is now `TIE_BREAKER`, it stops - the Round
 *    stays `ACTIVE` (not closed) until #29 resolves that tie-breaker and
 *    something calls this function again for the same Round.
 * 2. If every Matchup is `COMPLETED`, it closes the Round
 *    (`status = COMPLETED`) and collects bracket-order winners (byes
 *    already carry `winnerItemId` from #18's persistence; non-byes just got
 *    theirs above). With more than one winner it creates the next Round
 *    (immediately `ACTIVE`, duration from
 *    `Bracket.round_duration_overrides[String(roundNumber)]` or the
 *    bracket's default) pairing consecutive winners into new `ACTIVE`
 *    Matchups. With exactly one winner it completes the Bracket instead and
 *    creates no further Round.
 * 3. Otherwise (a Matchup is still open because it was missing an item -
 *    not expected in practice, see the loop below) it stops without
 *    changing the Round, so a data anomaly can never falsely close a Round
 *    around it.
 *
 * Calling this on an already-`COMPLETED` Round is a no-op.
 *
 * Bracket order without a schema change: `Matchup` has no explicit ordinal
 * column. Round 1's matchups are built by #17's `generateFirstRound` from
 * `BracketItem`s in ascending `createdAt` order (`publish-actions.ts`), and
 * every later round's matchups are built the same way here, pairing
 * *consecutive* winners from the previous round. That means a Matchup's
 * `itemA` is always the earlier-created (lower `createdAt`) of the two
 * original `BracketItem`s currently occupying that bracket slot, at any
 * round depth - a winning item keeps its own original `BracketItem` row
 * (and so its original `createdAt`) as it advances, it's never recreated.
 * So ordering a Round's Matchups by `itemA.createdAt` ascending reconstructs
 * bracket order exactly, with no new persisted column required. (`itemA` is
 * always present on a real Matchup - only `itemB` is ever null, for a bye -
 * so this ordering key is always available.)
 *
 * Uses the shared `src/lib/prisma.ts` singleton rather than taking a
 * `PrismaClient` parameter, the same convention `publish-actions.ts` (#18)
 * already established for code that needs a live database connection.
 *
 * @param now Injectable for tests; defaults to the real current time. Used
 * for both the tie-breaker deadline and the next Round's `startsAt`/`endsAt`.
 */
export async function evaluateRound(
  roundId: string,
  now: Date = new Date()
): Promise<void> {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: {
      bracket: true,
      matchups: { orderBy: { itemA: { createdAt: "asc" } } },
    },
  });

  if (!round) {
    throw new Error(`evaluateRound: no Round found with id ${roundId}`);
  }

  if (round.status === RoundStatus.COMPLETED) {
    return;
  }

  for (const matchup of round.matchups) {
    const isUndecided =
      matchup.status === MatchupStatus.PENDING ||
      matchup.status === MatchupStatus.ACTIVE;
    if (!isUndecided || !matchup.itemAId || !matchup.itemBId) {
      continue;
    }

    const [votesForA, votesForB] = await Promise.all([
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemAId },
      }),
      prisma.vote.count({
        where: { matchupId: matchup.id, itemId: matchup.itemBId },
      }),
    ]);

    const outcome = determineWinner(votesForA, votesForB);

    if (outcome === "TIE") {
      const tieBreakerMs = Math.max(
        round.durationMinutes * 60_000 * 0.25,
        60 * 60_000
      );
      const tieBreakerEndsAt = new Date(now.getTime() + tieBreakerMs);

      await prisma.matchup.update({
        where: { id: matchup.id },
        data: {
          status: MatchupStatus.TIE_BREAKER,
          tieBreakerEndsAt,
        },
      });
      // Kept in sync locally so the "every Matchup COMPLETED" check just
      // below doesn't need a second round-trip to see this update.
      matchup.status = MatchupStatus.TIE_BREAKER;
      matchup.tieBreakerEndsAt = tieBreakerEndsAt;
    } else {
      const winnerItemId = outcome === "A" ? matchup.itemAId : matchup.itemBId;

      await prisma.matchup.update({
        where: { id: matchup.id },
        data: {
          status: MatchupStatus.COMPLETED,
          winnerItemId,
        },
      });
      matchup.status = MatchupStatus.COMPLETED;
      matchup.winnerItemId = winnerItemId;
    }
  }

  const hasOpenTieBreaker = round.matchups.some(
    (matchup) => matchup.status === MatchupStatus.TIE_BREAKER
  );
  if (hasOpenTieBreaker) {
    return;
  }

  const allCompleted = round.matchups.every(
    (matchup) => matchup.status === MatchupStatus.COMPLETED
  );
  if (!allCompleted) {
    return;
  }

  const winnerIds = round.matchups.map((matchup) => {
    if (!matchup.winnerItemId) {
      // Shouldn't happen - every path that marks a Matchup COMPLETED above
      // (or at #18's persistence, for byes) also sets winnerItemId - but
      // fail loudly rather than silently advancing a bracket slot as
      // "undefined".
      throw new Error(
        `evaluateRound: Matchup ${matchup.id} is COMPLETED with no winnerItemId`
      );
    }
    return matchup.winnerItemId;
  });

  await prisma.$transaction(async (tx) => {
    await tx.round.update({
      where: { id: round.id },
      data: { status: RoundStatus.COMPLETED },
    });

    if (winnerIds.length === 1) {
      await tx.bracket.update({
        where: { id: round.bracketId },
        data: { status: BracketStatus.COMPLETED },
      });
      return;
    }

    const nextRoundNumber = round.roundNumber + 1;
    const overrides = parseStoredRoundDurationOverrides(
      round.bracket.roundDurationOverrides
    );
    const durationMinutes =
      overrides[nextRoundNumber] ?? round.bracket.defaultRoundDurationMinutes;
    const startsAt = now;
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

    // Reuses #17's generateFirstRound to pair up the winners. With the
    // guaranteed power-of-two winner count this produces exactly "pair
    // consecutive winners in bracket order" with zero byes - but it also
    // gives a well-defined, already-tested fallback (assigning byes to the
    // first items in order) if the winner count is ever not a power of two,
    // rather than silently dropping a leftover winner.
    const pairings = generateFirstRound(winnerIds.map((id) => ({ id })));
    const nextMatchups = pairings.map((pairing) =>
      pairing.itemB === null
        ? {
            itemAId: pairing.itemA.id,
            itemBId: null,
            winnerItemId: pairing.itemA.id,
            status: MatchupStatus.COMPLETED,
          }
        : {
            itemAId: pairing.itemA.id,
            itemBId: pairing.itemB.id,
            winnerItemId: null,
            status: MatchupStatus.ACTIVE,
          }
    );

    await tx.round.create({
      data: {
        bracketId: round.bracketId,
        roundNumber: nextRoundNumber,
        durationMinutes,
        status: RoundStatus.ACTIVE,
        startsAt,
        endsAt,
        matchups: { create: nextMatchups },
      },
    });
  });
}
