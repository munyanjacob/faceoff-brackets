/**
 * Pure bracket-generation logic for seeding a single-elimination first round.
 *
 * No database or network calls happen here — see issue #17. Persisting the
 * result is out of scope (#18), as is generating rounds after the first (#20).
 */

/**
 * A single first-round pairing.
 *
 * `itemB` is `null` when `itemA` received a bye: it advances automatically
 * without a vote (see `_docs/outdated/plan.md` SS6).
 */
export interface Matchup<T> {
  itemA: T;
  itemB: T | null;
}

/**
 * Seeds a single-elimination first round from an ordered list of items.
 *
 * Seeding rules (see issue #17 and `_docs/outdated/plan.md` SS6):
 * - Byes go to the first N items in input order (`BracketItem.seed`
 *   ascending — the order the creator entered them). There is no
 *   skill-based or random seeding in the MVP.
 * - Byes needed = (next power of two >= item count) minus item count.
 * - The remaining (non-bye) items are paired sequentially in input order:
 *   first-remaining vs second-remaining, third-remaining vs
 *   fourth-remaining, and so on.
 *
 * @throws {Error} if fewer than 2 items are provided — a bracket needs at
 * least 2 items to mean anything.
 */
export function generateFirstRound<T>(items: readonly T[]): Matchup<T>[] {
  if (items.length < 2) {
    throw new Error(
      `generateFirstRound requires at least 2 items, received ${items.length}`
    );
  }

  const bracketSize = nextPowerOfTwo(items.length);
  const byeCount = bracketSize - items.length;

  const byeItems = items.slice(0, byeCount);
  const remainingItems = items.slice(byeCount);

  const byes: Matchup<T>[] = byeItems.map((item) => ({
    itemA: item,
    itemB: null,
  }));

  const matchups: Matchup<T>[] = [];
  for (let i = 0; i < remainingItems.length; i += 2) {
    matchups.push({ itemA: remainingItems[i], itemB: remainingItems[i + 1] });
  }

  return [...byes, ...matchups];
}

/** Smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
  let power = 1;
  while (power < n) {
    power *= 2;
  }
  return power;
}
