/**
 * Pure bracket-generation logic, ported verbatim from the backend
 * (specification §4.6). Deliberately duplicated so the "preview structure"
 * UI can render without a round-trip. If the rule changes, change both copies.
 */

export interface Pairing<T> {
  a: T;
  b: T | null;
}

export function bracketSizeFor(itemCount: number): number {
  let size = 1;
  while (size < itemCount) size *= 2;
  return size;
}

export function totalRoundsFor(itemCount: number): number {
  if (itemCount < 2) return 0;
  return Math.ceil(Math.log2(itemCount));
}

/** Items must already be in bracket order (creation order). */
export function generateFirstRound<T>(items: T[]): Pairing<T>[] {
  if (items.length < 2) {
    throw new Error("A bracket needs at least 2 items.");
  }
  const size = bracketSizeFor(items.length);
  const byeCount = size - items.length;

  const pairings: Pairing<T>[] = [];
  for (let i = 0; i < byeCount; i++) {
    pairings.push({ a: items[i]!, b: null });
  }
  for (let i = byeCount; i < items.length; i += 2) {
    pairings.push({ a: items[i]!, b: items[i + 1] ?? null });
  }
  return pairings;
}

export function roundLabel(roundNumber: number, totalRounds: number): string {
  if (roundNumber === totalRounds) return "Final";
  if (totalRounds >= 2 && roundNumber === totalRounds - 1) return "Semifinal";
  return `Round ${roundNumber}`;
}
