import { describe, expect, it, vi } from "vitest";

// Same approach as `src/app/dashboard/layout.signed-out.test.tsx`: stub
// `next/headers`'s `cookies()` with an empty, in-memory jar so the *real*
// `src/lib/supabase/server.ts` client - and therefore the real
// `supabase.auth.signOut()` call - is exercised against the disposable
// Supabase project configured in `.env.local`, with no session cookie
// present. This is the "stale tab / double submit / expired session" case
// from the acceptance criteria: there's nothing to sign out of.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: () => {},
  })),
}));

const { logout } = await import("./actions");

describe("logout action, already signed out (live Supabase)", () => {
  it("does not crash and still redirects to /login", async () => {
    let thrown: unknown;
    try {
      await logout();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/login");
  });
});
