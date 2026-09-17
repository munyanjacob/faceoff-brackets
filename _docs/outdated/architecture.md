# Architecture — Bracket Polling App

## Stack decision

Chosen from the options evaluated for `_docs/plan.md`:

- **Runtime**: Node.js 24 (current LTS line; Node 26 doesn't reach LTS until October 2026)
- **Framework**: Next.js 16.3.5 (TypeScript, App Router), single full-stack app
- **Language**: TypeScript 7.0.2
- **Styling**: Tailwind CSS 4.3.3
- **Database**: Postgres 17, hosted on Supabase (17 is the platform default for new projects)
- **ORM**: Prisma 7.9.0 — Prisma 8 exists only as a release candidate (`8.0.0-rc.x`) as of September 2026; stick with the 7.x stable line until 8 reaches GA, then revisit
- **Auth**: Supabase Auth (email/password) via `@supabase/supabase-js` 2.116.0 and `@supabase/ssr` 0.12.5 — not a separate Auth.js/Prisma-managed user table
- **Validation**: Zod 4.6.5
- **Storage**: Supabase Storage, for bracket item images
- **Background processing**: a scheduled cron job (not lazy/on-read evaluation) drives round expiration and automatic advancement
- **Hosting**: Vercel (app) + Supabase (DB/auth/storage)

Versions above reflect latest-stable as of September 2026 (verified via web search); re-check before scaffolding if this doc is acted on much later.

## Why these choices

- Managed auth/DB/storage minimizes infrastructure to stand up and maintain, and keeps the whole app in one language (TypeScript).
- A real scheduled job gives round advancement precise, traffic-independent timing, at the cost of one extra scheduled component to build and debug (see caveat below).
- Postgres/Prisma fits the inherently relational, transactional data model (brackets → rounds → matchups → votes) better than a document store.

## Manual prerequisite (one-time, human action)

Before implementation can be verified end-to-end, a Supabase project must exist:
1. Create a free project at supabase.com.
2. From Project Settings → API: copy the Project URL, `anon` public key, and `service_role` key.
3. From Project Settings → Database: copy the connection string for Prisma's `DATABASE_URL` (pooled "Transaction" string) plus a `directUrl` for migrations.

These become environment variables (see below); real values live in `.env.local` (gitignored), never committed.

## Phase 1: Foundation

Scoped from `_docs/plan.md` §21's "Recommended Development Order" — project setup, database, authentication, user model. Everything later (bracket creation, bracket engine, voting, timing, results) builds on this. Later phases get their own architecture notes/plans once this lands.

**In scope**: repo/tooling setup, full Prisma schema for the data model (defined up front so later phases don't need schema churn), Supabase Auth wiring (sign up/log in/log out, session middleware, protected routes), a `Profile` table synced to Supabase's `auth.users`, a stub creator dashboard route, and scaffolding (route + config) for the round-advancement cron job with a no-op implementation for now.

**Out of scope for Phase 1**: bracket creation form, bracket generation/byes, matchup UI, voting, comments, tie-breaker logic, real cron advancement logic, discovery page, polish.

### Steps

1. **Scaffold the app** — `create-next-app` (TypeScript, App Router, Tailwind CSS, ESLint, `src/` directory). `git init` + initial commit.

2. **Dependencies** (pinned to latest-stable as of September 2026 — confirm current versions at scaffold time):
   - `next@16.3.5`, `typescript@7.0.2`, `tailwindcss@4.3.3`
   - `prisma@7.9.0`, `@prisma/client@7.9.0`
   - `@supabase/supabase-js@2.116.0`, `@supabase/ssr@0.12.5`
   - `zod@4.6.5`

3. **Env vars** — `.env.example` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`.

4. **Prisma schema** (`prisma/schema.prisma`) — full data model up front, based on plan.md §17, refined with enums:
   - `Profile` (id = Supabase auth user id, email, display_name, created_at) — no password field; Supabase owns credentials.
   - `Bracket` (id, creator_id → Profile, title, description, visibility enum [PUBLIC, PRIVATE], voting_requirement enum [ACCOUNT_REQUIRED, ANONYMOUS_ALLOWED], default_round_duration_minutes, scheduled_start_at, status enum [DRAFT, SCHEDULED, ACTIVE, COMPLETED], created_at, published_at)
   - `BracketItem` (id, bracket_id, title, description, image_url, seed/order, created_at)
   - `Round` (id, bracket_id, round_number, duration_minutes, starts_at, ends_at, status enum [PENDING, ACTIVE, TIE_BREAKER, COMPLETED])
   - `Matchup` (id, round_id, item_a_id, item_b_id nullable for byes, winner_item_id nullable, status enum [PENDING, ACTIVE, TIE_BREAKER, COMPLETED])
   - `Vote` (id, matchup_id, item_id, user_id nullable, anonymous_voter_identifier nullable, comment nullable, created_at) with a unique constraint per (matchup_id, user_id) and per (matchup_id, anonymous_voter_identifier) to enforce one-vote-per-voter at the DB level.
   - Applied via `prisma migrate dev` against the Supabase Postgres connection.

5. **Supabase client helpers** (`src/lib/supabase/`) — `client.ts` (browser client), `server.ts` (server component/server action client via `@supabase/ssr`), a middleware helper for session refresh, wired into `src/middleware.ts`.

6. **Profile sync** — a Postgres trigger (raw SQL, documented in a `supabase/` folder or a Prisma migration) inserts a `Profile` row whenever a new `auth.users` row is created, so app code never has to remember to do it.

7. **Auth pages/flows** — `/login`, `/signup` (email/password, Supabase Auth, Server Actions), a logout action, and `src/app/(dashboard)/layout.tsx` protected via session check, redirecting unauthenticated users to `/login`.

8. **Dashboard stub** — `/dashboard` listing the current user's brackets (empty state, per plan.md §16's fields: title, status, current round, creation date).

9. **Cron scaffolding** — `src/app/api/cron/advance-rounds/route.ts`: validates a `CRON_SECRET` bearer header, no-op for now (real advancement logic lands with the Bracket Engine / Timing phases). `vercel.json` with a cron entry calling this route on a schedule.
   - **Caveat**: Vercel's Hobby plan only allows daily cron granularity; per-minute schedules need Vercel Pro, or an external pinger (e.g. cron-job.org) hitting the same secret-protected route as a fallback. No action needed until the Timing phase — flagged here so it isn't a surprise later.

10. **Housekeeping** — `.gitignore` (`.env.local`, `node_modules`, `.next`), a short `README.md` with setup steps (env vars, `prisma migrate dev`, `npm run dev`).

### Verification

- `npm run dev` boots without errors; `/` loads.
- Sign up a test user at `/signup` → confirm a matching row appears in `Profile` (Prisma Studio or Supabase Table Editor) — validates the auth-trigger sync.
- Signed out, `/dashboard` redirects to `/login`; signed in, it loads (empty state).
- `npx prisma migrate status` shows the schema applied cleanly against the Supabase DB.
- Hit `/api/cron/advance-rounds` with and without the correct `CRON_SECRET` header — confirm 401 vs 200.
