import { describe, expect, it } from "vitest";
import { buildMatchupResultState, type ResultMatchup } from "./matchup-result-view-model";

function item(id: string) {
  return {
    id,
    title: `Item ${id}`,
    description: null as string | null,
    imageUrl: null as string | null,
  };
}

function matchup(overrides: Partial<ResultMatchup> = {}): ResultMatchup {
  return {
    id: "m1",
    itemA: item("a"),
    itemB: item("b"),
    winnerItemId: "a",
    tieBreakerEndsAt: null,
    ...overrides,
  };
}

describe("buildMatchupResultState", () => {
  it("shows a bye as a bye, with no vote counts implied", () => {
    const state = buildMatchupResultState(
      matchup({ itemB: null, winnerItemId: "a" }),
      {},
      []
    );

    expect(state).toEqual({ kind: "bye", matchupId: "m1", advancing: item("a") });
  });

  it("marks the winner and loser distinctly for a clean majority decision, with each side's vote count", () => {
    const state = buildMatchupResultState(
      matchup({ winnerItemId: "b" }),
      { a: 3, b: 7 },
      []
    );

    expect(state).toEqual({
      kind: "decided",
      matchupId: "m1",
      winner: item("b"),
      winnerVoteCount: 7,
      loser: item("a"),
      loserVoteCount: 3,
      decidedByTieBreaker: false,
      comments: [],
    });
  });

  it("labels a matchup resolved via tie-breaker, distinct from a clean majority win", () => {
    const state = buildMatchupResultState(
      matchup({ winnerItemId: "a", tieBreakerEndsAt: new Date("2026-01-01T00:00:00.000Z") }),
      { a: 5, b: 5 },
      []
    );

    expect(state).toEqual({
      kind: "decided",
      matchupId: "m1",
      winner: item("a"),
      winnerVoteCount: 5,
      loser: item("b"),
      loserVoteCount: 5,
      decidedByTieBreaker: true,
      comments: [],
    });
  });

  it("defaults a missing vote count to zero rather than undefined", () => {
    const state = buildMatchupResultState(matchup({ winnerItemId: "a" }), {}, []);

    expect(state.kind).toBe("decided");
    if (state.kind !== "decided") throw new Error("expected decided");
    expect(state.winnerVoteCount).toBe(0);
    expect(state.loserVoteCount).toBe(0);
  });

  it("passes comments through unchanged, in whatever order they're given", () => {
    const comments = [
      { id: "v1", itemId: "a", comment: "Great pick!", createdAt: new Date("2026-01-01") },
      { id: "v2", itemId: "b", comment: "Disagree.", createdAt: new Date("2026-01-02") },
    ];

    const state = buildMatchupResultState(matchup({ winnerItemId: "a" }), { a: 1, b: 1 }, comments);

    expect(state.kind).toBe("decided");
    if (state.kind !== "decided") throw new Error("expected decided");
    expect(state.comments).toEqual(comments);
  });

  it("falls back to unresolved when itemA is defensively missing (shouldn't happen on a real row)", () => {
    const state = buildMatchupResultState(matchup({ itemA: null }), {}, []);

    expect(state).toEqual({ kind: "unresolved" });
  });

  it("falls back to unresolved for a two-item matchup with no winnerItemId (shouldn't happen on a real COMPLETED row)", () => {
    const state = buildMatchupResultState(matchup({ winnerItemId: null }), {}, []);

    expect(state).toEqual({ kind: "unresolved" });
  });
});
