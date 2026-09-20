import { describe, expect, it } from "vitest";
import {
  formatPublishedAt,
  groupPublicBrackets,
  type DiscoveryBracket,
} from "./discovery-view-model";

function bracket(overrides: Partial<DiscoveryBracket>): DiscoveryBracket {
  return {
    id: "b1",
    title: "Best Sitcom",
    visibility: "PUBLIC",
    status: "ACTIVE",
    publishedAt: new Date("2026-09-01T12:00:00.000Z"),
    creator: { displayName: "Jane" },
    ...overrides,
  };
}

describe("formatPublishedAt", () => {
  it("formats a date for a human to read, not a raw ISO timestamp", () => {
    const formatted = formatPublishedAt(new Date("2026-09-19T06:01:50.000Z"));

    expect(formatted).toBe("September 19, 2026");
    expect(formatted).not.toContain("T");
    expect(formatted).not.toContain("Z");
  });

  it("returns a placeholder for a null date", () => {
    expect(formatPublishedAt(null)).toBe("-");
  });
});

describe("groupPublicBrackets", () => {
  it("buckets a SCHEDULED public bracket into 'recent'", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "s1", status: "SCHEDULED" }),
    ]);

    expect(groups.recent.map((row) => row.id)).toEqual(["s1"]);
    expect(groups.active).toEqual([]);
    expect(groups.completed).toEqual([]);
  });

  it("buckets an ACTIVE public bracket into 'active'", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "a1", status: "ACTIVE" }),
    ]);

    expect(groups.active.map((row) => row.id)).toEqual(["a1"]);
    expect(groups.recent).toEqual([]);
    expect(groups.completed).toEqual([]);
  });

  it("buckets a COMPLETED public bracket into 'completed'", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "c1", status: "COMPLETED" }),
    ]);

    expect(groups.completed.map((row) => row.id)).toEqual(["c1"]);
    expect(groups.recent).toEqual([]);
    expect(groups.active).toEqual([]);
  });

  it("never puts a DRAFT bracket in any group, even if visibility is PUBLIC", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "d1", status: "DRAFT", visibility: "PUBLIC" }),
    ]);

    expect(groups.recent).toEqual([]);
    expect(groups.active).toEqual([]);
    expect(groups.completed).toEqual([]);
  });

  it("never puts a PRIVATE bracket in any group, regardless of status", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "p1", status: "SCHEDULED", visibility: "PRIVATE" }),
      bracket({ id: "p2", status: "ACTIVE", visibility: "PRIVATE" }),
      bracket({ id: "p3", status: "COMPLETED", visibility: "PRIVATE" }),
    ]);

    expect(groups.recent).toEqual([]);
    expect(groups.active).toEqual([]);
    expect(groups.completed).toEqual([]);
  });

  it("filters a mixed list down to only PUBLIC, non-DRAFT brackets in their correct groups", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "recent-1", status: "SCHEDULED", visibility: "PUBLIC" }),
      bracket({ id: "active-1", status: "ACTIVE", visibility: "PUBLIC" }),
      bracket({ id: "completed-1", status: "COMPLETED", visibility: "PUBLIC" }),
      bracket({ id: "private-draft", status: "DRAFT", visibility: "PRIVATE" }),
      bracket({ id: "private-active", status: "ACTIVE", visibility: "PRIVATE" }),
      bracket({ id: "public-draft", status: "DRAFT", visibility: "PUBLIC" }),
    ]);

    expect(groups.recent.map((row) => row.id)).toEqual(["recent-1"]);
    expect(groups.active.map((row) => row.id)).toEqual(["active-1"]);
    expect(groups.completed.map((row) => row.id)).toEqual(["completed-1"]);
  });

  it("preserves input order within a bucket (ordering is the caller's job)", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "newer", status: "ACTIVE" }),
      bracket({ id: "older", status: "ACTIVE" }),
    ]);

    expect(groups.active.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("maps title, status, formatted publishedAt, and creator display name onto each row", () => {
    const groups = groupPublicBrackets([
      bracket({
        id: "b2",
        title: "Best Movie",
        status: "COMPLETED",
        publishedAt: new Date("2026-01-15T12:00:00.000Z"),
        creator: { displayName: "Sam" },
      }),
    ]);

    expect(groups.completed).toEqual([
      {
        id: "b2",
        title: "Best Movie",
        status: "COMPLETED",
        publishedAt: "January 15, 2026",
        creatorName: "Sam",
      },
    ]);
  });

  it("falls back to a generic creator label when displayName is null", () => {
    const groups = groupPublicBrackets([
      bracket({ id: "b3", status: "ACTIVE", creator: { displayName: null } }),
    ]);

    expect(groups.active[0].creatorName).toBe("A creator");
  });

  it("returns empty arrays for every group when given no brackets", () => {
    const groups = groupPublicBrackets([]);

    expect(groups).toEqual({ recent: [], active: [], completed: [] });
  });
});
