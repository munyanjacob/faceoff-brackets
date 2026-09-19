import { readFileSync } from "node:fs";
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
// vitest.config.ts (issue #38) only injects NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY into every test's process.env now, not the
// rest of .env.local. This suite needs two more values that only it uses -
// SUPABASE_SERVICE_ROLE_KEY for the admin client below, and DIRECT_URL for
// the raw `pg` client - so read them straight out of the file instead of
// relying on global injection.
//
// This is a plain literal read (a regex capture over the file's contents),
// not Vite's `loadEnv` and not `process.loadEnvFile` either. Both matter,
// for different reasons:
//   - `loadEnv` runs shell-style `$VAR` interpolation over every value
//     (dotenv-expand semantics), and this project's real `DIRECT_URL`
//     password contains `$` sequences that happen to look like variable
//     references (e.g. `$Q...`), so Vite's copy silently mangled the
//     password and any real connection with it failed Postgres auth -
//     confirmed by hand. `prisma7.config.ts` sidesteps this with Node's own
//     `process.loadEnvFile`, which does plain literal assignment with no
//     interpolation, matching exactly what `prisma migrate`/`prisma db
//     execute` themselves connect with.
//   - `process.loadEnvFile` reads the *whole* file into `process.env`
//     (skipping only keys already set), so using it here would pull
//     CRON_SECRET and DATABASE_URL into process.env as a side effect even
//     though this suite never uses them - exactly the blanket-injection
//     issue #38 set out to stop, just relocated to this file. A targeted
//     regex avoids that: only the one named key is ever read.
function readEnvVarFromLocalFile(name: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with the var left unset, same as process.loadEnvFile would.
    return undefined;
  }
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim();
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = readEnvVarFromLocalFile("SUPABASE_SERVICE_ROLE_KEY");

const hasLiveCredentials = Boolean(url && anonKey && serviceRoleKey);

type ProfileRow = { id: string; email: string; display_name: string | null };

// Loaded via `createRequire` (an untyped `require`), not a static/dynamic
// `import`, so this file still type-checks cleanly with `tsc --noEmit`
// whether or not `pg` is installed - the return type is kept as `any`
// rather than `typeof import("pg")` so tsc never needs to resolve `pg`'s
// types either.
//
// `pg` is only ever installed transiently (`npm install --no-save pg`, see
// the file-level comment above) for someone running this suite by hand
// against live credentials - it is deliberately absent in CI and on a
// fresh checkout. Resolving it eagerly here, wrapped in try/catch, lets
// collection succeed either way and lets both gates below (live
// credentials, `pg` installed) be checked independently instead of letting
// a missing module crash `beforeAll` when credentials happen to be
// configured but `pg` isn't installed.
const nodeRequire = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPg(): any {
  try {
    return nodeRequire("pg");
  } catch {
    return undefined;
  }
}

const pgModule = loadPg();
const pgAvailable = pgModule !== undefined;

describe.runIf(hasLiveCredentials && pgAvailable)(
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
      const { Client } = pgModule;
      pg = new Client({
        connectionString: readEnvVarFromLocalFile("DIRECT_URL"),
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

// Live credentials are configured but `pg` isn't installed - the suite
// above can't run. Register a clearly-explained skipped test (instead of
// silently doing nothing, which is what `describe.runIf(hasLiveCredentials
// && pgAvailable)` above does on its own) so a run of `npm test` explains
// why this file's live coverage didn't execute, rather than looking like it
// was never gated on `pg` at all.
//
// A plain `if`, not `describe.runIf`, gates this: `describe.runIf`'s
// factory callback runs unconditionally to register structure (only the
// `it`/hooks inside are actually skipped when the condition is false), so
// a `console.warn` placed directly in that callback would fire on every
// run of this file - including when `pg` is installed - rather than only
// when the note is actually relevant.
if (hasLiveCredentials && !pgAvailable) {
  describe(
    "auth.users -> public.profiles sync trigger, against the live Supabase project",
    () => {
      console.warn(
        "[profile-sync.integration.test] Skipping: live Supabase credentials are configured, but the `pg` package isn't installed. Run `npm install --no-save pg` and re-run `npm test` to execute this suite locally."
      );

      it.skip("requires the `pg` package - run `npm install --no-save pg` to run this test locally", () => {});
    }
  );
}
