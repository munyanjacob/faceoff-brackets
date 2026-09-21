import { describe, expect, it } from "vitest";
import BracketTreeLoading from "./loading";

describe("/brackets/[id]/tree loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(BracketTreeLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
