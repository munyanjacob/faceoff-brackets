import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// A tiny in-memory stand-in for the browser's cookie jar, shared across
// every `cookies()` call in this test so it behaves like a real session
// persisting across requests: `src/lib/supabase/server.ts`'s `setAll`
// writes into it (e.g. on sign-in and sign-out), and its `getAll` is what
// the next simulated request reads back.
function createCookieJar() {
  const jar = new Map<string, string>();
  return {
    getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
    set: (
      name: string,
      value: string,
      options?: { maxAge?: number }
    ) => {
      if (value === "" || (options?.maxAge ?? 1) <= 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  };
}

const cookieJar = createCookieJar();

// `next/headers`'s `cookies()` only works inside a real Next.js request
// scope (same approach as `src/app/dashboard/layout.signed-out.test.tsx`).
// Every call here returns the *same* jar, so this exercises the real
// `src/lib/supabase/server.ts` client - and the real `logout` action -
// against the disposable Supabase project configured in `.env.local`,
// carrying a session across simulated requests the way a browser's cookies
// would.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieJar),
}));

const { createClient } = await import("@/lib/supabase/server");
const { logout } = await import("./actions");

// vitest.config.ts (issue #38) only injects NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY into every test's process.env now, not the
// rest of .env.local. This suite additionally needs the service-role key
// for its admin client, so read that one value directly out of the file -
// a plain literal read (not Vite's `loadEnv`, and not `process.loadEnvFile`
// either, since that would pull every other key in .env.local into
// process.env as a side effect, which is exactly what issue #38 set out to
// stop).
function readServiceRoleKeyFromEnvFile(): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with the var left unset.
    return undefined;
  }
  return contents.match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/m)?.[1]?.trim();
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = readServiceRoleKeyFromEnvFile();

const hasLiveCredentials = Boolean(url && anonKey && serviceRoleKey);

const testEmail = `logout-e2e-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2)}@example.test`;
const testPassword = "a-real-looking-password-1";

// This suite hits the real Supabase Auth API configured in `.env.local` -
// it's the only practical way to verify that `logout` (the Server Action
// backing the dashboard's "Log out" control) actually clears the session
// cookie rather than merely calling `signOut()` and hoping. It exercises
// the acceptance criterion "After a signed-in user clicks Log out, the
// session cookie is cleared and a subsequent request to /dashboard
// redirects to /login instead of rendering" end-to-end at the
// Supabase-client layer (the layout's own redirect behaviour for a null
// user is covered separately in `layout.test.tsx` and
// `layout.signed-out.test.tsx`).
describe.runIf(hasLiveCredentials)(
  "logout action against the live Supabase project",
  () => {
    let userId: string | undefined;
    const admin = hasLiveCredentials
      ? createSupabaseClient(url!, serviceRoleKey!)
      : undefined;

    beforeAll(async () => {
      const { data, error } = await admin!.auth.admin.createUser({
        email: testEmail,
        password: testPassword,
        email_confirm: true,
      });
      if (error) throw error;
      userId = data.user?.id;
    });

    afterAll(async () => {
      if (!userId || !admin) return;
      await admin.auth.admin.deleteUser(userId);
    });

    it("clears the session cookie so a subsequent request sees no user", async () => {
      // Sign in "as the browser" - this is what `src/app/login/actions.ts`
      // does, and it writes the session into `cookieJar` via `setAll`.
      const signInClient = await createClient();
      const { error: signInError } =
        await signInClient.auth.signInWithPassword({
          email: testEmail,
          password: testPassword,
        });
      expect(signInError).toBeNull();

      // A fresh request (fresh client, same jar) sees the signed-in user -
      // this is what the dashboard layout's guard checks.
      const beforeLogout = await createClient();
      const { data: beforeData } = await beforeLogout.auth.getUser();
      expect(beforeData.user).not.toBeNull();
      expect(beforeData.user?.email).toBe(testEmail);

      // Trigger the real logout Server Action. It signs out (clearing the
      // cookie via `setAll`) and then redirects - `redirect()` works by
      // throwing, so that's expected here rather than a crash.
      let thrown: unknown;
      try {
        await logout();
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { digest?: string } | undefined)?.digest).toContain(
        "/login"
      );

      // A subsequent "request" (fresh client, same jar) no longer carries a
      // usable session - the cookie was actually cleared, not just ignored.
      const afterLogout = await createClient();
      const { data: afterData, error: afterError } =
        await afterLogout.auth.getUser();
      expect(afterData.user).toBeNull();
      expect(afterError).not.toBeNull();
    });
  }
);
