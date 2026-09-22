import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/api/auth";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { validateCreateBracketForm } from "@/app/dashboard/brackets/new/validation";
import { parseStoredRoundDurationOverrides } from "@/app/dashboard/brackets/[id]/edit/round-duration";

// POST /brackets (issue #51, docs/openapi.yaml's createBracket)
//
// Wraps the same validation and creation logic
// `src/app/dashboard/brackets/new/actions.ts`'s `createBracket` Server
// Action already uses, adapted from a Server Action's `FormData` submission
// to this endpoint's `application/json` request body (per openapi.yaml's
// `CreateBracketRequest`). `validateCreateBracketForm` (#10) is reused
// as-is - not re-derived - so the exact validation rules and error strings
// (spec §4.8) stay identical between the Server Action and this endpoint;
// `requestBodyToFormData` below only adapts the *shape* of the input, never
// re-implements a rule `validateCreateBracketForm` already enforces.

// #13/#14 let the creator configure round durations explicitly; until then,
// every draft created here gets this same placeholder - see
// `.../brackets/new/actions.ts`'s identical constant/comment and
// openapi.yaml's createBracket note ("defaultRoundDurationMinutes is
// currently server-assigned (60)").
const PLACEHOLDER_DEFAULT_ROUND_DURATION_MINUTES = 60;

/**
 * Adapts a parsed JSON request body into the `FormData` shape
 * `validateCreateBracketForm` expects, so that function can be reused
 * unmodified. Only lifts the four fields `CreateBracketRequest` defines;
 * anything else on the body is ignored. A field that isn't a string (missing,
 * `null`, a number, etc.) is simply left unset on the resulting `FormData` -
 * `formData.get(...)` then returns `null`, which
 * `validateCreateBracketForm` already treats as "missing" and rejects with
 * its normal, exact error string.
 */
function requestBodyToFormData(body: unknown): FormData {
  const formData = new FormData();
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of [
      "title",
      "description",
      "visibility",
      "votingRequirement",
    ] as const) {
      const value = record[key];
      if (typeof value === "string") {
        formData.set(key, value);
      }
    }
  }
  return formData;
}

export const POST = async (request: Request): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return unauthorizedResponse();
    }

    // A malformed/empty JSON body falls through as `{}`, which
    // `requestBodyToFormData`/`validateCreateBracketForm` reject the same
    // way as a request that simply omitted every field ("Title is
    // required.") - not a separate, undocumented error shape.
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Left as `{}` - see above.
    }

    const validated = validateCreateBracketForm(requestBodyToFormData(body));
    if (!validated.ok) {
      return errorResponse(400, "VALIDATION_ERROR", validated.error);
    }

    const bracket = await prisma.bracket.create({
      data: {
        creatorId: userId,
        title: validated.data.title,
        description: validated.data.description,
        visibility: validated.data.visibility,
        votingRequirement: validated.data.votingRequirement,
        defaultRoundDurationMinutes:
          PLACEHOLDER_DEFAULT_ROUND_DURATION_MINUTES,
        status: "DRAFT",
      },
    });

    return NextResponse.json(
      {
        ...bracket,
        // See brackets/[bracketId]/route.ts's identical normalization -
        // a fresh bracket's column is null, but openapi.yaml documents
        // this field as always an object.
        roundDurationOverrides: parseStoredRoundDurationOverrides(
          bracket.roundDurationOverrides
        ),
      },
      { status: 201 }
    );
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
