import { describe, expect, it, vi } from "vitest";

// `next/headers`'s `cookies()` only works inside a real Next.js request
// scope. Stub it with an empty, in-memory cookie jar (same approach as
// `src/lib/supabase/get-user.signed-out.test.ts`) so the *real*
// `src/lib/supabase/server.ts` client - and therefore the real
// `supabase.auth.getUser()` call - is exercised against the disposable
// Supabase project configured in `.env.local`, with no session cookie
// present (i.e. genuinely signed out).
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: () => {},
  })),
}));

const { default: DashboardLayout } = await import("./layout");

describe("/dashboard layout, signed out (live Supabase)", () => {
  it("redirects to /login for a request with no session cookie", async () => {
    let thrown: unknown;
    try {
      await DashboardLayout({ children: <p>placeholder</p> } as Parameters<
        typeof DashboardLayout
      >[0]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/login");
  });
});
