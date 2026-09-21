import { describe, expect, it } from "vitest";
import { buildChampion, type ChampionMatchup } from "./champion-view-model";

function item(id: string) {
  return { id, title: `Item ${id}`, imageUrl: null };
}

describe("buildChampion", () => {
  it("never shows a champion for a DRAFT/SCHEDULED/ACTIVE bracket, even with a decided-looking final matchup", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: item("b"),
      winnerItemId: "a",
    };
    const votes = { itemAVotes: 10, itemBVotes: 4 };

    for (const status of ["DRAFT", "SCHEDULED", "ACTIVE"]) {
      expect(buildChampion(status, finalMatchup, votes)).toEqual({ kind: "none" });
    }
  });

  it("shows the winner and both items' vote tally for a COMPLETED bracket's final matchup", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: item("b"),
      winnerItemId: "b",
    };
    const votes = { itemAVotes: 3, itemBVotes: 9 };

    const result = buildChampion("COMPLETED", finalMatchup, votes);

    expect(result).toEqual({
      kind: "champion",
      winner: item("b"),
      tally: [
        { item: item("a"), votes: 3 },
        { item: item("b"), votes: 9 },
      ],
    });
  });

  it("picks itemA as the winner when winnerItemId matches itemA", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: item("b"),
      winnerItemId: "a",
    };
    const votes = { itemAVotes: 12, itemBVotes: 1 };

    const result = buildChampion("COMPLETED", finalMatchup, votes);
    if (result.kind !== "champion") throw new Error("expected champion");

    expect(result.winner).toEqual(item("a"));
  });

  it("returns none for a COMPLETED bracket with no final matchup found (data anomaly)", () => {
    expect(buildChampion("COMPLETED", null, null)).toEqual({ kind: "none" });
  });

  it("returns none when the final matchup has no winnerItemId set yet (data anomaly - shouldn't happen for COMPLETED)", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: item("b"),
      winnerItemId: null,
    };

    expect(
      buildChampion("COMPLETED", finalMatchup, { itemAVotes: 1, itemBVotes: 2 })
    ).toEqual({ kind: "none" });
  });

  it("handles a bye-decided final matchup gracefully - shows the winner with no vote tally, not a crash or a misleading 0 votes (see this module's top comment on why this shouldn't be reachable in practice)", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: null,
      winnerItemId: "a",
    };

    const result = buildChampion("COMPLETED", finalMatchup, null);

    expect(result).toEqual({ kind: "champion", winner: item("a"), tally: null });
  });

  it("returns none when winnerItemId matches neither item on the row (data anomaly)", () => {
    const finalMatchup: ChampionMatchup = {
      id: "m-final",
      itemA: item("a"),
      itemB: item("b"),
      winnerItemId: "someone-else",
    };

    expect(
      buildChampion("COMPLETED", finalMatchup, { itemAVotes: 1, itemBVotes: 2 })
    ).toEqual({ kind: "none" });
  });
});
