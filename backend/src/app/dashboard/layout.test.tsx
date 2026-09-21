import { describe, expect, it, vi } from "vitest";

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

const { default: DashboardLayout } = await import("./layout");

function renderLayout() {
  return DashboardLayout({ children: <p>placeholder content</p> } as Parameters<
    typeof DashboardLayout
  >[0]);
}

describe("/dashboard layout", () => {
  it("redirects a signed-out visitor to /login instead of rendering", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });

    let thrown: unknown;
    try {
      await renderLayout();
    } catch (err) {
      thrown = err;
    }

    // next/navigation's redirect() works by throwing a special error whose
    // `digest` encodes the destination; a real render pipeline turns this
    // into a navigation instead of a rendered error.
    expect(thrown).toBeDefined();
    expect((thrown as { digest?: string }).digest).toContain("/login");
  });

  it("renders children and a Log out control for a signed-in visitor", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });

    const result = await renderLayout();

    expect(JSON.stringify(result)).toContain("placeholder content");
    expect(JSON.stringify(result)).toMatch(/Log out/);
  });
});
