import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  validateBracketItemForm,
} from "./validation";

function formData(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function fileOfSize(size: number, type: string, name = "image"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("validateBracketItemForm", () => {
  it("accepts a fully filled-in form and trims the title/description", () => {
    const result = validateBracketItemForm(
      formData({ title: "  Die Hard  ", description: "  A Christmas movie.  " })
    );

    expect(result).toEqual({
      ok: true,
      data: { title: "Die Hard", description: "A Christmas movie.", image: null },
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

  describe("image (issue #12)", () => {
    it("treats a form with no image field as no image chosen", () => {
      const result = validateBracketItemForm(formData({ title: "Die Hard" }));

      expect(result.ok).toBe(true);
      expect(result.ok && result.data.image).toBeNull();
    });

    it("treats an untouched file input's empty File as no image chosen", () => {
      // Browsers submit a zero-size, empty-name File (not nothing) for an
      // `<input type="file">` the user never interacted with.
      const result = validateBracketItemForm(
        formData({ title: "Die Hard", image: new File([], "", { type: "" }) })
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.data.image).toBeNull();
    });

    it.each(ALLOWED_IMAGE_MIME_TYPES)(
      "accepts a valid %s image under the size limit",
      (mimeType) => {
        const image = fileOfSize(1024, mimeType);

        const result = validateBracketItemForm(
          formData({ title: "Die Hard", image })
        );

        expect(result).toEqual({
          ok: true,
          data: { title: "Die Hard", description: null, image },
        });
      }
    );

    it("accepts an image exactly at the size limit", () => {
      const image = fileOfSize(MAX_IMAGE_SIZE_BYTES, "image/png");

      const result = validateBracketItemForm(
        formData({ title: "Die Hard", image })
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.data.image).toBe(image);
    });

    it("rejects a file over the size limit and creates no data", () => {
      const image = fileOfSize(MAX_IMAGE_SIZE_BYTES + 1, "image/png");

      const result = validateBracketItemForm(
        formData({ title: "Die Hard", image })
      );

      expect(result).toEqual({
        ok: false,
        error: "Image must be 5MB or smaller.",
      });
    });

    it("rejects a non-image file type and creates no data", () => {
      const image = fileOfSize(1024, "text/plain", "notes.txt");

      const result = validateBracketItemForm(
        formData({ title: "Die Hard", image })
      );

      expect(result).toEqual({
        ok: false,
        error: "Image must be a PNG, JPEG, or WebP file.",
      });
    });

    it("rejects an unsupported image type (e.g. GIF) and creates no data", () => {
      const image = fileOfSize(1024, "image/gif", "animated.gif");

      const result = validateBracketItemForm(
        formData({ title: "Die Hard", image })
      );

      expect(result).toEqual({
        ok: false,
        error: "Image must be a PNG, JPEG, or WebP file.",
      });
    });

    it("rejects the image and creates no data even when the title is also missing", () => {
      // Title errors are checked first - an oversized/invalid image on an
      // otherwise-empty form still surfaces the title error, matching the
      // field order in `validateBracketItemForm`.
      const image = fileOfSize(MAX_IMAGE_SIZE_BYTES + 1, "image/png");

      const result = validateBracketItemForm(formData({ image }));

      expect(result).toEqual({ ok: false, error: "Title is required." });
    });
  });
});
