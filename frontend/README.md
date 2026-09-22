# Faceoff Brackets — frontend

The voter/creator-facing UI for Faceoff Brackets, built separately from and
talking to `../backend/`'s REST API (see `../docs/frontend-rework-specification.md`
and `../docs/openapi.yaml` for the contract between the two apps). See the
repo root `README.md` for the overall repo layout; this file covers
`frontend/` only.

## Stack

- [TanStack Start](https://tanstack.com/start) (Vite-based) — React 19, TypeScript
- TanStack Router + TanStack Query
- Tailwind CSS + Radix UI primitives (shadcn-style components)
- Supabase Auth (`@supabase/supabase-js`, browser client) — talks to Supabase
  directly rather than through the backend (spec §6); shares the one
  Supabase project `backend/` uses (issue #46)
- Hosted on Vercel via Nitro's `vercel` preset (issue #47; see `vite.config.ts`)

## Prerequisites

- Node.js 24 (same as `backend/`)
- No local Supabase project or `backend/` dev server is strictly required —
  see "Running against the real backend vs. the mock backend" below.

## Setup

All commands below run from inside `frontend/`.

1. **Install dependencies**

   ```
   cd frontend
   npm install
   ```

2. **Environment variables** — `frontend/.env` is already checked into this
   repo with working values for the project's one shared Supabase project
   (issue #46), so a fresh clone works out of the box. Copy
   `.env.example` to `.env.local` (which overrides `.env` and is
   git-ignored) only if you want to point at a different Supabase project
   or backend:

   ```
   cp .env.example .env.local
   ```

   The variables:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` —
     Supabase Auth config. Values are publishable/anon-safe, not secrets
     (see `../backend/README.md` for how to create a Supabase project, and
     the non-`VITE_`-prefixed `SUPABASE_*` siblings which some tooling
     also reads).
   - `VITE_API_BASE_URL` — the backend's base URL, including its `/api`
     path prefix (`backend/`'s routes live under `src/app/api/`, e.g. the
     discover endpoint is reachable at `/api/discover`, not the bare
     `/discover` `docs/openapi.yaml`'s placeholder `servers` entry shows).
     Set to `http://localhost:3000/api` for a `backend/` dev server running
     locally (`../backend/README.md` documents `npm run dev` as running at
     `http://localhost:3000`). **Leave unset** to run frontend-only against
     an in-browser mock backend instead — see below (issue #61).

3. **Start the dev server**

   ```
   npm run dev
   ```

## Running against the real backend vs. the mock backend

`frontend/src/services/transport/index.ts` picks one of two implementations
of the same `ApiTransport` interface, based on whether `VITE_API_BASE_URL`
is set:

- **Set** (the default in the checked-in `.env`): every service call goes
  to the real `backend/` REST API via `httpTransport.ts`. Requires
  `backend/`'s dev server running (`cd backend && npm run dev`) and a
  reachable Supabase project.
- **Unset**: falls back to `mockTransport.ts`, an in-browser stand-in that
  re-implements every business rule in the spec (status machines, byes,
  tie-breakers, the round-advancement sweep, the vote rate limit) against
  `localStorage`, seeded with a few demo brackets. No `backend/` dev server
  or Supabase project needed at all in this mode — useful for
  frontend-only work, demos, or offline development. Kept deliberately as
  an opt-in dev/demo fallback now that the real backend exists, not
  deleted (issue #61; see `../docs/frontend-rework-specification.md` §9.7).

Either way, Supabase Auth itself (login/signup/session) always talks to the
real Supabase project directly — `VITE_API_BASE_URL` only selects how
bracket/voting/results data is fetched.

**Known local-dev caveat when running both apps together:** the backend's
CORS allowlist (`FRONTEND_ORIGIN`) and the anonymous-voter cookie's
`Secure`/`Domain` attributes assume a real HTTPS parent-domain topology in
production (`../docs/frontend-rework-specification.md` §6); plain
`http://localhost` origins on two different ports don't satisfy that, so
anonymous voting and cross-origin requests may not fully work end-to-end
against a locally-running `backend/` without extra setup (an HTTPS loopback
proxy, or real subdomains of a shared local dev domain — see §6's own note).
This is a documented, accepted local-dev limitation, not a bug — the
mock-backend mode above sidesteps it entirely for frontend-only work.

## Other commands

Run from inside `frontend/`:

| Command | Purpose |
|---|---|
| `npm run build` | Production build, targeting Vercel's Build Output API (issue #47) |
| `npm run build:dev` | Build in development mode |
| `npm run preview` | Preview a production build locally |
| `npm run lint` | Lint the codebase |
| `npm run format` | Format with Prettier |

## Backend

`../backend/` is a separate Next.js app with its own dependencies and its
own `README.md` — see there for its setup and run steps. `frontend/` talks
to it over HTTP rather than sharing `node_modules` or config.

## Project process

Work is tracked as GitHub issues and groomed/implemented/QA'd in that order —
see `../_docs/process.md` and `../_docs/team/` for how the PM, engineer, and
QA roles operate.
