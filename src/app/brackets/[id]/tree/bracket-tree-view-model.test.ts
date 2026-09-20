import { describe, expect, it } from "vitest";
import { buildBracketTree, NOT_PUBLISHED_MESSAGE, type TreeRound } from "./bracket-tree-view-model";

function item(id: string) {
  return { id, title: `Item ${id}`, imageUrl: null };
}

describe("buildBracketTree", () => {
  it("returns a not-published state for a bracket with no rounds yet (issue #30's DRAFT case)", () => {
    const result = buildBracketTree([]);

    expect(result).toEqual({ kind: "not-published", message: NOT_PUBLISHED_MESSAGE });
  });

  it("renders a clean power-of-two bracket's in-progress round 1 as active, with a placeholder Final column", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          {
            id: "m1",
            status: "ACTIVE",
            itemA: item("a"),
            itemB: item("b"),
            winnerItemId: null,
          },
          {
            id: "m2",
            status: "ACTIVE",
            itemA: item("c"),
            itemB: item("d"),
            winnerItemId: null,
          },
        ],
      },
    ];

    const result = buildBracketTree(rounds);

    expect(result.kind).toBe("tree");
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds).toHaveLength(2);
    // A 4-item bracket's round 1 *is* the semifinal round (its two matchups'
    // winners meet in round 2, the final) - `roundNameHint` (#13) already
    // encodes that relative-to-total-rounds naming; this test just confirms
    // this module defers to it rather than a fixed "Round N" label.
    expect(result.rounds[0].label).toBe("Semifinal");
    expect(result.rounds[0].matchups).toEqual([
      { kind: "active", id: "m1", itemA: item("a"), itemB: item("b"), isTieBreaker: false },
      { kind: "active", id: "m2", itemA: item("c"), itemB: item("d"), isTieBreaker: false },
    ]);

    expect(result.rounds[1].label).toBe("Final");
    expect(result.rounds[1].matchups).toEqual([
      { kind: "upcoming", id: "upcoming-2-0" },
    ]);
  });

  it("renders a round-1 bye as an automatic advance, not a played matchup", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          {
            id: "bye-1",
            status: "COMPLETED",
            itemA: item("a"),
            itemB: null,
            winnerItemId: "a",
          },
          {
            id: "m1",
            status: "ACTIVE",
            itemA: item("b"),
            itemB: item("c"),
            winnerItemId: null,
          },
        ],
      },
    ];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds[0].matchups[0]).toEqual({
      kind: "bye",
      id: "bye-1",
      advancing: item("a"),
    });
    // Round count is still based on the real item count (3), so 2 rounds
    // total (ceil(log2(3)) === 2), matching the 2 winners this round
    // produces (the bye's advancer plus m1's eventual winner).
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[1].matchups).toHaveLength(1);
  });

  it("shows a completed matchup's winner distinctly from its loser", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          {
            id: "m1",
            status: "COMPLETED",
            itemA: item("a"),
            itemB: item("b"),
            winnerItemId: "b",
          },
        ],
      },
    ];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds[0].matchups[0]).toEqual({
      kind: "completed",
      id: "m1",
      winner: item("b"),
      loser: item("a"),
    });
  });

  it("marks a TIE_BREAKER matchup as active, distinct from a plain ACTIVE one", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          {
            id: "m1",
            status: "TIE_BREAKER",
            itemA: item("a"),
            itemB: item("b"),
            winnerItemId: null,
          },
        ],
      },
    ];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds[0].matchups[0]).toEqual({
      kind: "active",
      id: "m1",
      itemA: item("a"),
      itemB: item("b"),
      isTieBreaker: true,
    });
  });

  it("renders a PENDING matchup (a SCHEDULED bracket before its start time) as not-yet-started, distinct from active", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          {
            id: "m1",
            status: "PENDING",
            itemA: item("a"),
            itemB: item("b"),
            winnerItemId: null,
          },
        ],
      },
    ];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds[0].matchups[0]).toEqual({
      kind: "pending",
      id: "m1",
      itemA: item("a"),
      itemB: item("b"),
    });
  });

  it("lays out a 16-item, 4-round bracket with only round 1 persisted so far, synthesizing 3 upcoming columns of the right sizes and labels", () => {
    const matchups = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      status: "ACTIVE",
      itemA: item(`a${i}`),
      itemB: item(`b${i}`),
      winnerItemId: null,
    }));
    const rounds: TreeRound[] = [{ roundNumber: 1, matchups }];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds).toHaveLength(4);
    expect(result.rounds.map((r) => r.matchups.length)).toEqual([8, 4, 2, 1]);
    expect(result.rounds.map((r) => r.label)).toEqual([
      "Round 1",
      "Round 2",
      "Semifinal",
      "Final",
    ]);
    // Every not-yet-created round's cells are "upcoming", not fabricated
    // matchup data.
    expect(result.rounds[1].matchups.every((m) => m.kind === "upcoming")).toBe(true);
    expect(result.rounds[2].matchups.every((m) => m.kind === "upcoming")).toBe(true);
    expect(result.rounds[3].matchups.every((m) => m.kind === "upcoming")).toBe(true);
  });

  it("renders a fully completed bracket with no leftover placeholder columns", () => {
    const rounds: TreeRound[] = [
      {
        roundNumber: 1,
        matchups: [
          { id: "m1", status: "COMPLETED", itemA: item("a"), itemB: item("b"), winnerItemId: "a" },
          { id: "m2", status: "COMPLETED", itemA: item("c"), itemB: item("d"), winnerItemId: "d" },
        ],
      },
      {
        roundNumber: 2,
        matchups: [
          { id: "m3", status: "COMPLETED", itemA: item("a"), itemB: item("d"), winnerItemId: "a" },
        ],
      },
    ];

    const result = buildBracketTree(rounds);
    if (result.kind !== "tree") throw new Error("expected tree");

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[1].label).toBe("Final");
    expect(result.rounds[1].matchups).toEqual([
      { kind: "completed", id: "m3", winner: item("a"), loser: item("d") },
    ]);
  });
});
