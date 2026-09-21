import { describe, expect, it, vi } from "vitest";

// `next/headers`'s `cookies()` only works inside a real Next.js request
// scope, which Vitest doesn't provide. Stub it with an empty, in-memory
// cookie jar so `createClient()` from `./server` behaves exactly like it
// would for a request with no Supabase session cookies (i.e. signed out).
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: () => {},
  })),
}));

const { createClient } = await import("./server");

describe("supabase server client, signed out", () => {
  it("getUser() resolves with a null user and does not throw", async () => {
    const supabase = await createClient();

    // No try/catch: an unexpected throw here fails the test on its own.
    const { data, error } = await supabase.auth.getUser();

    expect(data.user).toBeNull();
    // Signed out is an expected, non-exceptional outcome: getUser() reports
    // it via the returned `error`/`data` pair rather than throwing.
    expect(error).not.toBeNull();
  });
});
