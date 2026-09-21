// CORS policy for every Route Handler under the new REST API surface
// (issue #50), per docs/frontend-rework-specification.md §6/§8: an
// explicit allowed origin (never `*` - a wildcard origin is incompatible
// with `Access-Control-Allow-Credentials: true`, and credentials are
// required here for the anonymous-voter cookie and the `Authorization`
// header to travel cross-subdomain), plus an explicit method/header
// allowlist.
//
// The frontend and backend are hosted as subdomains of one parent domain
// (spec §6, issue #48) - not genuinely cross-site - but the browser still
// enforces CORS per-origin (subdomains are different origins), so this
// still applies.

// The frontend's exact origin (spec §6). Overridable per environment
// (e.g. a staging subdomain, or a local dev origin) via FRONTEND_ORIGIN -
// docs/openapi.yaml's own `servers` entry is itself only a placeholder
// pending real hosting, so this mirrors that with the same fallback.
const DEFAULT_ALLOWED_ORIGIN = "https://app.example.com";
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN;

const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";

/**
 * Builds the CORS response headers for `request`. `Access-Control-Allow-Origin`
 * is only ever set to the one exact allowed origin, and only when the
 * request's own `Origin` header matches it - a non-matching or absent
 * `Origin` gets every other CORS header but no
 * `Access-Control-Allow-Origin`, so the browser still blocks the response
 * from being read cross-origin. `Vary: Origin` ensures any shared cache
 * doesn't serve one caller's CORS headers to a different origin.
 */
export function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    Vary: "Origin",
  });

  const origin = request.headers.get("origin");
  if (origin !== null && origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }

  return headers;
}

/**
 * Applies `corsHeaders(request)` onto an existing `response`, mutating and
 * returning it. Use this to decorate a Route Handler's normal
 * success/error response before returning it.
 */
export function withCors(request: Request, response: Response): Response {
  corsHeaders(request).forEach((value, key) => {
    response.headers.set(key, value);
  });
  return response;
}

/**
 * The response for a preflight `OPTIONS` request: 204, no body, just the
 * CORS headers - so the browser's actual request can proceed.
 */
export function preflightResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
