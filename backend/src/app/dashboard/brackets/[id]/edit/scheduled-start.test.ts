import { describe, expect, it } from "vitest";
import {
  parseDatetimeLocalValue,
  parseIsoDatetimeValue,
  toDatetimeLocalValue,
  validateScheduledStartForm,
  validateScheduleRequest,
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

// Issue #53 - the PATCH /brackets/{bracketId}/schedule REST endpoint's
// deliberate behavior change from the datetime-local Server Action: real
// timezone-aware ISO-8601 parsing, never local-time reinterpretation. See
// docs/frontend-rework-specification.md §9.4 and parseIsoDatetimeValue's
// own doc comment.
describe("parseIsoDatetimeValue", () => {
  it("parses a UTC (Z-suffixed) ISO-8601 string to the correct instant", () => {
    const parsed = parseIsoDatetimeValue("2030-01-01T09:00:00.000Z");
    expect(parsed).toEqual(new Date("2030-01-01T09:00:00.000Z"));
  });

  it("parses an ISO-8601 string with a non-UTC offset to the correct UTC instant - the behavior-change case", () => {
    // "2030-01-01T09:00:00-04:00" is the same instant as
    // "2030-01-01T13:00:00Z" - proving the offset itself is honored, not
    // dropped or reinterpreted as this server process's own local time
    // (which parseDatetimeLocalValue would do for an offset-less string).
    const parsed = parseIsoDatetimeValue("2030-01-01T09:00:00-04:00");
    expect(parsed).toEqual(new Date("2030-01-01T13:00:00.000Z"));
    expect(parsed?.toISOString()).toBe("2030-01-01T13:00:00.000Z");
  });

  it("parses a positive-offset ISO-8601 string to the correct UTC instant", () => {
    const parsed = parseIsoDatetimeValue("2030-06-15T23:30:00+05:30");
    expect(parsed?.toISOString()).toBe("2030-06-15T18:00:00.000Z");
  });

  it("returns null for missing/non-string/blank/invalid input", () => {
    expect(parseIsoDatetimeValue(undefined)).toBeNull();
    expect(parseIsoDatetimeValue(null)).toBeNull();
    expect(parseIsoDatetimeValue(123)).toBeNull();
    expect(parseIsoDatetimeValue("")).toBeNull();
    expect(parseIsoDatetimeValue("   ")).toBeNull();
    expect(parseIsoDatetimeValue("not a date")).toBeNull();
  });
});

describe("validateScheduleRequest", () => {
  it("is valid and leaves scheduledStartAt null when startMode is immediate", () => {
    const result = validateScheduleRequest(
      { startMode: "immediate", scheduledStartAt: undefined },
      NOW
    );

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("is valid regardless of what scheduledStartAt holds when startMode is immediate", () => {
    const result = validateScheduleRequest(
      { startMode: "immediate", scheduledStartAt: "not a date" },
      NOW
    );

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("defaults to immediate (null) when startMode is anything other than the literal 'scheduled' value", () => {
    const result = validateScheduleRequest(
      { startMode: undefined, scheduledStartAt: undefined },
      NOW
    );

    expect(result).toEqual({ ok: true, data: { scheduledStartAt: null } });
  });

  it("accepts a future, UTC ISO-8601 scheduledStartAt when scheduled is chosen", () => {
    const result = validateScheduleRequest(
      { startMode: "scheduled", scheduledStartAt: "2030-01-01T09:00:00.000Z" },
      NOW
    );

    expect(result).toEqual({
      ok: true,
      data: { scheduledStartAt: new Date("2030-01-01T09:00:00.000Z") },
    });
  });

  it("accepts a future scheduledStartAt carrying a real, non-UTC timezone offset - the behavior-change case (spec §9.4)", () => {
    // NOW is 2026-06-15T12:00:00 (server-local, no offset - see this
    // file's NOW constant); "2026-06-16T09:00:00-04:00" is
    // 2026-06-16T13:00:00Z, safely after NOW regardless of what timezone
    // this test process runs in.
    const result = validateScheduleRequest(
      {
        startMode: "scheduled",
        scheduledStartAt: "2026-06-16T09:00:00-04:00",
      },
      NOW
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scheduledStartAt?.toISOString()).toBe(
        "2026-06-16T13:00:00.000Z"
      );
    }
  });

  it("rejects a past ISO-8601 scheduledStartAt when scheduled is chosen", () => {
    const result = validateScheduleRequest(
      { startMode: "scheduled", scheduledStartAt: "2020-01-01T09:00:00.000Z" },
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "The scheduled start time must be in the future.",
    });
  });

  it("rejects a missing scheduledStartAt when scheduled is chosen", () => {
    const result = validateScheduleRequest(
      { startMode: "scheduled", scheduledStartAt: undefined },
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    });
  });

  it("rejects a scheduledStartAt that isn't a string (e.g. a stray number) when scheduled is chosen", () => {
    const result = validateScheduleRequest(
      { startMode: "scheduled", scheduledStartAt: 1234567890 },
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A scheduled start requires a valid date and time.",
    });
  });

  it("does NOT treat a datetime-local-style (offset-less) string as local server time silently - it must carry a real ISO-8601 offset/Z to be understood as intended", () => {
    // This is the crux of the #53 behavior change: an offset-less string
    // is still handed straight to `new Date(...)`, exactly like an
    // offset-carrying one - `validateScheduleRequest` performs no special
    // "assume local time" fallback the way `parseDatetimeLocalValue` does.
    // We only assert here that parsing is delegated to
    // `parseIsoDatetimeValue` unconditionally (already proven directly
    // above) - i.e. this test documents intent rather than re-asserting
    // JS's own `Date` parsing rules.
    const viaScheduleRequest = validateScheduleRequest(
      { startMode: "scheduled", scheduledStartAt: "2030-01-01T09:00:00" },
      NOW
    );
    const viaDirectParse = parseIsoDatetimeValue("2030-01-01T09:00:00");

    expect(viaScheduleRequest.ok && viaScheduleRequest.data.scheduledStartAt).toEqual(
      viaDirectParse
    );
  });
});
