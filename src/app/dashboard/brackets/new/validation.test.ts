import { describe, expect, it } from "vitest";
import { validateCreateBracketForm } from "./validation";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("validateCreateBracketForm", () => {
  it("accepts a fully filled-in form and trims the title/description", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "  Best Sitcom  ",
        description: "  A friendly poll.  ",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({
      ok: true,
      data: {
        title: "Best Sitcom",
        description: "A friendly poll.",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      },
    });
  });

  it("treats a missing description as null, not an empty string", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.description).toBeNull();
  });

  it("treats a whitespace-only description as null", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        description: "   ",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.description).toBeNull();
  });

  it("rejects a missing title and creates no data", () => {
    const result = validateCreateBracketForm(
      formData({
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({ ok: false, error: "Title is required." });
  });

  it("rejects a whitespace-only title", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "   ",
        visibility: "PUBLIC",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({ ok: false, error: "Title is required." });
  });

  it("rejects a missing visibility", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({
      ok: false,
      error: "Choose a visibility: Public or Private.",
    });
  });

  it("rejects an invalid visibility value", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        visibility: "SECRET",
        votingRequirement: "ANONYMOUS_ALLOWED",
      })
    );

    expect(result).toEqual({
      ok: false,
      error: "Choose a visibility: Public or Private.",
    });
  });

  it("rejects a missing voting requirement", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        visibility: "PUBLIC",
      })
    );

    expect(result).toEqual({
      ok: false,
      error: "Choose whether voting requires an account.",
    });
  });

  it("rejects an invalid voting requirement value", () => {
    const result = validateCreateBracketForm(
      formData({
        title: "Best Sitcom",
        visibility: "PUBLIC",
        votingRequirement: "MAYBE",
      })
    );

    expect(result).toEqual({
      ok: false,
      error: "Choose whether voting requires an account.",
    });
  });
});
