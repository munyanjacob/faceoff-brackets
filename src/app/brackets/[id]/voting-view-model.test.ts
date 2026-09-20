import { describe, expect, it } from "vitest";
import {
  BETWEEN_ROUNDS_MESSAGE,
  COMPLETED_MESSAGE,
  NOT_STARTED_MESSAGE,
  determineVotingState,
  type VotingMatchup,
  type VotingRound,
} from "./voting-view-model";

const ITEM_A = {
  id: "item-a",
  title: "Item A",
  description: "Description A",
  imageUrl: "https://example.com/a.png",
};

const ITEM_B = {
  id: "item-b",
  title: "Item B",
  description: null,
  imageUrl: null,
};

function activeMatchup(overrides: Partial<VotingMatchup> = {}): VotingMatchup {
  return {
    id: "matchup-1",
    status: "ACTIVE",
    itemA: ITEM_A,
    itemB: ITEM_B,
    ...overrides,
  };
}

describe("determineVotingState", () => {
  it("shows a not-started message for a DRAFT bracket", () => {
    const state = determineVotingState({ status: "DRAFT" }, []);
    expect(state).toEqual({ kind: "no-active-matchup", message: NOT_STARTED_MESSAGE });
  });

  it("shows a not-started message for a SCHEDULED bracket", () => {
    const state = determineVotingState({ status: "SCHEDULED" }, []);
    expect(state).toEqual({ kind: "no-active-matchup", message: NOT_STARTED_MESSAGE });
  });

  it("shows a completed message for a COMPLETED bracket, even if a stale ACTIVE round were passed in", () => {
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [activeMatchup()] }];
    const state = determineVotingState({ status: "COMPLETED" }, rounds);
    expect(state).toEqual({ kind: "no-active-matchup", message: COMPLETED_MESSAGE });
  });

  it("shows a between-rounds message for an ACTIVE bracket with no ACTIVE round", () => {
    const rounds: VotingRound[] = [{ status: "COMPLETED", matchups: [] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE });
  });

  it("shows a between-rounds message for an ACTIVE bracket whose ACTIVE round has no votable matchup", () => {
    const rounds: VotingRound[] = [
      {
        status: "ACTIVE",
        matchups: [
          activeMatchup({ status: "COMPLETED" }),
          activeMatchup({ id: "matchup-bye", status: "COMPLETED", itemB: null }),
        ],
      },
    ];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE });
  });

  it("returns the ACTIVE matchup for an ACTIVE bracket with an ACTIVE round", () => {
    const matchup = activeMatchup();
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [matchup] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "matchup", matchup, isTieBreaker: false });
  });

  it("returns a TIE_BREAKER matchup as votable, flagged with isTieBreaker", () => {
    const matchup = activeMatchup({ status: "TIE_BREAKER" });
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [matchup] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "matchup", matchup, isTieBreaker: true });
  });

  it("picks the first votable matchup, deterministically, when a round has more than one", () => {
    const first = activeMatchup({ id: "matchup-first" });
    const second = activeMatchup({ id: "matchup-second" });
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [first, second] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "matchup", matchup: first, isTieBreaker: false });
  });

  it("skips a PENDING matchup and picks the first ACTIVE/TIE_BREAKER one instead", () => {
    const pending = activeMatchup({ id: "matchup-pending", status: "PENDING" });
    const votable = activeMatchup({ id: "matchup-votable" });
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [pending, votable] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "matchup", matchup: votable, isTieBreaker: false });
  });

  it("treats an ACTIVE-status matchup missing an item defensively as not votable", () => {
    const incomplete = activeMatchup({ itemB: null });
    const rounds: VotingRound[] = [{ status: "ACTIVE", matchups: [incomplete] }];
    const state = determineVotingState({ status: "ACTIVE" }, rounds);
    expect(state).toEqual({ kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE });
  });
});
