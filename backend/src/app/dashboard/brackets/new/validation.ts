import { Visibility, VotingRequirement } from "@/generated/prisma/enums";

/**
 * Pure validation for the "create bracket" form (issue #10) - no Next.js,
 * Prisma, or Supabase import here, so it can be unit-tested directly
 * against a plain `FormData` without mocking any of those. `./actions.ts`
 * is a thin wrapper around this plus the actual `prisma.bracket.create()`
 * call and the redirect.
 *
 * Per the issue: title is required (everything else creates no row and
 * surfaces a validation error instead), description is optional,
 * visibility and voting-requires-account are both required selections
 * matching the `Visibility`/`VotingRequirement` enums in
 * `prisma/schema.prisma`.
 */
export type CreateBracketInput = {
  title: string;
  description: string | null;
  visibility: Visibility;
  votingRequirement: VotingRequirement;
};

export type CreateBracketValidationResult =
  | { ok: true; data: CreateBracketInput }
  | { ok: false; error: string };

const VISIBILITY_VALUES: readonly string[] = Object.values(Visibility);
const VOTING_REQUIREMENT_VALUES: readonly string[] =
  Object.values(VotingRequirement);

export function validateCreateBracketForm(
  formData: FormData
): CreateBracketValidationResult {
  const title = String(formData.get("title") ?? "").trim();
  if (title.length === 0) {
    return { ok: false, error: "Title is required." };
  }

  const descriptionRaw = String(formData.get("description") ?? "").trim();
  const description = descriptionRaw.length > 0 ? descriptionRaw : null;

  const visibility = formData.get("visibility");
  if (
    typeof visibility !== "string" ||
    !VISIBILITY_VALUES.includes(visibility)
  ) {
    return { ok: false, error: "Choose a visibility: Public or Private." };
  }

  const votingRequirement = formData.get("votingRequirement");
  if (
    typeof votingRequirement !== "string" ||
    !VOTING_REQUIREMENT_VALUES.includes(votingRequirement)
  ) {
    return {
      ok: false,
      error: "Choose whether voting requires an account.",
    };
  }

  return {
    ok: true,
    data: {
      title,
      description,
      visibility: visibility as Visibility,
      votingRequirement: votingRequirement as VotingRequirement,
    },
  };
}
