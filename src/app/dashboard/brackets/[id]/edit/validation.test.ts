import { describe, expect, it } from "vitest";
import { validateBracketItemForm } from "./validation";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

describe("validateBracketItemForm", () => {
  it("accepts a fully filled-in form and trims the title/description", () => {
    const result = validateBracketItemForm(
      formData({ title: "  Die Hard  ", description: "  A Christmas movie.  " })
    );

    expect(result).toEqual({
      ok: true,
      data: { title: "Die Hard", description: "A Christmas movie." },
    });
  });

  it("treats a missing description as null, not an empty string", () => {
    const result = validateBracketItemForm(formData({ title: "Die Hard" }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.description).toBeNull();
  });

  it("treats a whitespace-only description as null", () => {
    const result = validateBracketItemForm(
      formData({ title: "Die Hard", description: "   " })
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.description).toBeNull();
  });

  it("rejects a missing title and creates no data", () => {
    const result = validateBracketItemForm(
      formData({ description: "A Christmas movie." })
    );

    expect(result).toEqual({ ok: false, error: "Title is required." });
  });

  it("rejects a whitespace-only title", () => {
    const result = validateBracketItemForm(formData({ title: "   " }));

    expect(result).toEqual({ ok: false, error: "Title is required." });
  });
});
