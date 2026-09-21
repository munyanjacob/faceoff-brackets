import { describe, expect, test } from "vitest";
import { buildRoundOnePlan } from "./build-round-one";

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}` }));
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("buildRoundOnePlan", () => {
  test("immediate start: Round is ACTIVE, starts now, ends after durationMinutes, non-bye Matchups are ACTIVE", () => {
    const plan = buildRoundOnePlan(items(4), {
      durationMinutes: 30,
      immediateStart: true,
      now: NOW,
    });

    expect(plan.roundNumber).toBe(1);
    expect(plan.durationMinutes).toBe(30);
    expect(plan.status).toBe("ACTIVE");
    expect(plan.startsAt).toEqual(NOW);
    expect(plan.endsAt).toEqual(new Date("2026-01-01T00:30:00.000Z"));

    expect(plan.matchups).toEqual([
      {
        itemAId: "item-1",
        itemBId: "item-2",
        winnerItemId: null,
        status: "ACTIVE",
      },
      {
        itemAId: "item-3",
        itemBId: "item-4",
        winnerItemId: null,
        status: "ACTIVE",
      },
    ]);
  });

  test("scheduled start: Round is PENDING, starts/ends null, non-bye Matchups are PENDING", () => {
    const plan = buildRoundOnePlan(items(4), {
      durationMinutes: 30,
      immediateStart: false,
      now: NOW,
    });

    expect(plan.status).toBe("PENDING");
    expect(plan.startsAt).toBeNull();
    expect(plan.endsAt).toBeNull();

    expect(plan.matchups).toEqual([
      {
        itemAId: "item-1",
        itemBId: "item-2",
        winnerItemId: null,
        status: "PENDING",
      },
      {
        itemAId: "item-3",
        itemBId: "item-4",
        winnerItemId: null,
        status: "PENDING",
      },
    ]);
  });

  test("a bye matchup is COMPLETED with itemBId null and winnerItemId set to itemAId, when immediate", () => {
    // 3 items -> next power of two is 4, so 1 bye + 1 real matchup.
    const plan = buildRoundOnePlan(items(3), {
      durationMinutes: 30,
      immediateStart: true,
      now: NOW,
    });

    expect(plan.matchups).toEqual([
      {
        itemAId: "item-1",
        itemBId: null,
        winnerItemId: "item-1",
        status: "COMPLETED",
      },
      {
        itemAId: "item-2",
        itemBId: "item-3",
        winnerItemId: null,
        status: "ACTIVE",
      },
    ]);
  });

  test("a bye matchup is COMPLETED regardless of immediate vs. scheduled start", () => {
    const scheduledPlan = buildRoundOnePlan(items(3), {
      durationMinutes: 30,
      immediateStart: false,
      now: NOW,
    });

    expect(scheduledPlan.matchups[0]).toEqual({
      itemAId: "item-1",
      itemBId: null,
      winnerItemId: "item-1",
      status: "COMPLETED",
    });
    // The non-bye matchup still follows the scheduled/PENDING rule.
    expect(scheduledPlan.matchups[1].status).toBe("PENDING");
  });

  test("uses the durationMinutes it's given, whatever the caller resolved (override vs. default)", () => {
    const withOverride = buildRoundOnePlan(items(2), {
      durationMinutes: 15,
      immediateStart: true,
      now: NOW,
    });
    expect(withOverride.durationMinutes).toBe(15);
    expect(withOverride.endsAt).toEqual(new Date("2026-01-01T00:15:00.000Z"));

    const withDefault = buildRoundOnePlan(items(2), {
      durationMinutes: 60,
      immediateStart: true,
      now: NOW,
    });
    expect(withDefault.durationMinutes).toBe(60);
    expect(withDefault.endsAt).toEqual(new Date("2026-01-01T01:00:00.000Z"));
  });

  test("defaults `now` to the current time when not given", () => {
    const before = Date.now();
    const plan = buildRoundOnePlan(items(2), {
      durationMinutes: 10,
      immediateStart: true,
    });
    const after = Date.now();

    expect(plan.startsAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(plan.startsAt!.getTime()).toBeLessThanOrEqual(after);
  });

  test("throws (via generateFirstRound) for fewer than 2 items", () => {
    expect(() =>
      buildRoundOnePlan(items(1), { durationMinutes: 30, immediateStart: true })
    ).toThrow(/at least 2 items/i);
    expect(() =>
      buildRoundOnePlan(items(0), { durationMinutes: 30, immediateStart: true })
    ).toThrow(/at least 2 items/i);
  });

  test("every item appears in exactly one matchup, no duplicates or drops", () => {
    for (const count of [2, 3, 5, 8, 10]) {
      const plan = buildRoundOnePlan(items(count), {
        durationMinutes: 30,
        immediateStart: true,
        now: NOW,
      });

      const seen: string[] = [];
      for (const matchup of plan.matchups) {
        seen.push(matchup.itemAId);
        if (matchup.itemBId !== null) {
          seen.push(matchup.itemBId);
        }
      }

      expect(seen.sort()).toEqual(
        items(count)
          .map((item) => item.id)
          .sort()
      );
      expect(new Set(seen).size).toBe(count);
    }
  });
});
