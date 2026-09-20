import { describe, expect, it } from "vitest";
import DashboardLoading from "./loading";

describe("/dashboard loading state (issue #36)", () => {
  it("shows a loading indicator, not a blank page", () => {
    const html = JSON.stringify(DashboardLoading());
    expect(html.toLowerCase()).toContain("loading");
  });
});
