import { describe, expect, it } from "vitest";
import BracketVotingLoading from "./loading";

describe("/brackets/[id] loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(BracketVotingLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
