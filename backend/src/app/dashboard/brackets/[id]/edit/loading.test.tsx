import { describe, expect, it } from "vitest";
import EditBracketLoading from "./loading";

describe("/dashboard/brackets/[id]/edit loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(EditBracketLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
