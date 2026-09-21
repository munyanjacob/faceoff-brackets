export type MatchupOutcome = "A" | "B" | "TIE";

/**
 * Decides a matchup's outcome from its vote counts. Pure logic only - no
 * database or network calls (#19).
 *
 * - Strictly more votes for one side wins ("A" or "B").
 * - Equal vote counts are a "TIE", including when both sides have zero
 *   votes (there is no vote-count basis to prefer one side, so it goes
 *   down the same tie-breaker path as a "true" tie).
 *
 * Bye matchups must never be passed through this function - they're
 * already decided at creation time (#18).
 */
export function determineWinner(
  votesForA: number,
  votesForB: number,
): MatchupOutcome {
  if (votesForA > votesForB) {
    return "A";
  }

  if (votesForB > votesForA) {
    return "B";
  }

  return "TIE";
}
