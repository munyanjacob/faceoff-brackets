import { describe, expect, it } from "vitest";
import {
  parseDatetimeLocalValue,
  toDatetimeLocalValue,
  validateScheduledStartForm,
} from "./scheduled-start";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

// A fixed "now" so these stay deterministic regardless of when the suite
// runs - the past/future dates below are picked well clear of it.
const NOW = new Date("2026-06-15T12:00:00");
const PAST = "2020-01-01T09:00";
const FUTURE = "2030-01-01T09:00";

describe("validateScheduledStartForm", () => {
  it("is valid and leaves scheduledStartAt null when startMode is immediate", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "immediate" }),
      NOW
    );

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("defaults to immediate (null) when startMode is missing entirely", () => {
    const result = validateScheduledStartForm(formData({}), NOW);

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("is valid regardless of what scheduledStartAt holds when startMode is immediate", () => {
    // Stale/leftover picker value from switching modes client-side - must
    // be ignored, not validated, once immediate is chosen.
    const result = validateScheduledStartForm(
      formData({ startMode: "immediate", scheduledStartAt: PAST }),
      NOW
    );

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("accepts a future date/time when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "scheduled", scheduledStartAt: FUTURE }),
      NOW
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scheduledStartAt).toEqual(new Date(FUTURE));
    }
  });

  it("rejects a past date/time when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "scheduled", scheduledStartAt: PAST }),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "The scheduled start time must be in the future.",
    });
  });

  it("rejects the current instant itself (not strictly in the future) when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({
        startMode: "scheduled",
        scheduledStartAt: toDatetimeLocalValue(NOW),
      }),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "The scheduled start time must be in the future.",
    });
  });

  it("rejects a missing date/time when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "scheduled" }),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    });
  });

  it("rejects a blank date/time when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "scheduled", scheduledStartAt: "   " }),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    });
  });

  it("rejects an unparseable date/time when scheduled is chosen", () => {
    const result = validateScheduledStartForm(
      formData({ startMode: "scheduled", scheduledStartAt: "not a date" }),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    });
  });
});

describe("parseDatetimeLocalValue", () => {
  it("parses a well-formed datetime-local value", () => {
    const parsed = parseDatetimeLocalValue("2030-01-01T09:00");
    expect(parsed).toEqual(new Date("2030-01-01T09:00"));
  });

  it("returns null for missing/non-string/blank/invalid input", () => {
    expect(parseDatetimeLocalValue(null)).toBeNull();
    expect(parseDatetimeLocalValue("")).toBeNull();
    expect(parseDatetimeLocalValue("   ")).toBeNull();
    expect(parseDatetimeLocalValue("not a date")).toBeNull();
  });
});

describe("toDatetimeLocalValue", () => {
  it("formats a Date as YYYY-MM-DDTHH:mm in local time", () => {
    const date = new Date(2030, 0, 5, 9, 30); // Jan 5, 2030, 09:30 local
    expect(toDatetimeLocalValue(date)).toBe("2030-01-05T09:30");
  });

  it("pads single-digit month/day/hour/minute", () => {
    const date = new Date(2030, 8, 3, 4, 5); // Sep 3, 2030, 04:05 local
    expect(toDatetimeLocalValue(date)).toBe("2030-09-03T04:05");
  });

  it("round-trips through parseDatetimeLocalValue", () => {
    const original = new Date(2031, 5, 20, 14, 45);
    const roundTripped = parseDatetimeLocalValue(
      toDatetimeLocalValue(original)
    );
    expect(roundTripped).toEqual(original);
  });
});
