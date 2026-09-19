import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// `next/headers`'s `cookies()` only works inside a real Next.js request
// scope. Stub it with an in-memory jar (same approach as
// `src/lib/supabase/get-user.signed-out.test.ts`) so the *real*
// `src/lib/supabase/server.ts` client can be exercised against the real,
// disposable Supabase project configured in `.env.local`.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: () => {},
  })),
}));

const { signup } = await import("./actions");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveCredentials = Boolean(url && anonKey && serviceRoleKey);

// A disposable, throwaway test address. Not intended to receive mail - it
// only needs to look like a real address to Supabase's signup validation.
const testEmail = `signup-e2e-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2)}@example.test`;

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

// This suite hits the real Supabase Auth API configured in `.env.local` -
// it's the only practical way to verify the documented anti-enumeration
// behaviour the `signup` action depends on: signUp() for an
// already-registered, confirmed email returns success (no thrown error)
// with an empty `identities` array on an obfuscated user object, instead of
// creating a second account.
//
// The project's shared confirmation-email sender has a low, easy-to-exhaust
// rate limit (observed: `over_email_send_rate_limit` after a handful of
// calls within an hour), so this test deliberately does NOT exercise the
// "brand new email" signup path here - doing so on every `npm test` run
// would make the suite flaky and could burn the whole project's email quota
// for other engineers. That path (a fresh, unused email producing a
// confirmation message) is covered by the mocked unit tests in
// `./actions.test.ts` and was verified once by hand against this project.
//
// Setting up the "already registered" precondition via the admin API
// (`auth.admin.createUser` with `email_confirm: true`) avoids the rate
// limit entirely, because creating a pre-confirmed user this way never
// sends an email; Supabase's own anti-enumeration response for the
// subsequent duplicate `signUp()` call also does not send one.
describe.runIf(hasLiveCredentials)(
  "signup action against the live Supabase project (anti-enumeration)",
  () => {
    let existingUserId: string | undefined;
    const admin = hasLiveCredentials
      ? createSupabaseClient(url!, serviceRoleKey!)
      : undefined;

    beforeAll(async () => {
      const { data, error } = await admin!.auth.admin.createUser({
        email: testEmail,
        password: "an-existing-password-1",
        email_confirm: true,
      });
      if (error) throw error;
      existingUserId = data.user?.id;
    });

    afterAll(async () => {
      if (!existingUserId || !admin) return;
      await admin.auth.admin.deleteUser(existingUserId);
    });

    it("does not silently create a duplicate for an already-registered, confirmed email, and shows a message", async () => {
      const result = await signup(
        {},
        formData({ email: testEmail, password: "a-different-password-2" })
      );

      // Supabase's real anti-enumeration response: no error thrown.
      expect(result.error).toBeUndefined();
      // Not an unqualified "account created" claim - a distinct message.
      expect(result.message).toBeTruthy();
      expect(result.message).toMatch(/already registered/i);

      // Confirm no second account exists for this email.
      const { data, error } = await admin!.auth.admin.listUsers();
      expect(error).toBeNull();
      const matches = data?.users.filter((u) => u.email === testEmail) ?? [];
      expect(matches.length).toBe(1);
      expect(matches[0]?.id).toBe(existingUserId);
    });
  }
);
