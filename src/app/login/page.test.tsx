import { describe, expect, it, vi } from "vitest";

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

const { default: LoginPage } = await import("./page");

describe("/login page", () => {
  it("redirects a signed-in visitor to /dashboard instead of rendering the form", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });

    let thrown: unknown;
    try {
      await LoginPage();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/dashboard");
  });

  it("renders the form for a signed-out visitor", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });

    const result = await LoginPage();

    expect(result).toBeTruthy();
  });
});
