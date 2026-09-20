import { describe, expect, it } from "vitest";
import MatchupResultLoading from "./loading";

describe("/brackets/[id]/matchups/[matchupId]/result loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(MatchupResultLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
