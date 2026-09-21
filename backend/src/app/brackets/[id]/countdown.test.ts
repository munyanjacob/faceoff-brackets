import { describe, expect, it } from "vitest";
import { CLOSING_DISPLAY, formatCountdown } from "./countdown";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("formatCountdown", () => {
  it("shows days and hours when more than a day remains", () => {
    const endsAt = new Date("2026-01-03T02:30:00.000Z"); // 2d 2h30m out
    expect(formatCountdown(endsAt, NOW)).toEqual({
      status: "counting",
      display: "2d 2h remaining",
    });
  });

  it("shows hours and minutes when less than a day but more than an hour remains", () => {
    const endsAt = new Date("2026-01-01T23:14:00.000Z"); // 23h14m out
    expect(formatCountdown(endsAt, NOW)).toEqual({
      status: "counting",
      display: "23h 14m remaining",
    });
  });

  it("shows only minutes when less than an hour remains", () => {
    const endsAt = new Date("2026-01-01T00:45:00.000Z"); // 45m out
    expect(formatCountdown(endsAt, NOW)).toEqual({
      status: "counting",
      display: "45m remaining",
    });
  });

  it("shows a 'less than a minute' message when under a minute remains but time hasn't run out", () => {
    const endsAt = new Date("2026-01-01T00:00:30.000Z"); // 30s out
    expect(formatCountdown(endsAt, NOW)).toEqual({
      status: "counting",
      display: "less than a minute remaining",
    });
  });

  it("floors partial minutes rather than rounding up", () => {
    const endsAt = new Date("2026-01-01T00:01:59.000Z"); // 1m59s out
    expect(formatCountdown(endsAt, NOW)).toEqual({
      status: "counting",
      display: "1m remaining",
    });
  });

  it("shows the closing state at the exact instant endsAt is reached, not '0m remaining'", () => {
    expect(formatCountdown(NOW, NOW)).toEqual({
      status: "closing",
      display: CLOSING_DISPLAY,
    });
  });

  it("shows the closing state once endsAt is in the past, never a negative duration", () => {
    const endsAt = new Date("2025-12-31T23:00:00.000Z"); // 1h in the past
    const result = formatCountdown(endsAt, NOW);

    expect(result).toEqual({ status: "closing", display: CLOSING_DISPLAY });
    // No digit-based duration (e.g. "-60m remaining") ever leaks into the
    // closing message - it's a fixed, non-numeric sentence.
    expect(result.display).not.toMatch(/\d/);
  });

  it("accepts an ISO string endsAt the same way it accepts a Date", () => {
    expect(formatCountdown("2026-01-01T00:45:00.000Z", NOW)).toEqual({
      status: "counting",
      display: "45m remaining",
    });
  });

  it("defaults now to the current time when not provided", () => {
    const soon = new Date(Date.now() + 5 * 60_000);
    const result = formatCountdown(soon);

    expect(result.status).toBe("counting");
  });
});
