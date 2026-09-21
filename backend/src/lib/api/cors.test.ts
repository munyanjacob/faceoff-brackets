import { describe, expect, it } from "vitest";
import { corsHeaders, preflightResponse, withCors } from "./cors";

// Mirrors ./cors.ts's own fallback so this suite works whether or not
// FRONTEND_ORIGIN is set in the environment running the tests.
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFromOrigin(origin?: string) {
  const headers = new Headers();
  if (origin !== undefined) {
    headers.set("origin", origin);
  }
  return new Request("http://localhost/brackets/mine", { headers });
}

describe("corsHeaders", () => {
  it("allows the frontend's exact origin, per spec §6", () => {
    const headers = corsHeaders(requestFromOrigin(ALLOWED_ORIGIN));

    expect(headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
    expect(headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type"
    );
  });

  it("never allows a wildcard origin", () => {
    const headers = corsHeaders(requestFromOrigin(ALLOWED_ORIGIN));

    expect(headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("omits Access-Control-Allow-Origin for a non-matching origin", () => {
    const headers = corsHeaders(requestFromOrigin("https://evil.example.com"));

    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    // The rest of the CORS policy is still applied - only the origin
    // allowance is conditional.
    expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
    expect(headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type"
    );
  });

  it("omits Access-Control-Allow-Origin when the request has no Origin header", () => {
    const headers = corsHeaders(requestFromOrigin());

    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sets Vary: Origin so a shared cache doesn't leak headers across origins", () => {
    const headers = corsHeaders(requestFromOrigin(ALLOWED_ORIGIN));

    expect(headers.get("Vary")).toBe("Origin");
  });
});

describe("withCors", () => {
  it("applies CORS headers onto an existing response for the allowed origin", async () => {
    const response = withCors(
      requestFromOrigin(ALLOWED_ORIGIN),
      Response.json({ ok: true })
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("applies CORS headers without Access-Control-Allow-Origin for a non-matching origin", () => {
    const response = withCors(
      requestFromOrigin("https://evil.example.com"),
      Response.json({ ok: true })
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true"
    );
  });
});

describe("preflightResponse", () => {
  it("returns 204 with CORS headers and no body for the allowed origin", async () => {
    const response = preflightResponse(requestFromOrigin(ALLOWED_ORIGIN));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(await response.text()).toBe("");
  });

  it("returns 204 without Access-Control-Allow-Origin for a non-matching origin", async () => {
    const response = preflightResponse(
      requestFromOrigin("https://evil.example.com")
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
