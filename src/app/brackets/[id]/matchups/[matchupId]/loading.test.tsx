import { describe, expect, it } from "vitest";
import MatchupVotingLoading from "./loading";

describe("/brackets/[id]/matchups/[matchupId] loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(MatchupVotingLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
