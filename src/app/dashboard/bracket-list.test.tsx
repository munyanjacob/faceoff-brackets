import { describe, expect, it } from "vitest";
import { BracketList } from "./bracket-list";
import type { BracketRow } from "./bracket-view-model";

describe("BracketList", () => {
  it("renders an explicit empty-state message when there are no brackets", () => {
    const result = BracketList({ brackets: [] });

    const html = JSON.stringify(result);
    expect(html).toContain("You haven");
    expect(html).toMatch(/created any brackets yet/);
    // Not a blank page, an empty table, or a spinner.
    expect(html).not.toContain("table");
    expect(html).not.toContain("spinner");
  });

  it("shows the title, raw status, current round, and human-readable date for each bracket", () => {
    const brackets: BracketRow[] = [
      {
        id: "b1",
        title: "Best Sitcom",
        status: "DRAFT",
        currentRoundNumber: "-",
        createdAt: "September 19, 2026",
      },
      {
        id: "b2",
        title: "Best Movie",
        status: "ACTIVE",
        currentRoundNumber: 2,
        createdAt: "September 1, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).toContain("Best Sitcom");
    expect(html).toContain("DRAFT");
    expect(html).toContain("Best Movie");
    expect(html).toContain("ACTIVE");
    expect(html).toContain("September 19, 2026");
    expect(html).toContain("September 1, 2026");
    // The current round number/placeholder appears as its own cell value.
    expect(html).toMatch(/"-"/);
    expect(html).toContain("2");
  });

  it("does not render a create-bracket CTA or a per-row link (out of scope until #10)", () => {
    const brackets: BracketRow[] = [
      {
        id: "b1",
        title: "Best Sitcom",
        status: "DRAFT",
        currentRoundNumber: "-",
        createdAt: "September 19, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).not.toContain("/dashboard/brackets/new");
    expect(html.toLowerCase()).not.toContain("create a bracket");
    expect(html).not.toContain('"button"');
    expect(html).not.toContain('"a"'); // no <a> link elements
  });
});
