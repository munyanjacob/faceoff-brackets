import { describe, expect, test } from "vitest";
import { generateFirstRound } from "./generate-first-round";

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    seed: i + 1,
  }));
}

describe("generateFirstRound", () => {
  test("4 items -> 0 byes, 2 matchups", () => {
    const result = generateFirstRound(items(4));

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.itemB !== null)).toBe(true);
    expect(result).toEqual([
      { itemA: { id: "item-1", seed: 1 }, itemB: { id: "item-2", seed: 2 } },
      { itemA: { id: "item-3", seed: 3 }, itemB: { id: "item-4", seed: 4 } },
    ]);
  });

  test("8 items -> 0 byes, 4 matchups", () => {
    const result = generateFirstRound(items(8));

    expect(result).toHaveLength(4);
    expect(result.every((m) => m.itemB !== null)).toBe(true);
  });

  test("16 items -> 0 byes, 8 matchups", () => {
    const result = generateFirstRound(items(16));

    expect(result).toHaveLength(8);
    expect(result.every((m) => m.itemB !== null)).toBe(true);
  });

  test("10 items -> 6 byes (first 6 in input order) + 2 matchups among remaining 4", () => {
    const input = items(10);
    const result = generateFirstRound(input);

    // Next power of two >= 10 is 16, so 16 - 10 = 6 byes.
    const byes = result.filter((m) => m.itemB === null);
    const matchups = result.filter((m) => m.itemB !== null);

    expect(byes).toHaveLength(6);
    expect(matchups).toHaveLength(2);

    // Byes go to the first 6 items in input order.
    expect(byes.map((m) => m.itemA)).toEqual(input.slice(0, 6));

    // Remaining 4 items are paired sequentially in input order.
    expect(matchups).toEqual([
      { itemA: input[6], itemB: input[7] },
      { itemA: input[8], itemB: input[9] },
    ]);

    // Byes plus match winners (one per matchup) produce exactly 8 entrants
    // for round 2, per _docs/outdated/plan.md SS6.
    expect(byes.length + matchups.length).toBe(8);
  });

  test("throws a clear error for 0 items", () => {
    expect(() => generateFirstRound([])).toThrow(
      /at least 2 items/i
    );
  });

  test("throws a clear error for 1 item", () => {
    expect(() => generateFirstRound(items(1))).toThrow(
      /at least 2 items/i
    );
  });

  test("every item appears in exactly one matchup or bye - no duplicates, none dropped", () => {
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17]) {
      const input = items(count);
      const result = generateFirstRound(input);

      const seen: string[] = [];
      for (const matchup of result) {
        seen.push(matchup.itemA.id);
        if (matchup.itemB !== null) {
          seen.push(matchup.itemB.id);
        }
      }

      expect(seen.sort()).toEqual(input.map((item) => item.id).sort());
      expect(new Set(seen).size).toBe(input.length);
    }
  });
});
