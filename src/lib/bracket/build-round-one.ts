import { generateFirstRound } from "./generate-first-round";
import { MatchupStatus, RoundStatus } from "@/generated/prisma/enums";

/**
 * Pure logic for turning a bracket's items into the exact `Round`/`Matchup`
 * row shape publish (#18) should persist for round 1.
 *
 * No database or network calls happen here - same reasoning as
 * `./generate-first-round.ts` (#17), which this wraps rather than
 * reimplements, so publish can never disagree with the preview
 * (`bracket-structure-preview.tsx`, #15) about pairings: both call
 * `generateFirstRound` with the same item list in the same order.
 */

export interface RoundOneItem {
  id: string;
}

export interface RoundOneMatchupPlan {
  itemAId: string;
  itemBId: string | null;
  winnerItemId: string | null;
  status: MatchupStatus;
}

export interface RoundOnePlan {
  roundNumber: 1;
  durationMinutes: number;
  status: RoundStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  matchups: RoundOneMatchupPlan[];
}

export interface BuildRoundOnePlanOptions {
  /**
   * Round 1's `duration_minutes` - the caller resolves this from
   * `Bracket.round_duration_overrides["1"]` (#13) falling back to
   * `Bracket.default_round_duration_minutes` before calling in.
   */
  durationMinutes: number;
  /**
   * `true` when the bracket is publishing with an immediate start
   * (`Bracket.status` becomes `ACTIVE`); `false` for a scheduled start
   * (`Bracket.status` becomes `SCHEDULED`).
   */
  immediateStart: boolean;
  /** Injectable for tests; defaults to the real current time. */
  now?: Date;
}

/**
 * Builds the `Round` + `Matchup` row data for round 1 of a freshly-published
 * bracket, per issue #18's acceptance criteria:
 *
 * - Immediate start: `Round.status = ACTIVE`, `startsAt = now`,
 *   `endsAt = startsAt + durationMinutes`, every non-bye `Matchup` is
 *   `ACTIVE`.
 * - Scheduled start: `Round.status = PENDING`, `startsAt`/`endsAt` stay
 *   `null`, every non-bye `Matchup` is `PENDING` (#28 fills in the rest when
 *   the scheduled time arrives).
 * - A bye (`itemB === null` from `generateFirstRound`) always produces
 *   `itemBId: null`, `winnerItemId` already set to the advancing item, and
 *   `status: COMPLETED`, regardless of immediate vs. scheduled.
 *
 * @throws {Error} via `generateFirstRound` if fewer than 2 items are given -
 * publish (#16) already guards this before ever calling in, but this stays a
 * safety net rather than silently producing an empty round.
 */
export function buildRoundOnePlan<T extends RoundOneItem>(
  items: readonly T[],
  { durationMinutes, immediateStart, now = new Date() }: BuildRoundOnePlanOptions
): RoundOnePlan {
  const pairings = generateFirstRound(items);

  const matchups: RoundOneMatchupPlan[] = pairings.map((pairing) => {
    if (pairing.itemB === null) {
      return {
        itemAId: pairing.itemA.id,
        itemBId: null,
        winnerItemId: pairing.itemA.id,
        status: MatchupStatus.COMPLETED,
      };
    }

    return {
      itemAId: pairing.itemA.id,
      itemBId: pairing.itemB.id,
      winnerItemId: null,
      status: immediateStart ? MatchupStatus.ACTIVE : MatchupStatus.PENDING,
    };
  });

  const startsAt = immediateStart ? now : null;
  const endsAt = immediateStart
    ? new Date(now.getTime() + durationMinutes * 60_000)
    : null;

  return {
    roundNumber: 1,
    durationMinutes,
    status: immediateStart ? RoundStatus.ACTIVE : RoundStatus.PENDING,
    startsAt,
    endsAt,
    matchups,
  };
}
