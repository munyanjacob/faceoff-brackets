/**
 * Pure validation for a `BracketItem`'s add/edit form (issue #11) - no
 * Next.js, Prisma, or Supabase import here, so it can be unit-tested
 * directly against a plain `FormData`, the same reasoning as
 * `../new/validation.ts`. `./actions.ts` is a thin wrapper around this plus
 * the actual `prisma.bracketItem` calls.
 *
 * Per the issue: title is required (an empty/whitespace-only title creates
 * no row and surfaces a validation error instead), description is
 * optional.
 */
export type BracketItemInput = {
  title: string;
  description: string | null;
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

  return {
    ok: true,
    data: { title, description },
  };
}
