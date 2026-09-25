import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedBracket } from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { NOT_DRAFT_ROUND_DURATION_MESSAGE } from "@/lib/api/messages";
import { pickStringFields } from "@/lib/api/pick-string-fields";
import {
  computeTotalRounds,
  serializeRoundDurationOverrides,
  validateRoundDurationForm,
} from "@/app/dashboard/brackets/[id]/edit/round-duration";

// PATCH /brackets/{bracketId}/round-duration (issue #53,
// docs/openapi.yaml's updateRoundDuration)
//
// Creator-only, draft-only - wraps the same lookup/validation/persistence
// `src/app/dashboard/brackets/[id]/edit/round-duration-actions.ts`'s
// `updateRoundDuration` Server Action (#13) already runs:
// `prisma.bracket.findFirst({ where: { id, creatorId } })` (never `id`
// alone, per spec §4.9), the live `BracketItem` count driving
// `computeTotalRounds` (never a client-supplied total), and
// `validateRoundDurationForm` (#13) reused as-is - not re-derived - so the
// exact validation rules and error strings (spec §4.8) stay identical
// between the Server Action and this endpoint.
//
// `requestBodyToFormData` below only adapts the *shape* of the input (JSON
// body -> the `FormData` shape `validateRoundDurationForm` expects, via the
// shared `pickStringFields` - issue #79 - the same pattern `POST /brackets`
// (#51) uses for `validateCreateBracketForm`) - it never re-implements a
// rule that function already enforces.
//
// Per spec §4.9: a missing/invalid bearer token is 401 (checked first,
// inside the shared `requireOwnedBracket` - issue #72 - so an anonymous
// caller never reaches the ownership lookup); "doesn't exist" and "exists
// but isn't owned by the caller" are indistinguishable, both a 404
// NOT_FOUND (never 403); a real-but-wrong-state bracket (not DRAFT) is a
// distinct 409, with the Server Action's exact existing message
// (`NOT_DRAFT_ROUND_DURATION_MESSAGE`, `@/lib/api/messages` - issue #74)
// carried over unchanged.

type RouteParams = { params: Promise<{ bracketId: string }> };

/**
 * Adapts a parsed JSON request body (docs/openapi.yaml's
 * `UpdateRoundDurationRequest`: `{ defaultRoundDurationMinutes, overrides
 * }`, `overrides` keyed by absolute round number as a string) into the
 * `FormData` shape `validateRoundDurationForm` expects
 * (`defaultRoundDurationMinutes` plus one `roundOverride-<n>` field per
 * override), so that function can be reused unmodified. `pickStringFields`
 * (`@/lib/api/pick-string-fields`, issue #79) does the actual per-field
 * type-checking/coercion; a non-string/non-number value for either field is
 * simply left unset on the resulting `FormData` -
 * `validateRoundDurationForm` already treats a missing field as "not
 * provided" and handles it with its normal, exact error string (or, for an
 * override, silently as "no override for that round").
 */
function requestBodyToFormData(body: unknown): FormData {
  const formData = new FormData();

  const topLevel = pickStringFields(body, [
    "defaultRoundDurationMinutes",
  ] as const);
  if (topLevel.defaultRoundDurationMinutes !== undefined) {
    formData.set(
      "defaultRoundDurationMinutes",
      topLevel.defaultRoundDurationMinutes
    );
  }

  const overrides =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).overrides
      : undefined;
  if (overrides !== null && overrides !== undefined && typeof overrides === "object") {
    const overrideRecord = overrides as Record<string, unknown>;
    const overrideFields = pickStringFields(
      overrideRecord,
      Object.keys(overrideRecord)
    );
    for (const [roundNumber, minutes] of Object.entries(overrideFields)) {
      if (minutes !== undefined) {
        formData.set(`roundOverride-${roundNumber}`, minutes);
      }
    }
  }

  return formData;
}

export const PATCH = async (
  request: Request,
  { params }: RouteParams
): Promise<Response> => {
  const response = await withErrorHandling(async () => {
    const { bracketId } = await params;

    const lookup = await requireOwnedBracket(request, bracketId);
    if (!lookup.ok) {
      return lookup.response;
    }
    const { bracket } = lookup;

    if (bracket.status !== "DRAFT") {
      return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_ROUND_DURATION_MESSAGE);
    }

    const itemCount = await prisma.bracketItem.count({
      where: { bracketId: bracket.id },
    });
    const totalRounds = computeTotalRounds(itemCount);

    // A malformed/empty JSON body falls through as `{}`, which
    // `requestBodyToFormData`/`validateRoundDurationForm` reject the same
    // way as a request that simply omitted every field ("Default round
    // duration is required.") - not a separate, undocumented error shape.
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Left as `{}` - see above.
    }

    const validated = validateRoundDurationForm(
      requestBodyToFormData(body),
      totalRounds
    );
    if (!validated.ok) {
      return errorResponse(400, "VALIDATION_ERROR", validated.error);
    }

    const updated = await prisma.bracket.update({
      where: { id: bracket.id },
      data: {
        defaultRoundDurationMinutes: validated.data.defaultRoundDurationMinutes,
        roundDurationOverrides: serializeRoundDurationOverrides(
          validated.data.overrides
        ),
      },
    });

    // Unlike the other bracket-returning endpoints (`toWireBracket`, issue
    // #73), this route doesn't need to normalize `roundDurationOverrides`
    // here - `update`'s own `data` just set it to
    // `serializeRoundDurationOverrides(...)`'s result, which is always a
    // plain object (never null), so `updated.roundDurationOverrides` is
    // already in the openapi.yaml-documented shape without going through
    // `parseStoredRoundDurationOverrides` first.
    return NextResponse.json(updated);
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
