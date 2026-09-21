import { describe, expect, it, vi, beforeEach } from "vitest";

const signUp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { signUp },
  })),
}));

const { signup } = await import("./actions");

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

describe("signup action", () => {
  beforeEach(() => {
    signUp.mockReset();
  });

  it("returns an inline error when the email is missing", async () => {
    const result = await signup({}, formData({ email: "", password: "hunter22" }));
    expect(result.error).toBeTruthy();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("returns an inline error when the password is missing", async () => {
    const result = await signup(
      {},
      formData({ email: "new@example.com", password: "" })
    );
    expect(result.error).toBeTruthy();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("shows a confirmation message for a new, unused email", async () => {
    signUp.mockResolvedValue({
      data: {
        user: {
          id: "11111111-1111-1111-1111-111111111111",
          identities: [{ id: "identity-1" }],
        },
        session: null,
      },
      error: null,
    });

    const result = await signup(
      {},
      formData({ email: "new@example.com", password: "hunter22" })
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/confirm/i);
  });

  it("does not claim an account was created for an already-registered, confirmed email", async () => {
    // Supabase's anti-enumeration behaviour: signUp() succeeds (does not
    // throw) but returns an empty `identities` array.
    signUp.mockResolvedValue({
      data: {
        user: {
          id: "22222222-2222-2222-2222-222222222222",
          identities: [],
        },
        session: null,
      },
      error: null,
    });

    const result = await signup(
      {},
      formData({ email: "already-registered@example.com", password: "hunter22" })
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();
    expect(result.message).toMatch(/already registered/i);
  });

  it("shows an inline error, not a crash, for a password the policy rejects", async () => {
    signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Password should be at least 6 characters." },
    });

    const result = await signup(
      {},
      formData({ email: "new@example.com", password: "123" })
    );

    expect(result.error).toBe("Password should be at least 6 characters.");
    expect(result.message).toBeUndefined();
  });
});
