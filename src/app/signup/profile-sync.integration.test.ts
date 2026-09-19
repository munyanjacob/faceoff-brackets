import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Verifies issue #7's `auth.users` -> `public.profiles` sync trigger
// (`prisma/migrations/20260919060150_sync_profile_on_signup`) end-to-end
// against the real, disposable Supabase project configured in
// `.env.local`, following the live-Supabase pattern already established in
// `./actions.integration.test.ts`.
//
// Reading `public.profiles` back is deliberately *not* done through
// Prisma or through Supabase's data API (PostgREST) with the service-role
// key - both are unavailable here:
//
//   - Prisma 7's generated client refuses to run any query without a
//     driver adapter (e.g. `@prisma/adapter-pg`) passed to its
//     constructor. None is installed, and AGENTS.md requires asking
//     before adding a dependency.
//   - `public.profiles` was created by a Prisma-run migration connected
//     directly as the database owner, so it doesn't carry the default
//     privilege grants Supabase normally sets up for tables created
//     through its own tooling - PostgREST returns "permission denied for
//     table profiles" for every role, `service_role` included (confirmed
//     by hand against the live project).
//
// Instead this uses `public.get_profile_for_verification()`
// (`prisma/migrations/20260919134622_add_profile_lookup_for_verification`),
// a narrow, read-only, SECURITY DEFINER function added specifically to
// give this test (and no one else, since it's the only caller) a way to
// read a profile row by id without granting broader table access. See
// that migration's comment and the #7 issue comment for the full
// rationale, including why a plain `GRANT SELECT ... TO service_role` was
// not used instead.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveCredentials = Boolean(url && anonKey && serviceRoleKey);

type ProfileRow = { id: string; email: string; display_name: string | null };

/**
 * Runs a SQL script against the real database via `prisma db execute`,
 * using the same direct (non-pooled) connection Prisma Migrate itself
 * uses. This is only used here for test cleanup (deleting the one
 * `profiles` row this suite creates) - something no currently-granted
 * Supabase API role can do, for the same reason described above.
 *
 * `DIRECT_URL`/`DATABASE_URL` are deliberately stripped from the child's
 * environment before spawning: Vitest's own env loading
 * (`vitest.config.ts`) already populates `process.env` in this worker,
 * but `prisma7.config.ts` calls `process.loadEnvFile(".env.local")` to
 * resolve these itself, and Node's `loadEnvFile` does not override
 * variables that are already set. Left in place, the child process would
 * silently inherit Vitest's copy instead of loading its own, and Vitest's
 * `loadEnv` does not parse `.env.local` byte-for-byte identically to
 * `process.loadEnvFile` - close enough to look right, different enough to
 * fail Postgres auth (observed directly while building this test).
 * Stripping them forces the child to load its own, known-good copy the
 * same way running `npx prisma db execute` from a shell does.
 */
async function dbExecute(
  sql: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  delete childEnv.DIRECT_URL;
  delete childEnv.DATABASE_URL;

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["node_modules/prisma/build/index.js", "db", "execute", "--stdin"],
      { cwd: process.cwd(), env: childEnv }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.stdin?.write(sql);
    child.stdin?.end();
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe.runIf(hasLiveCredentials)(
  "auth.users -> public.profiles sync trigger, against the live Supabase project",
  () => {
    const admin = hasLiveCredentials
      ? createSupabaseClient(url!, serviceRoleKey!)
      : undefined;

    // A disposable, throwaway test address - never intended to receive
    // mail. Created via the admin API with `email_confirm: true` (not
    // `signUp()`) so this suite never sends a confirmation email and can't
    // trip the project's shared email-send rate limit, same reasoning as
    // `./actions.integration.test.ts`.
    const testEmail = `profile-sync-e2e-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.test`;

    let userId: string | undefined;

    afterAll(async () => {
      if (!admin) return;
      // The trigger only fires on `auth.users` INSERT, so deleting the
      // auth user does not cascade-delete the matching `profiles` row
      // (confirmed by hand: no FK exists from `profiles` to `auth.users`,
      // and issue #7 explicitly scopes the trigger to INSERT only). Clean
      // up both rows explicitly so this suite never leaves test data
      // behind in the one live database this project has.
      if (userId) {
        await dbExecute(
          `DELETE FROM public.profiles WHERE id = '${userId}';`
        );
      }
      if (userId) {
        await admin.auth.admin.deleteUser(userId);
      }
    });

    it("creates exactly one matching profiles row, with display_name left NULL", async () => {
      const { data, error } = await admin!.auth.admin.createUser({
        email: testEmail,
        password: "a-real-looking-password-1",
        email_confirm: true,
      });
      expect(error).toBeNull();
      userId = data.user?.id;
      expect(userId).toBeTruthy();

      const { data: rows, error: rpcError } = await admin!.rpc(
        "get_profile_for_verification",
        { lookup_id: userId }
      );
      expect(rpcError).toBeNull();

      const profiles = (rows ?? []) as ProfileRow[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0].id).toBe(userId);
      expect(profiles[0].email).toBe(testEmail);
      expect(profiles[0].display_name).toBeNull();
    });

    it("deleting the auth user directly does not throw (trigger is INSERT-only)", async () => {
      // Not a supported flow per issue #7 ("no cascade or cleanup behavior
      // needs to be implemented for it") - this only confirms the trigger
      // itself doesn't error on an unrelated `auth.users` write, since it
      // only fires `AFTER INSERT`.
      const { data, error } = await admin!.auth.admin.createUser({
        email: `profile-sync-delete-check-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
        password: "a-real-looking-password-1",
        email_confirm: true,
      });
      expect(error).toBeNull();
      const deleteCheckUserId = data.user!.id;

      const { error: deleteError } = await admin!.auth.admin.deleteUser(
        deleteCheckUserId
      );
      expect(deleteError).toBeNull();

      // The orphaned `profiles` row this created is real test data too -
      // clean it up the same way.
      await dbExecute(
        `DELETE FROM public.profiles WHERE id = '${deleteCheckUserId}';`
      );
    });
  }
);
