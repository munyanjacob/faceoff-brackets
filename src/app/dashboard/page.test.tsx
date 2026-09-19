import { describe, expect, it } from "vitest";
import DashboardPage from "./page";

describe("/dashboard page", () => {
  it("renders a placeholder heading", () => {
    const result = DashboardPage();

    expect(JSON.stringify(result)).toContain("Dashboard");
  });
});
