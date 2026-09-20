/**
 * Pure validation for a `BracketItem`'s add/edit form (issue #11, extended
 * by #12 for the optional image) - no Next.js, Prisma, or Supabase import
 * here, so it can be unit-tested directly against a plain `FormData`, the
 * same reasoning as `../new/validation.ts`. `./actions.ts` is a thin
 * wrapper around this plus the actual `prisma.bracketItem` calls and (for a
 * validated image) `./image-upload.ts`'s Supabase Storage upload.
 *
 * Per the issue: title is required (an empty/whitespace-only title creates
 * no row and surfaces a validation error instead), description is
 * optional. The image (#12) is optional too: `data.image` is `null` when no
 * file was chosen, or when editing without replacing an existing image -
 * `./actions.ts` only uploads and overwrites `BracketItem.image_url` when
 * it's non-null, leaving an existing image alone otherwise.
 */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB, per the issue.

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type BracketItemInput = {
  title: string;
  description: string | null;
  image: File | null;
};

export type BracketItemValidationResult =
  | { ok: true; data: BracketItemInput }
  | { ok: false; error: string };

export function validateBracketItemForm(
  formData: FormData
): BracketItemValidationResult {
  const title = String(formData.get("title") ?? "").trim();
  if (title.length === 0) {
    return { ok: false, error: "Title is required." };
  }

  const descriptionRaw = String(formData.get("description") ?? "").trim();
  const description = descriptionRaw.length > 0 ? descriptionRaw : null;

  const imageResult = validateImageFile(formData.get("image"));
  if (!imageResult.ok) {
    return { ok: false, error: imageResult.error };
  }

  return {
    ok: true,
    data: { title, description, image: imageResult.image },
  };
}

type ImageValidationResult =
  | { ok: true; image: File | null }
  | { ok: false; error: string };

function validateImageFile(value: FormDataEntryValue | null): ImageValidationResult {
  // An untouched `<input type="file">` still submits an entry - a `File`
  // with an empty name and zero size - rather than nothing at all. Both
  // that case and a genuinely absent field mean "no image chosen".
  if (!(value instanceof File) || value.size === 0) {
    return { ok: true, image: null };
  }

  if (!ALLOWED_IMAGE_MIME_TYPES.includes(value.type as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
    return {
      ok: false,
      error: "Image must be a PNG, JPEG, or WebP file.",
    };
  }

  if (value.size > MAX_IMAGE_SIZE_BYTES) {
    return { ok: false, error: "Image must be 5MB or smaller." };
  }

  return { ok: true, image: value };
}
