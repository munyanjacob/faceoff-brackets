import { createClient } from "@supabase/supabase-js";

// Bearer-token auth verification for the new REST API surface (issue #50,
// docs/openapi.yaml, docs/frontend-rework-specification.md §6).
//
// Creator-only Route Handlers (built per-endpoint in #51-#58) receive the
// frontend's Supabase access token as a plain `Authorization: Bearer
// <token>` header - not as a request cookie - because the frontend talks
// to Supabase Auth directly and only forwards the resulting access token
// to this backend (spec §6: "the frontend talks to Supabase Auth
// directly... the backend only ever verifies a bearer token"). That means
// `@/lib/supabase/server`'s cookie-bound client (which reads a session via
// `next/headers`) isn't the right tool here: there's no cookie session to
// read, just a caller-supplied token to check. Instead this builds its own
// minimal `@supabase/supabase-js` client the same way
// `src/app/dashboard/brackets/[id]/edit/image-upload.ts` does for Storage
// uploads - except with the **anon** key, never
// `SUPABASE_SERVICE_ROLE_KEY`. `supabase.auth.getUser(token)` verifies the
// caller-supplied token directly against Supabase's API; the anon key is
// sufficient for that and doesn't grant this client any elevated access.

function createAuthClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = header.match(BEARER_PREFIX);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Resolves the authenticated caller's Supabase user id from `request`'s
 * `Authorization` header.
 *
 * Returns `null` - never throws - when the header is missing, doesn't use
 * the `Bearer` scheme, or the token doesn't verify (expired, revoked,
 * malformed, issued by a different Supabase project, etc.). Callers that
 * require a signed-in caller should treat `null` as "respond 401" -
 * `unauthorizedResponse()` below returns the exact body/status to use.
 */
export async function getAuthenticatedUserId(
  request: Request
): Promise<string | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  const supabase = createAuthClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * The 401 response for a creator-only endpoint called with no/invalid
 * bearer token. Body/status match docs/openapi.yaml's `Unauthorized`
 * response schema exactly - see its `components.responses.Unauthorized`
 * example.
 */
export function unauthorizedResponse(): Response {
  return Response.json(
    { code: "UNAUTHORIZED", message: "Sign in to continue." },
    { status: 401 }
  );
}
