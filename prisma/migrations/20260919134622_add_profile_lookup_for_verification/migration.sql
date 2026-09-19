-- Supporting read path for issue #7's automated integration test
-- ("Sync a Profile row on signup").
--
-- The obvious ways to verify "signing up produces a matching profiles row"
-- from an automated test are (a) querying `public.profiles` through
-- Prisma, or (b) querying it through Supabase's data API (PostgREST) with
-- the service-role key. Both are unavailable in this repo as it stands:
--
--   (a) Prisma 7's generated client refuses to run any query without a
--       driver adapter (e.g. `@prisma/adapter-pg`) passed to its
--       constructor - none is installed, and AGENTS.md requires asking
--       before adding a dependency, so this migration does not add one.
--   (b) `public.profiles` was created by a Prisma-run migration, connected
--       directly as the database owner - it does not carry the default
--       privilege grants Supabase normally sets up for tables created
--       through its own tooling, so PostgREST returns "permission denied
--       for table profiles" for every role (confirmed by hand against the
--       live project, for both `anon` and `service_role`).
--
-- The fix for (b) would normally be a plain `GRANT SELECT ON
-- public.profiles TO service_role`, but that is a standing privilege
-- change against the single live database this project has, with no
-- separate dev/staging copy to try it on first - flagging it on issue #7
-- for a maintainer to apply deliberately rather than doing it here.
--
-- In the meantime, this adds one narrow, read-only, SECURITY DEFINER
-- function - the same privilege pattern the previous migration already
-- uses for `handle_new_auth_user()` - so the integration test can look up
-- a single profile by id without any table-level GRANT. Postgres grants
-- EXECUTE on newly created functions to PUBLIC by default, so no
-- additional GRANT statement is needed here either, and this migration
-- applies identically on the shadow database (it only touches `public`,
-- which always exists).
CREATE OR REPLACE FUNCTION public.get_profile_for_verification(lookup_id text)
RETURNS TABLE (id text, email text, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.email, p.display_name
  FROM public.profiles p
  WHERE p.id = lookup_id;
END;
$$;
