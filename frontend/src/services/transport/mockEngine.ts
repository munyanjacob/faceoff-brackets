/**
 * Business-rule engine: round creation, vote tallying, tie-breaker
 * resolution, and the round-advancement sweep. This reimplements the
 * backend's tournament logic in the browser — see the header comment in
 * mockTransport.ts for why that duplication is an accepted trade-off here.
 */

import { generateFirstRound } from "@/lib/bracket-logic";
import type { Bracket, BracketItem } from "../types";
import { plusMinutes, uid, type Db, type MatchupRow, type RoundRow } from "./mockDb";

/** Tie-breaker voting window: 25% of the round's length, floored at 1 hour. */
export const TIE_BREAKER_WINDOW_FRACTION = 0.25;
export const TIE_BREAKER_MIN_WINDOW_MS = 60 * 60_000;

export function durationForRound(bracket: Bracket, roundNumber: number): number {
  const override = bracket.roundDurationOverrides[String(roundNumber)];
  return override && override > 0 ? override : bracket.defaultRoundDurationMinutes;
}

export function createRound(
  db: Db,
  bracket: Bracket,
  roundNumber: number,
  orderedItems: BracketItem[],
  opts: { pending: boolean; startsAt: Date | null },
): RoundRow {
  const minutes = durationForRound(bracket, roundNumber);
  const start = opts.startsAt;
  const round: RoundRow = {
    id: uid(),
    bracketId: bracket.id,
    roundNumber,
    durationMinutes: minutes,
    startsAt: start ? start.toISOString() : null,
    endsAt: start ? plusMinutes(start, minutes) : null,
    status: opts.pending ? "PENDING" : "ACTIVE",
  };
  db.rounds.push(round);

  generateFirstRound(orderedItems).forEach((pair, index) => {
    const isBye = pair.b === null;
    db.matchups.push({
      id: uid(),
      roundId: round.id,
      position: index,
      itemAId: pair.a.id,
      itemBId: pair.b ? pair.b.id : null,
      winnerItemId: isBye ? pair.a.id : null,
      status: isBye ? "COMPLETED" : opts.pending ? "PENDING" : "ACTIVE",
      tieBreakerEndsAt: null,
    });
  });
  return round;
}

export function tallies(db: Db, matchupId: string, phase?: "ORIGINAL" | "TIE_BREAKER") {
  const counts: Record<string, number> = {};
  for (const vote of db.votes) {
    if (vote.matchupId !== matchupId) continue;
    if (phase && vote.phase !== phase) continue;
    counts[vote.itemId] = (counts[vote.itemId] ?? 0) + 1;
  }
  return counts;
}

export function closeRoundIfDone(db: Db, round: RoundRow) {
  const matchups = db.matchups.filter((m) => m.roundId === round.id);
  if (matchups.some((m) => m.status !== "COMPLETED")) return;

  round.status = "COMPLETED";
  const bracket = db.brackets.find((b) => b.id === round.bracketId);
  if (!bracket) return;

  const winners = matchups
    .sort((a, b) => a.position - b.position)
    .map((m) => db.items.find((i) => i.id === m.winnerItemId))
    .filter((i): i is BracketItem => Boolean(i));

  if (winners.length <= 1) {
    bracket.status = "COMPLETED";
    return;
  }
  createRound(db, bracket, round.roundNumber + 1, winners, {
    pending: false,
    startsAt: new Date(),
  });
}

export function resolveTieBreaker(db: Db, matchup: MatchupRow) {
  const counts = tallies(db, matchup.id, "TIE_BREAKER");
  const a = matchup.itemAId!;
  const b = matchup.itemBId!;
  const aCount = counts[a] ?? 0;
  const bCount = counts[b] ?? 0;
  matchup.winnerItemId =
    aCount === bCount ? (Math.random() < 0.5 ? a : b) : aCount > bCount ? a : b;
  matchup.status = "COMPLETED";
}

/** The round-advancement job (§4.5): three independent, idempotent sweeps. */
export function sweep(db: Db) {
  const now = Date.now();

  // 1. Expired active rounds.
  for (const round of db.rounds) {
    if (round.status !== "ACTIVE" || !round.endsAt || Date.parse(round.endsAt) > now) continue;
    for (const matchup of db.matchups.filter((m) => m.roundId === round.id)) {
      if (matchup.status !== "ACTIVE") continue;
      const counts = tallies(db, matchup.id);
      const a = matchup.itemAId!;
      const b = matchup.itemBId!;
      const aCount = counts[a] ?? 0;
      const bCount = counts[b] ?? 0;
      if (aCount === bCount) {
        matchup.status = "TIE_BREAKER";
        matchup.tieBreakerEndsAt = new Date(
          now +
            Math.max(
              round.durationMinutes * 60_000 * TIE_BREAKER_WINDOW_FRACTION,
              TIE_BREAKER_MIN_WINDOW_MS,
            ),
        ).toISOString();
      } else {
        matchup.status = "COMPLETED";
        matchup.winnerItemId = aCount > bCount ? a : b;
      }
    }
    closeRoundIfDone(db, round);
  }

  // 2. Expired tie-breakers.
  for (const matchup of db.matchups) {
    if (matchup.status !== "TIE_BREAKER") continue;
    if (!matchup.tieBreakerEndsAt || Date.parse(matchup.tieBreakerEndsAt) > now) continue;
    resolveTieBreaker(db, matchup);
    const round = db.rounds.find((r) => r.id === matchup.roundId);
    if (round && round.status === "ACTIVE") closeRoundIfDone(db, round);
  }

  // 3. Due scheduled brackets.
  for (const bracket of db.brackets) {
    if (bracket.status !== "SCHEDULED") continue;
    if (!bracket.scheduledStartAt || Date.parse(bracket.scheduledStartAt) > now) continue;
    bracket.status = "ACTIVE";
    const first = db.rounds.find((r) => r.bracketId === bracket.id && r.roundNumber === 1);
    if (first) {
      first.status = "ACTIVE";
      first.startsAt = new Date(now).toISOString();
      first.endsAt = plusMinutes(new Date(now), first.durationMinutes);
      for (const matchup of db.matchups.filter((m) => m.roundId === first.id)) {
        if (matchup.status === "PENDING") matchup.status = "ACTIVE";
      }
    }
  }
}
