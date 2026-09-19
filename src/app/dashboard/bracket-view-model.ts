/**
 * Pure, framework-agnostic view-model helpers for the dashboard's bracket
 * list (issue #8). Kept separate from `page.tsx` and free of any Prisma
 * import so the "current round number" rule and the human-readable date
 * formatting can be unit-tested without a database connection - and so they
 * are ready to wire straight into the live query once
 * `src/lib/prisma.ts` exists (see the blocker noted in `page.tsx` and in
 * the issue #8 comment).
 */

export type BracketRow = {
  id: string;
  title: string;
  status: string;
  currentRoundNumber: number | "-";
  createdAt: string;
};

// The minimal shape this needs from a Prisma `Bracket` (with its `rounds`
// relation loaded). Kept structural, rather than importing the generated
// Prisma model type, so this file has no dependency on
// `src/generated/prisma` and stays usable no matter how the live query ends
// up being wired.
export type BracketWithRounds = {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  rounds: { roundNumber: number }[];
};

/**
 * Per grooming: "current round number" for a bracket is the highest
 * `roundNumber` among its `Round` rows, or the placeholder "-" if it has
 * none yet (true for every DRAFT/SCHEDULED bracket, which have no `Round`
 * rows).
 */
export function currentRoundNumber(
  rounds: { roundNumber: number }[]
): number | "-" {
  if (rounds.length === 0) {
    return "-";
  }
  return Math.max(...rounds.map((round) => round.roundNumber));
}

/**
 * Formats a creation date for a human to read, not a raw ISO timestamp.
 */
export function formatCreatedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Maps a Prisma `Bracket` (with `rounds` loaded) to the flat view-model
 * `BracketList` renders. Status is passed through as the raw
 * `BracketStatus` enum value per grooming - no copy/label mapping here.
 */
export function toBracketRow(bracket: BracketWithRounds): BracketRow {
  return {
    id: bracket.id,
    title: bracket.title,
    status: bracket.status,
    currentRoundNumber: currentRoundNumber(bracket.rounds),
    createdAt: formatCreatedAt(bracket.createdAt),
  };
}
