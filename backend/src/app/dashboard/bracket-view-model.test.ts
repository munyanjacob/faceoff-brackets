import { describe, expect, it } from "vitest";
import {
  bracketLinkHref,
  currentRoundNumber,
  formatCreatedAt,
  groupBracketsByStatus,
  toBracketRow,
} from "./bracket-view-model";
import type { BracketRow } from "./bracket-view-model";

describe("currentRoundNumber", () => {
  it("returns '-' when the bracket has no Round rows (DRAFT/SCHEDULED)", () => {
    expect(currentRoundNumber([])).toBe("-");
  });

  it("returns the only round number when there is exactly one round", () => {
    expect(currentRoundNumber([{ roundNumber: 1 }])).toBe(1);
  });

  it("returns the highest round number regardless of input order", () => {
    expect(
      currentRoundNumber([
        { roundNumber: 2 },
        { roundNumber: 4 },
        { roundNumber: 1 },
        { roundNumber: 3 },
      ])
    ).toBe(4);
  });
});

describe("formatCreatedAt", () => {
  it("formats a date for a human to read, not a raw ISO timestamp", () => {
    const formatted = formatCreatedAt(new Date("2026-09-19T06:01:50.000Z"));

    expect(formatted).toBe("September 19, 2026");
    expect(formatted).not.toContain("T");
    expect(formatted).not.toContain("Z");
  });
});

describe("toBracketRow", () => {
  it("passes the status through as the raw enum value, with no label mapping", () => {
    const row = toBracketRow({
      id: "b1",
      title: "Best Sitcom",
      status: "DRAFT",
      createdAt: new Date("2026-09-19T06:01:50.000Z"),
      rounds: [],
    });

    expect(row).toEqual({
      id: "b1",
      title: "Best Sitcom",
      status: "DRAFT",
      currentRoundNumber: "-",
      createdAt: "September 19, 2026",
    });
  });

  it("computes the current round number from the bracket's rounds", () => {
    const row = toBracketRow({
      id: "b2",
      title: "Best Movie",
      status: "ACTIVE",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      rounds: [{ roundNumber: 1 }, { roundNumber: 2 }],
    });

    expect(row.currentRoundNumber).toBe(2);
  });
});

function makeRow(overrides: Partial<BracketRow> & { id: string }): BracketRow {
  return {
    title: `Bracket ${overrides.id}`,
    status: "DRAFT",
    currentRoundNumber: "-",
    createdAt: "September 19, 2026",
    ...overrides,
  };
}

describe("groupBracketsByStatus", () => {
  it("partitions brackets into the four Bracket.status buckets", () => {
    const draft = makeRow({ id: "b1", status: "DRAFT" });
    const scheduled = makeRow({ id: "b2", status: "SCHEDULED" });
    const active = makeRow({ id: "b3", status: "ACTIVE" });
    const completed = makeRow({ id: "b4", status: "COMPLETED" });

    const groups = groupBracketsByStatus([draft, scheduled, active, completed]);

    expect(groups).toEqual({
      DRAFT: [draft],
      SCHEDULED: [scheduled],
      ACTIVE: [active],
      COMPLETED: [completed],
    });
  });

  it("returns an empty array for a status with no brackets", () => {
    const groups = groupBracketsByStatus([makeRow({ id: "b1", status: "DRAFT" })]);

    expect(groups.SCHEDULED).toEqual([]);
    expect(groups.ACTIVE).toEqual([]);
    expect(groups.COMPLETED).toEqual([]);
  });

  it("preserves the caller's ordering within each bucket", () => {
    const newer = makeRow({ id: "newer", status: "ACTIVE" });
    const older = makeRow({ id: "older", status: "ACTIVE" });

    const groups = groupBracketsByStatus([newer, older]);

    expect(groups.ACTIVE).toEqual([newer, older]);
  });

  it("handles multiple brackets sharing the same status", () => {
    const first = makeRow({ id: "b1", status: "DRAFT" });
    const second = makeRow({ id: "b2", status: "DRAFT" });

    const groups = groupBracketsByStatus([first, second]);

    expect(groups.DRAFT).toEqual([first, second]);
  });

  it("returns all-empty buckets for an empty input", () => {
    expect(groupBracketsByStatus([])).toEqual({
      DRAFT: [],
      SCHEDULED: [],
      ACTIVE: [],
      COMPLETED: [],
    });
  });
});

describe("bracketLinkHref", () => {
  it("links a DRAFT bracket to its edit flow", () => {
    expect(bracketLinkHref({ id: "b1", status: "DRAFT" })).toBe(
      "/dashboard/brackets/b1/edit"
    );
  });

  it("links a SCHEDULED bracket to its edit flow", () => {
    expect(bracketLinkHref({ id: "b1", status: "SCHEDULED" })).toBe(
      "/dashboard/brackets/b1/edit"
    );
  });

  it("links an ACTIVE bracket to the (placeholder) public bracket view", () => {
    expect(bracketLinkHref({ id: "b1", status: "ACTIVE" })).toBe(
      "/brackets/b1"
    );
  });

  it("links a COMPLETED bracket to the (placeholder) public bracket view", () => {
    expect(bracketLinkHref({ id: "b1", status: "COMPLETED" })).toBe(
      "/brackets/b1"
    );
  });
});
