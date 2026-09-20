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

## Lint tooling: isolated TypeScript 6 shim for `typescript-eslint` (issue #39)

`typescript-eslint` (and `eslint-config-next`, which loads it unconditionally)
is built against the classic TypeScript <6.1 Compiler API
(`ts.createProgram`, `ts.SyntaxKind`, etc). `typescript@7.0.2` - the version
pinned above - no longer exports that API at all; its `exports` map only
exposes the new `./unstable/*` native-compiler entry points. As of September
2026, no published or canary `typescript-eslint`/`eslint-config-next`
supports TS 7 (tracked upstream in
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940),
still unmerged), so with `typescript@^7.0.2` installed, `npm run lint`
couldn't even load `eslint-config-next` - not just its TypeScript-specific
rules, but the React/hooks/accessibility/Next rules too.

Two approaches were tried and rejected before landing on the fix below:

1. **npm `overrides` scoped to the lint subtree.** Doesn't work: `typescript`
   is declared exclusively as a `peerDependencies` entry throughout the
   `typescript-eslint`/`@typescript-eslint/*` family, and npm's `overrides`
   applied to a peer-only edge only rewrites the compatibility check, not
   the physical install - `require('typescript')` inside `typescript-eslint`
   still resolved to the one hoisted `typescript@7.0.2` regardless.
2. **A global npm alias swap** (`"typescript": "npm:@typescript/typescript6@^6.0.2"`,
   with the real compiler aliased to `"@typescript/native"`). This does fix
   lint, but was proven - by calling Next's own
   `getTypeScriptPackageInfo()` (`next/dist/lib/typescript/runTypeScriptCli.js`)
   after the swap - to also divert `next build`'s internal type-check onto
   TS 6.0.2 instead of the pinned 7.0.2. Rejected as a silent version
   discrepancy in the build path.

### The fix: a lint-process-only `require('typescript')` redirect

- `@typescript/typescript6` (Microsoft's own published TS-6-API
  compatibility package - real, on npm, re-exports the classic Compiler
  API) is a normal devDependency. **The `typescript` entry in
  `package.json` is untouched** - real `typescript@7.0.2` is still the only
  thing the bare `typescript` module name resolves to, everywhere, except
  inside one specific process.
- `scripts/lint-typescript-shim.cjs` is a Node `--require` preload script
  that patches `Module._resolveFilename` for the lifetime of the process
  it's loaded into. It computes the actual installed dependency closure of
  `typescript-eslint`/`@typescript-eslint/*` (walking `dependencies`/
  `peerDependencies`/`optionalDependencies` the way Node's own resolver
  would, not by guessing from directory names - this is what correctly
  catches sibling packages like `ts-api-utils`, which is hoisted to
  top-level `node_modules` with no `typescript-eslint` in its path at all)
  and redirects `require('typescript')`/`require('typescript/...')` to
  `@typescript/typescript6` **only** for calls originating from inside that
  closure. Every other `require('typescript')` call is untouched.
- The `lint` script in `package.json` loads it explicitly:
  `node --require ./scripts/lint-typescript-shim.cjs ./node_modules/eslint/bin/eslint.js .`.
  This scopes the patch to the one `eslint` process; `next build`, `tsc`,
  `npm test`, etc. never load this file and are completely unaffected.
- Verified: `npm run lint` produces genuine findings (not a crash), and a
  deliberately-introduced type-aware violation
  (`@typescript-eslint/no-unsafe-assignment`, which requires a real
  TypeScript type-checker, not just syntax parsing) was correctly flagged
  and then removed - confirming `typescript-estree`'s project service
  successfully builds a full type-checking program against the TS6 shim.

### A second issue this surfaced: a `tsc` bin-name collision

Adding `@typescript/typescript6` as a devDependency has a side effect worth
recording: it depends on `@typescript/old` (an npm alias for real
`typescript@6.x`), which is hoisted to top-level `node_modules` and
declares the *same* bin name (`tsc`) as the pinned `typescript@7.0.2`.
Empirically, right after `npm install`, npm's bin linker picked
`@typescript/old`'s `tsc` to win the shared `node_modules/.bin/tsc` shim -
silently pointing plain `npx tsc`/`tsc` at TypeScript 6.0.3 instead of the
pinned 7.0.2. (This does *not* affect `next build`'s internal type-check -
`getTypeScriptPackageInfo()` resolves the `typescript` package by module
name and reads its `bin` field from its own package.json, never touching
`node_modules/.bin` - but it does silently break direct `npx tsc` usage,
which engineers use for ad-hoc type checks.)

`scripts/fix-tsc-bin.cjs`, wired into `postinstall`
(`"postinstall": "prisma generate && node scripts/fix-tsc-bin.cjs"`), fixes
this deterministically after every `npm install`: it reads the real,
pinned `typescript` package's own `bin` field and regenerates
`node_modules/.bin/tsc{,.cmd,.ps1}` to point at it, regardless of which
package's bin happened to win npm's internal linking race. Verified via a
clean `rm -rf node_modules && npm install`: the postinstall hook ran
automatically, and `npx tsc --version` / `npx tsc --noEmit` reported and
type-checked against `7.0.2` afterward.

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
