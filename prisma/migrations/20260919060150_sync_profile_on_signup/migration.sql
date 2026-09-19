-- Sync a `public.profiles` row whenever a new Supabase Auth user is created
-- (issue #7). Supabase Auth writes new users to `auth.users`, a schema this
-- Prisma project does not manage (see #3) - `public.profiles` is kept in
-- sync via a database trigger instead of app code, so nothing can forget to
-- create it.
--
-- SECURITY DEFINER: the role that performs the `INSERT INTO auth.users`
-- (Supabase's `supabase_auth_admin`) has no privileges on the `public`
-- schema. Marking the function SECURITY DEFINER makes it run with the
-- privileges of the role that owns it (the role this migration runs as,
-- which owns `public.profiles`), so it can write cross-schema without
-- granting `supabase_auth_admin` any direct access to `public.profiles` -
-- the narrowest privilege that gets the one required insert done.
-- `SET search_path` pins name resolution to `public`/`pg_temp` for the
-- duration of the function, which is the standard hardening for
-- SECURITY DEFINER functions (prevents a search_path-based hijack even
-- though the insert below is already schema-qualified).
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- display_name is intentionally omitted (left NULL): signup only
  -- collects email/password today, so there is no name to copy yet.
  -- ON CONFLICT DO NOTHING makes this safe to re-run and a no-op if a
  -- matching profiles row already exists for this id.
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Attach the trigger only when `auth.users` actually exists. Prisma
-- validates migration history by replaying every migration file, from
-- scratch, against a throwaway "shadow" database on the same Postgres
-- server (used by `prisma migrate dev` and `prisma migrate status`), and
-- that shadow database has no `auth` schema at all - only Supabase's real
-- project database does. An unconditional `CREATE TRIGGER ... ON
-- auth.users` here would fail shadow-database creation and break
-- `migrate dev`/`migrate status` for this and every future migration. The
-- existence check below lets this migration apply cleanly both against the
-- live Supabase database (trigger gets created) and the blank shadow
-- database (block is skipped entirely).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'auth'
      AND table_name = 'users'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
    EXECUTE '
      CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_auth_user()
    ';
  END IF;
END;
$$;
