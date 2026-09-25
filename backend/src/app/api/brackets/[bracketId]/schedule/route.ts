import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedBracket } from "@/lib/api/require-owned-bracket";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { errorResponse, withErrorHandling } from "@/lib/api/errors";
import { NOT_DRAFT_SCHEDULE_MESSAGE } from "@/lib/api/messages";
import { toWireBracket } from "@/lib/api/wire-bracket";
import { pickStringFields } from "@/lib/api/pick-string-fields";
import {
  type ScheduleRequestInput,
  validateScheduleRequest,
} from "@/app/dashboard/brackets/[id]/edit/scheduled-start";

// PATCH /brackets/{bracketId}/schedule (issue #53, docs/openapi.yaml's
// updateSchedule)
//
// Creator-only, draft-only - wraps the same lookup/persistence
// `src/app/dashboard/brackets/[id]/edit/scheduled-start-actions.ts`'s
// `updateScheduledStart` Server Action (#14) already runs:
// `prisma.bracket.findFirst({ where: { id, creatorId } })` (never `id`
// alone, per spec §4.9), and the "must be strictly in the future"/"not
// DRAFT" checks, both carried over with their exact existing messages.
//
// *** Behavior change, not a pure wrap - flagged per issue #53's own
// constraint and docs/frontend-rework-specification.md §9.4 ***
// The Server Action's `parseDatetimeLocalValue` parses an offset-less
// `datetime-local` value as the *server process's* local time - a latent
// bug once frontend and backend run as separate deployments in different
// timezones/regions. This endpoint does NOT reuse that function. Per
// openapi.yaml's `UpdateScheduleRequest.scheduledStartAt` ("must be a full
// timezone-aware ISO-8601 value") and the frontend's already-merged
// `TimingPanel` (frontend/src/routes/_authenticated/brackets.$bracketId.edit.tsx`,
// which sends `new Date(startAt).toISOString()` - a real UTC instant, not a
// naive local string), `scheduledStartAt` here is parsed directly via
// `validateScheduleRequest` -> `parseIsoDatetimeValue`
// (`scheduled-start.ts`), which just hands the raw string to `new Date(...)`
// with no local-timezone reinterpretation. See that function's doc comment
// for the full rationale.

type RouteParams = { params: Promise<{ bracketId: string }> };

/**
 * Reads `docs/openapi.yaml`'s `UpdateScheduleRequest` fields
 * (`startMode`/`scheduledStartAt`) off a parsed JSON body into the shape
 * `validateScheduleRequest` expects, via the shared `pickStringFields`
 * (`@/lib/api/pick-string-fields`, issue #79) - the same "for each known
 * field, pick it off the body" adapter shape `POST /brackets` and
 * `PATCH .../round-duration` use. A non-string/non-number value for either
 * field (missing, `null`, a boolean, ...) is simply left `undefined` here;
 * `validateScheduleRequest` itself is responsible for rejecting anything
 * that isn't the right type/shape - this is only picking the fields off,
 * never narrowing what counts as valid.
 */
function toScheduleRequestInput(body: unknown): ScheduleRequestInput {
  const picked = pickStringFields(body, [
    "startMode",
    "scheduledStartAt",
  ] as const);
  return {
    startMode: picked.startMode,
    scheduledStartAt: picked.scheduledStartAt,
  };
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
      return errorResponse(409, "NOT_DRAFT", NOT_DRAFT_SCHEDULE_MESSAGE);
    }

    // A malformed/empty JSON body falls through as `{}`, which
    // `toScheduleRequestInput`/`validateScheduleRequest` reject the same
    // way as a request that omitted every field - not a separate,
    // undocumented error shape.
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Left as `{}` - see above.
    }

    // "Future" is judged against the server's own clock at request time,
    // never anything trusted from the client - same as the Server Action.
    const validated = validateScheduleRequest(
      toScheduleRequestInput(body),
      new Date()
    );
    if (!validated.ok) {
      return errorResponse(400, "VALIDATION_ERROR", validated.error);
    }

    const updated = await prisma.bracket.update({
      where: { id: bracket.id },
      data: { scheduledStartAt: validated.data.scheduledStartAt },
    });

    // See `toWireBracket`'s own doc comment (issue #73) - this update only
    // touches scheduledStartAt, so the column is still null when
    // round-duration has never been PATCHed for this bracket.
    return NextResponse.json(toWireBracket(updated));
  })();

  return withCors(request, response);
};

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
