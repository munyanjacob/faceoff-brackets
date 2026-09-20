import { describe, expect, it } from "vitest";
import {
  currentRoundNumber,
  formatCreatedAt,
  toBracketRow,
} from "./bracket-view-model";

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
