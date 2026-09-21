import { describe, expect, it, vi, beforeEach } from "vitest";

const signInWithPassword = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { signInWithPassword },
  })),
}));

const { login } = await import("./actions");

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

describe("login action", () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
  });

  it("returns an inline error when a field is empty, without calling Supabase", async () => {
    const result = await login({}, formData({ email: "", password: "hunter22" }));
    expect(result.error).toBeTruthy();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("shows a generic inline error for an incorrect password, not the raw Supabase text", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    });

    const result = await login(
      {},
      formData({ email: "user@example.com", password: "wrong-password" })
    );

    expect(result.error).toBe("Incorrect email or password.");
    expect(result.error).not.toMatch(/Invalid login credentials/);
  });

  it("shows the same generic inline error for an unknown email", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    });

    const result = await login(
      {},
      formData({ email: "unknown@example.com", password: "hunter22" })
    );

    expect(result.error).toBe("Incorrect email or password.");
  });

  it("redirects to /dashboard on success, outside any try/catch", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1" }, session: { access_token: "t" } },
      error: null,
    });

    let thrown: unknown;
    try {
      await login({}, formData({ email: "user@example.com", password: "correct" }));
    } catch (err) {
      thrown = err;
    }

    // next/navigation's redirect() works by throwing a special error whose
    // `digest` encodes the destination; a real render pipeline turns this
    // into a navigation instead of a rendered error.
    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/dashboard");
  });
});
