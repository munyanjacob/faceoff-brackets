# Faceoff Brackets

A web app for creating timed, head-to-head voting brackets on arbitrary
topics. Creators add items (text, image, or both); voters pick a winner in
each matchup, optionally leaving a comment; the item with the most votes
advances each round automatically. Tied matchups get a short tie-breaker
revote, then fall back to a random pick if it ties again.

See `_docs/outdated/plan.md` for full product scope and `_docs/outdated/architecture.md`
for the stack/data-model rationale (despite the folder name, these remain the
source of truth referenced by `AGENTS.md` — the "outdated" label refers to the
docs restructure, not their content).

## Layout

This repo is split into two apps plus a shared docs folder:

- **`backend/`** — the Next.js app: the REST/server-action API, Prisma
  schema, and round-advancement cron job. Owns the database.
- **`frontend/`** — the voter/creator-facing UI, built separately and
  talking to `backend/` (see `docs/frontend-rework-specification.md` and
  `docs/openapi.yaml` for the contract between the two). Has its own
  `README.md` with its own setup steps.
- **`docs/`** — the backend/frontend split spec and API contract, shared
  by both apps.

The rest of this README covers `backend/` only; see `frontend/README.md`
for the frontend.

## Stack (backend)

- Next.js 16 (TypeScript, App Router) — single full-stack app
- Postgres, hosted on Supabase
- Prisma ORM
- Supabase Auth (email/password) for accounts
- Tailwind CSS
- Vitest for tests

## Prerequisites

- Node.js 24
- A [Supabase](https://supabase.com) project (free tier is fine)

## Setup (backend)

All commands below run from inside `backend/`.

1. **Install dependencies**

   ```
   cd backend
   npm install
   ```

2. **Create a Supabase project**, then collect:
   - Project Settings → API: the Project URL, `anon` public key, and `service_role` key
   - Project Settings → Database: the pooled "Transaction" connection string and a direct connection string

3. **Configure environment variables** — copy `backend/.env.example` to `backend/.env.local` and fill in the values from step 2, plus:
   - `CRON_SECRET` — any random string, authorizes the round-advancement cron endpoint
   - `VOTE_COOKIE_SECRET` — any random string, signs the anonymous-voter cookie (optional locally; falls back to an insecure dev default with a console warning if unset)

   ```
   cp .env.example .env.local
   ```

4. **Apply the database schema**

   ```
   npx prisma migrate dev
   ```

5. **Start the dev server**

   ```
   npm run dev
   ```

   The app runs at http://localhost:3000.

## Running round advancement locally

In production, `/api/cron/advance-rounds` runs on Vercel's cron schedule
(`backend/vercel.json`, once daily on the Hobby plan). Locally, trigger it
by hand with the dev server running (from `backend/`):

```
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/advance-rounds
```

Use the same value you set for `CRON_SECRET` in `backend/.env.local`.

## Other commands (backend)

Run from inside `backend/`:

| Command | Purpose |
|---|---|
| `npm test` | Run the whole test suite (Vitest) |
| `npm run lint` | Lint the codebase |
| `npm run build` | Production build |
| `npx prisma studio` | Browse/edit database rows locally |
| `npx prisma migrate dev` | Apply schema changes to the database |

## Frontend

`frontend/` is a separate app with its own dependencies and its own
`README.md` — see there for its setup and run steps. It talks to
`backend/`'s API rather than sharing its `node_modules` or config.

## Project process

Work is tracked as GitHub issues and groomed/implemented/QA'd in that order —
see `_docs/process.md` and `_docs/team/` for how the PM, engineer, and QA
roles operate.
