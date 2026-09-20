import { describe, expect, it } from "vitest";
import { BracketList } from "./bracket-list";
import type { BracketRow } from "./bracket-view-model";

describe("BracketList", () => {
  it("shows an explicit 'none yet' message for every section when there are no brackets at all", () => {
    const html = JSON.stringify(BracketList({ brackets: [] }));

    expect(html).toContain("Drafts");
    expect(html).toContain("No drafts yet.");
    expect(html).toContain("Scheduled");
    expect(html).toContain("No scheduled yet.");
    expect(html).toContain("Active");
    expect(html).toContain("No active yet.");
    expect(html).toContain("Completed");
    expect(html).toContain("No completed yet.");
    // Not a blank page or a spinner.
    expect(html).not.toContain("spinner");
  });

  it("shows an entry only in its own status's section, not the others", () => {
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

    expect(html).toContain("Best Sitcom");
    // The other three sections stay empty.
    expect(html).toContain("No scheduled yet.");
    expect(html).toContain("No active yet.");
    expect(html).toContain("No completed yet.");
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

  it("links a draft's title to its edit flow", () => {
    const brackets: BracketRow[] = [
      {
        id: "draft-1",
        title: "Best Sitcom",
        status: "DRAFT",
        currentRoundNumber: "-",
        createdAt: "September 19, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).toContain("/dashboard/brackets/draft-1/edit");
  });

  it("links a scheduled bracket's title to its edit flow", () => {
    const brackets: BracketRow[] = [
      {
        id: "scheduled-1",
        title: "Best Album",
        status: "SCHEDULED",
        currentRoundNumber: "-",
        createdAt: "September 19, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).toContain("/dashboard/brackets/scheduled-1/edit");
  });

  it("links an active bracket's title to the public bracket view", () => {
    const brackets: BracketRow[] = [
      {
        id: "active-1",
        title: "Best Movie",
        status: "ACTIVE",
        currentRoundNumber: 2,
        createdAt: "September 1, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).toContain("/brackets/active-1");
    expect(html).not.toContain("/dashboard/brackets/active-1/edit");
  });

  it("links a completed bracket's title to the public bracket view", () => {
    const brackets: BracketRow[] = [
      {
        id: "completed-1",
        title: "Best Show",
        status: "COMPLETED",
        currentRoundNumber: 4,
        createdAt: "September 1, 2026",
      },
    ];

    const html = JSON.stringify(BracketList({ brackets }));

    expect(html).toContain("/brackets/completed-1");
    expect(html).not.toContain("/dashboard/brackets/completed-1/edit");
  });

  it("does not render a create-bracket CTA", () => {
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
  });
});
