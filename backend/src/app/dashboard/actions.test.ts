import { describe, expect, it, vi, beforeEach } from "vitest";

const signOut = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { signOut },
  })),
}));

const { logout } = await import("./actions");

describe("logout action", () => {
  beforeEach(() => {
    signOut.mockReset();
  });

  it("signs out and redirects to /login, outside any try/catch", async () => {
    signOut.mockResolvedValue({ error: null });

    let thrown: unknown;
    try {
      await logout();
    } catch (err) {
      thrown = err;
    }

    expect(signOut).toHaveBeenCalledOnce();
    // next/navigation's redirect() works by throwing a special error whose
    // `digest` encodes the destination; a real render pipeline turns this
    // into a navigation instead of a rendered error.
    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/login");
  });

  it("still redirects to /login without crashing when already signed out", async () => {
    // Supabase's real behaviour: signOut() with no active session does not
    // throw or return an error - it's a no-op that still resolves
    // successfully, matching a stale tab, a double submit, or an expired
    // session.
    signOut.mockResolvedValue({ error: null });

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
