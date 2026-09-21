import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks `@supabase/supabase-js` itself (rather than `@/lib/supabase/server`
// as e.g. `src/app/dashboard/actions.test.ts` does) because `./auth.ts`
// deliberately builds its own client from that package directly - the same
// way `src/app/dashboard/brackets/[id]/edit/image-upload.ts` does for
// Storage - instead of reusing the cookie-bound `@/lib/supabase/server`
// client. This keeps the suite fast and network-free while still
// exercising `./auth.ts`'s own logic (header parsing, null/user-id
// mapping).
const getUser = vi.fn();
const createClient = vi.fn(() => ({ auth: { getUser } }));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { getAuthenticatedUserId, unauthorizedResponse } = await import(
  "./auth"
);

function requestWithAuth(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/brackets/mine", { headers });
}

describe("getAuthenticatedUserId", () => {
  beforeEach(() => {
    createClient.mockClear();
    getUser.mockReset();
  });

  it("returns the caller's user id for a valid bearer token", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const userId = await getAuthenticatedUserId(
      requestWithAuth("Bearer valid-token")
    );

    expect(userId).toBe("user-123");
    expect(getUser).toHaveBeenCalledWith("valid-token");
  });

  it("builds the Supabase client with the anon key, never the service-role key", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: "user-123" } },
      error: null,
    });

    await getAuthenticatedUserId(requestWithAuth("Bearer valid-token"));

    expect(createClient).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  });

  it("returns null and never calls Supabase when the Authorization header is absent", async () => {
    const userId = await getAuthenticatedUserId(requestWithAuth());

    expect(userId).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null and never calls Supabase when the header has no Bearer prefix", async () => {
    const userId = await getAuthenticatedUserId(
      requestWithAuth("valid-token")
    );

    expect(userId).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null for a Bearer header with no token after it", async () => {
    const userId = await getAuthenticatedUserId(requestWithAuth("Bearer "));

    expect(userId).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null (not a throw) when Supabase rejects the token", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid JWT" },
    });

    const userId = await getAuthenticatedUserId(
      requestWithAuth("Bearer garbage-or-expired-token")
    );

    expect(userId).toBeNull();
  });

  it("returns null when Supabase reports no error but also no user", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    const userId = await getAuthenticatedUserId(
      requestWithAuth("Bearer whatever-token")
    );

    expect(userId).toBeNull();
  });
});

describe("unauthorizedResponse", () => {
  it("returns 401 with the exact UNAUTHORIZED body from docs/openapi.yaml", async () => {
    const response = unauthorizedResponse();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  });
});
