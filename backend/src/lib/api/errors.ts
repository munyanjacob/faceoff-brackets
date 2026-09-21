import { NextResponse } from "next/server";

// Shared error-response envelope for every Route Handler under the REST API
// surface (docs/openapi.yaml). Every endpoint's error responses - across all
// of issues #51-59 - must use this instead of hand-rolling JSON error
// bodies, so the wire shape is guaranteed to match the OpenAPI `Error`
// schema everywhere: `{ code: string, message: string }`.
//
// The full set of documented `code` values, cross-referenced against
// docs/openapi.yaml (component responses, per-operation response examples)
// and docs/frontend-rework-specification.md §7.3's castVote error table, is
// listed in the issue #60 comment - this module doesn't enumerate them as
// constants because individual endpoint issues (#51-59) own picking the
// right code/status/message per business rule; this module only guarantees
// the shape is correct for any (status, code, message) triple.

/** The exact JSON body shape `docs/openapi.yaml`'s `Error` schema specifies. */
export interface ApiErrorBody {
  code: string;
  message: string;
}

/**
 * Builds a JSON error `Response` matching `docs/openapi.yaml`'s `Error`
 * schema: `{ code, message }`, with the given HTTP status code.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ code, message }, { status });
}

/**
 * The generic 500 error every Route Handler falls back to for an unhandled
 * failure - see specification.md §8's "generic-500 pattern" and §10's
 * "Generic 500 message" carry-over. Never include the triggering error's
 * message or stack in the response body; that's the whole point of this
 * helper existing separately from `errorResponse`.
 */
export function unexpectedErrorResponse(): NextResponse<ApiErrorBody> {
  return errorResponse(
    500,
    "UNEXPECTED",
    "Something went wrong. Please try again."
  );
}

/** A Route Handler function, e.g. the exported `GET`/`POST`/... of a `route.ts`. */
type RouteHandler<Args extends unknown[]> = (
  ...args: Args
) => Promise<Response> | Response;

/**
 * Wraps a Route Handler so that any uncaught exception - a thrown
 * validation error some other layer forgot to catch, an unexpected DB
 * failure, anything - is logged server-side and turned into the generic
 * `UNEXPECTED` 500 response, instead of Next.js's default behavior of
 * leaking the error (message and, in dev, a stack trace) to the client.
 *
 * Every endpoint issue (#51-59) should wrap its exported HTTP method
 * function in this:
 *
 * ```ts
 * export const GET = withErrorHandling(async (request: NextRequest) => {
 *   // ... may throw ...
 *   return NextResponse.json(body);
 * });
 * ```
 *
 * This does not replace handling *expected* business errors (not found,
 * validation, rate limiting, etc.) - those should still be returned
 * directly via `errorResponse` with their own documented code/status.
 * `withErrorHandling` is only the last-resort safety net for whatever a
 * handler didn't anticipate.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: RouteHandler<Args>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error("[api] unhandled error in route handler:", error);
      return unexpectedErrorResponse();
    }
  };
}
