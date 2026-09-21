import { describe, expect, it, vi } from "vitest";

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

const { default: Home } = await import("./page");

describe("/ (root) page", () => {
  it("redirects a signed-in visitor to /dashboard", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });

    let thrown: unknown;
    try {
      await Home();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/dashboard");
  });

  it("redirects a signed-out visitor to /discover", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });

    let thrown: unknown;
    try {
      await Home();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/discover");
  });
});
