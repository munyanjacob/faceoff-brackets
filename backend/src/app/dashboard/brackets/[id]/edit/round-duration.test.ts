import { describe, expect, it } from "vitest";
import {
  computeTotalRounds,
  parseStoredRoundDurationOverrides,
  roundNameHint,
  serializeRoundDurationOverrides,
  validateRoundDurationForm,
} from "./round-duration";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("computeTotalRounds", () => {
  it("is 0 for fewer than 2 items", () => {
    expect(computeTotalRounds(0)).toBe(0);
    expect(computeTotalRounds(1)).toBe(0);
  });

  it("is ceil(log2(itemCount)) for a power of two", () => {
    expect(computeTotalRounds(2)).toBe(1);
    expect(computeTotalRounds(4)).toBe(2);
    expect(computeTotalRounds(8)).toBe(3);
    expect(computeTotalRounds(16)).toBe(4);
  });

  it("rounds up for a non-power-of-two item count", () => {
    expect(computeTotalRounds(3)).toBe(2);
    expect(computeTotalRounds(5)).toBe(3);
    expect(computeTotalRounds(9)).toBe(4);
    expect(computeTotalRounds(17)).toBe(5);
  });
});

describe("roundNameHint", () => {
  it("labels the last round Final", () => {
    expect(roundNameHint(3, 3)).toBe("Final");
    expect(roundNameHint(1, 1)).toBe("Final");
  });

  it("labels the second-to-last round Semifinal when there are at least 2 rounds", () => {
    expect(roundNameHint(2, 3)).toBe("Semifinal");
    expect(roundNameHint(3, 4)).toBe("Semifinal");
  });

  it("gives no hint for an earlier round", () => {
    expect(roundNameHint(1, 3)).toBeNull();
    expect(roundNameHint(2, 4)).toBeNull();
  });

  it("gives no hint outside the valid round range", () => {
    expect(roundNameHint(0, 3)).toBeNull();
    expect(roundNameHint(4, 3)).toBeNull();
    expect(roundNameHint(1, 0)).toBeNull();
  });
});

describe("validateRoundDurationForm", () => {
  it("accepts a default-only submission with no overrides", () => {
    const result = validateRoundDurationForm(
      formData({ defaultRoundDurationMinutes: "60" }),
      3
    );

    expect(result).toEqual({
      ok: true,
      data: { defaultRoundDurationMinutes: 60, overrides: {} },
    });
  });

  it("accepts overrides for some but not all rounds", () => {
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "120",
        "roundOverride-3": "30",
      }),
      3
    );

    expect(result).toEqual({
      ok: true,
      data: {
        defaultRoundDurationMinutes: 60,
        overrides: { 1: 120, 3: 30 },
      },
    });
  });

  it("treats a blank override field as no override, not zero", () => {
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "   ",
      }),
      1
    );

    expect(result).toEqual({
      ok: true,
      data: { defaultRoundDurationMinutes: 60, overrides: {} },
    });
  });

  it("rejects a missing default duration", () => {
    const result = validateRoundDurationForm(formData({}), 2);

    expect(result).toEqual({
      ok: false,
      error: "Default round duration is required.",
    });
  });

  it("rejects a zero default duration", () => {
    const result = validateRoundDurationForm(
      formData({ defaultRoundDurationMinutes: "0" }),
      2
    );

    expect(result).toEqual({
      ok: false,
      error: "Default round duration must be a positive number of minutes.",
    });
  });

  it("rejects a negative default duration", () => {
    const result = validateRoundDurationForm(
      formData({ defaultRoundDurationMinutes: "-30" }),
      2
    );

    expect(result).toEqual({
      ok: false,
      error: "Default round duration must be a positive number of minutes.",
    });
  });

  it("rejects a zero override duration", () => {
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "0",
      }),
      2
    );

    expect(result).toEqual({
      ok: false,
      error: "Round 1's duration must be a positive number of minutes.",
    });
  });

  it("rejects a negative override duration", () => {
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-2": "-15",
      }),
      2
    );

    expect(result).toEqual({
      ok: false,
      error: "Round 2's duration must be a positive number of minutes.",
    });
  });

  it("rejects a non-numeric override duration", () => {
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "not a number",
      }),
      1
    );

    expect(result).toEqual({
      ok: false,
      error: "Round 1's duration must be a whole number of minutes.",
    });
  });

  it("ignores a form field for a round beyond the current total (never reads it, doesn't crash)", () => {
    // Simulates a stale form (opened before items were removed, dropping the
    // computed total) submitting an override for a round number the server
    // no longer thinks exists.
    const result = validateRoundDurationForm(
      formData({
        defaultRoundDurationMinutes: "60",
        "roundOverride-1": "45",
        "roundOverride-5": "999",
      }),
      1
    );

    expect(result).toEqual({
      ok: true,
      data: { defaultRoundDurationMinutes: 60, overrides: { 1: 45 } },
    });
  });

  it("is valid with totalRounds of 0 (fewer than 2 items) and no override fields", () => {
    const result = validateRoundDurationForm(
      formData({ defaultRoundDurationMinutes: "60" }),
      0
    );

    expect(result).toEqual({
      ok: true,
      data: { defaultRoundDurationMinutes: 60, overrides: {} },
    });
  });
});

describe("parseStoredRoundDurationOverrides", () => {
  it("parses a well-formed overrides object", () => {
    expect(parseStoredRoundDurationOverrides({ "1": 120, "2": 30 })).toEqual({
      1: 120,
      2: 30,
    });
  });

  it("returns an empty object for null", () => {
    expect(parseStoredRoundDurationOverrides(null)).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(parseStoredRoundDurationOverrides(undefined)).toEqual({});
  });

  it("returns an empty object for an already-empty object", () => {
    expect(parseStoredRoundDurationOverrides({})).toEqual({});
  });

  it("does not crash on a stale round number that exceeds any plausible current total", () => {
    expect(parseStoredRoundDurationOverrides({ "1": 60, "5": 999 })).toEqual({
      1: 60,
      5: 999,
    });
  });

  it("drops non-positive-integer keys and values instead of throwing", () => {
    expect(
      parseStoredRoundDurationOverrides({
        "0": 60,
        "-1": 60,
        "1.5": 60,
        "2": 0,
        "3": -10,
        "4": "not a number",
        "5": 45,
      })
    ).toEqual({ 5: 45 });
  });

  it("does not crash and returns an empty object for a non-object value", () => {
    expect(parseStoredRoundDurationOverrides("not an object")).toEqual({});
    expect(parseStoredRoundDurationOverrides(42)).toEqual({});
    expect(parseStoredRoundDurationOverrides([1, 2, 3])).toEqual({});
  });
});

describe("serializeRoundDurationOverrides", () => {
  it("serializes an empty overrides map to an empty object", () => {
    expect(serializeRoundDurationOverrides({})).toEqual({});
  });

  it("serializes round-number keys to string keys for JSON storage", () => {
    expect(serializeRoundDurationOverrides({ 1: 120, 2: 30 })).toEqual({
      "1": 120,
      "2": 30,
    });
  });
});
