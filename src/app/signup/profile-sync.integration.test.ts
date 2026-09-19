import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Verifies issue #7's `auth.users` -> `public.profiles` sync trigger
// (`prisma/migrations/20260919060150_sync_profile_on_signup`) end-to-end
// against the real, disposable Supabase project configured in
// `.env.local`, following the live-Supabase pattern already established in
// `./actions.integration.test.ts`.
//
// Reading `public.profiles` back is done with a raw `pg` client against
// `DIRECT_URL`, the same disposable-dependency pattern already established
// by `scripts/verify-supabase-env.cjs`: `pg` is deliberately *not* a project
// dependency (nothing in `package.json`/`package-lock.json` references it),
// so install it ad hoc before running this suite against live credentials:
//
//   npm install --no-save pg
//   npm test
//   npm install   (prunes pg back out; package.json/package-lock.json are
//                  never touched)
//
// Two other ways of reading `profiles` back were considered and rejected:
//   - Prisma's generated client refuses to run any query without a driver
//     adapter (e.g. `@prisma/adapter-pg`) passed to its constructor - none
//     is installed, and AGENTS.md requires asking before adding a
//     dependency.
//   - Supabase's data API (PostgREST) with the service-role key: `profiles`
//     doesn't carry the default privilege grants Supabase normally sets up
//     for tables created through its own tooling (it was created by a
//     Prisma-run migration connecting directly as the DB owner), so
//     PostgREST returns "permission denied for table profiles" for every
//     role, `service_role` included (confirmed by hand against the live
//     project).
//
// A prior pass instead shipped a `SECURITY DEFINER` Postgres function
// (`get_profile_for_verification`, migration
// `20260919134622_add_profile_lookup_for_verification`) purely to give this
// test a read path. QA proved that function was callable by the fully
// unauthenticated `anon` role (no GRANT/REVOKE was added, so Postgres's
// default EXECUTE-to-PUBLIC applies) and, being `SECURITY DEFINER`, bypassed
// RLS entirely - a real, unauthenticated way to read any user's email by
// UUID. That migration has been deleted and the function dropped from the
// live database; this test no longer depends on it. A raw `pg` client
// connecting with the same credentials `prisma migrate` itself uses
// (`DIRECT_URL`) reads `profiles` directly instead, without touching any
// production grant.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasLiveCredentials = Boolean(url && anonKey && serviceRoleKey);

// `vitest.config.ts` loads `.env.local` via Vite's `loadEnv`, which runs
// shell-style `$VAR` interpolation over every value (dotenv-expand
// semantics). This project's real `DIRECT_URL` password contains `$`
// sequences that happen to look like variable references (e.g. `$Q...`),
// so Vite's copy of `process.env.DIRECT_URL` silently mangles the password
// and any real connection with it fails Postgres auth - confirmed by hand.
// `prisma7.config.ts` sidesteps this entirely by using Node's own
// `process.loadEnvFile`, which does plain literal assignment with no
// interpolation. `process.loadEnvFile` never overwrites a key that's
// already set, so deleting Vite's (wrong) value first forces a fresh,
// correctly-parsed read straight from the file, matching exactly what
// `prisma migrate`/`prisma db execute` themselves connect with.
function readDirectUrlFromEnvFile(): string | undefined {
  delete process.env.DIRECT_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DIRECT_URL left unset, same as prisma7.config.ts.
  }
  return process.env.DIRECT_URL;
}

type ProfileRow = { id: string; email: string; display_name: string | null };

// Loaded via `createRequire` (an untyped `require`), not a static/dynamic
// `import`, so this file still type-checks cleanly with `tsc --noEmit` and
// still collects cleanly under Vitest when `pg` isn't installed - both
// `require("pg")` calls below only ever execute inside a hook/test body
// that's gated behind `hasLiveCredentials`, never at module- or
// describe-body scope, so `describe.runIf(hasLiveCredentials)` skipping the
// suite also skips ever resolving the module.
const nodeRequire = createRequire(import.meta.url);

describe.runIf(hasLiveCredentials)(
  "auth.users -> public.profiles sync trigger, against the live Supabase project",
  () => {
    const admin = hasLiveCredentials
      ? createSupabaseClient(url!, serviceRoleKey!)
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pg: any;

    // A disposable, throwaway test address - never intended to receive
    // mail. Created via the admin API with `email_confirm: true` (not
    // `signUp()`) so this suite never sends a confirmation email and can't
    // trip the project's shared email-send rate limit, same reasoning as
    // `./actions.integration.test.ts`.
    const testEmail = `profile-sync-e2e-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}@example.test`;

    let userId: string | undefined;

    beforeAll(async () => {
      const { Client } = nodeRequire("pg");
      pg = new Client({
        connectionString: readDirectUrlFromEnvFile(),
        ssl: { rejectUnauthorized: false },
      });
      await pg.connect();
    });

    afterAll(async () => {
      // The trigger only fires on `auth.users` INSERT, so deleting the
      // auth user does not cascade-delete the matching `profiles` row
      // (confirmed by hand: no FK exists from `profiles` to `auth.users`,
      // and issue #7 explicitly scopes the trigger to INSERT only). Clean
      // up both rows explicitly so this suite never leaves test data
      // behind in the one live database this project has.
      if (userId) {
        await pg.query("DELETE FROM public.profiles WHERE id = $1", [
          userId,
        ]);
        await admin!.auth.admin.deleteUser(userId);
      }
      await pg?.end();
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

      const { rows } = await pg.query(
        "SELECT id, email, display_name FROM public.profiles WHERE id = $1",
        [userId]
      );
      const profiles = rows as ProfileRow[];
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
      await pg.query("DELETE FROM public.profiles WHERE id = $1", [
        deleteCheckUserId,
      ]);
    });
  }
);
