import { describe, expect, it } from "vitest";
import DiscoverLoading from "./loading";

describe("/discover loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(DiscoverLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
