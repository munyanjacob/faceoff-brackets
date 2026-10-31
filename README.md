# Faceoff Brackets

**Timed, head-to-head voting brackets on any topic.** Creators build a
bracket of items (text, image, or both); voters pick a winner in each
matchup; the item with the most votes advances automatically when the round
ends — until one champion is left.

## Features

- **Bracket builder** — add items manually with optional image uploads; any
  number of items, with uneven brackets padded automatically using byes
- **Timed rounds** — a default round duration with per-round overrides, and
  an immediate or scheduled start
- **Automatic advancement** — a cron-driven sweep closes expired rounds,
  promotes winners, and generates the next round
- **Fair tie-breaking** — tied matchups get a short tie-breaker revote, then
  fall back to a random pick if they tie again
- **Flexible access** — public or private (link-only) brackets; the creator
  decides whether voters need an account. Anonymous voters are tracked with a
  signed cookie, so it's still one vote per voter per matchup
- **Comments** — voters can leave an optional comment with their vote
- **Live results and bracket tree** — follow the bracket round by round
  through to the winner
- **Discover page** — browse public brackets

## Architecture

```
┌──────────────────────────┐   REST (/api, OpenAPI)  ┌──────────────────────────┐
│ frontend/                │ ──────────────────────▶ │ backend/                 │
│ TanStack Start + React   │                         │ Next.js 16 route handlers│
│ TanStack Router / Query  │                         │ Prisma ORM               │
│ Tailwind + Radix UI      │                         │ Vercel cron → rounds     │
└────────────┬─────────────┘                         └────────────┬─────────────┘
             │ Supabase Auth (browser)                            │
             ▼                                                    ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ Supabase — Postgres · Auth · Storage (item images)            │
       └───────────────────────────────────────────────────────────────┘
```

- The **backend** owns the database and every business rule: the bracket
  status machine, bye placement, vote rate limiting, tie-breakers, and round
  advancement.
- The **frontend** is a separate app that talks to the backend only through
  the REST contract in [`docs/openapi.yaml`](docs/openapi.yaml). Leave
  `VITE_API_BASE_URL` unset and it runs against an in-browser **mock
  backend** that re-implements the same rules, so the UI can be developed
  without a database.
- The repo-root **`Dockerfile`** bundles both apps into one container on a
  single origin.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | React 19, TypeScript, TanStack Start / Router / Query, Tailwind CSS, Radix UI |
| Backend | Next.js 16 (App Router), TypeScript, Prisma 7 |
| Data & auth | Supabase (Postgres, Auth, Storage) |
| Testing | Vitest — unit and integration tests across both apps |
| Infra | Vercel (hosting + cron), Docker |

## How it was built

This project was an experiment in AI-assisted development. The frontend
started as a [Lovable](https://lovable.dev) prototype, which was imported
into `frontend/` with `git subtree` (its history is kept) and reworked to run
against a real backend.

Development followed a multi-agent workflow ([`_docs/process.md`](_docs/process.md)).
Every change was a GitHub issue that went through three roles, each played by
an AI agent with its own written brief in [`_docs/team/`](_docs/team/):

1. **PM** — grooms the issue into checkable acceptance criteria and edge cases
2. **Engineer** — implements it, with tests
3. **QA** — verifies the result against the acceptance criteria. On a fail,
   the issue goes back to the engineer

More than 80 issues went through this loop. The product spec
([`_docs/product/plan.md`](_docs/product/plan.md)), architecture decisions
([`_docs/product/architecture.md`](_docs/product/architecture.md)), and the
frontend/backend split spec
([`docs/frontend-rework-specification.md`](docs/frontend-rework-specification.md))
were written first and served as the source of truth for every agent.

## Repository layout

```
backend/    Next.js API, Prisma schema + migrations, round-advancement cron
frontend/   Voter/creator UI (its own README and setup)
docs/       Frontend/backend split spec and OpenAPI contract
_docs/      Product spec, architecture notes, and the agent workflow/roles
Dockerfile  Single image serving both apps
```

## Running locally

### Prerequisites

- Node.js 24
- A [Supabase](https://supabase.com) project (free tier is fine) — or none
  at all if you only want to run the frontend against its mock backend

### Frontend only (no database needed)

Add the line `VITE_API_BASE_URL=` (empty value) to `frontend/.env.local`
(git-ignored; create it if needed). This switches the app to the in-browser
mock backend. Then:

```
cd frontend
npm install
npm run dev
```

Remove that line to go back to the real backend. See
[`frontend/README.md`](frontend/README.md) for details.

### Full stack

All backend commands run from inside `backend/`.

1. **Install dependencies**

   ```
   cd backend
   npm install
   ```

2. **Create a Supabase project**, then collect:
   - Project Settings → API: the Project URL, `anon` public key, and `service_role` key
   - Project Settings → Database: the pooled "Transaction" connection string and a direct connection string

3. **Configure environment variables**: copy `backend/.env.example` to
   `backend/.env.local` and fill in the values from step 2, plus:
   - `CRON_SECRET`: any random string. Authorizes the round-advancement cron endpoint
   - `VOTE_COOKIE_SECRET`: any random string. Signs the anonymous-voter cookie (optional locally; without it the backend uses an insecure dev default and logs a console warning)
   - `FRONTEND_ORIGIN`: the frontend dev server's origin (e.g. `http://localhost:3001`), the only origin CORS allows

   ```
   cp .env.example .env.local
   ```

4. **Apply the database schema**

   ```
   npx prisma migrate dev
   ```

5. **Start the backend**: `npm run dev` (runs at http://localhost:3000)

6. **Start the frontend** in a second terminal: `cd frontend && npm install && npm run dev`.
   It uses the next free port, http://localhost:3001

### Running round advancement locally

In production, `/api/cron/advance-rounds` runs on Vercel's cron schedule
(`backend/vercel.json`). Locally, trigger it by hand with the backend running:

```
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/advance-rounds
```

Use the same value you set for `CRON_SECRET` in `backend/.env.local`.

### Backend commands

Run from inside `backend/`:

| Command | Purpose |
|---|---|
| `npm test` | Run the whole test suite (Vitest) |
| `npm run lint` | Lint the codebase |
| `npm run build` | Production build |
| `npx prisma studio` | Browse/edit database rows locally |
| `npx prisma migrate dev` | Apply schema changes to the database |

### Docker (both apps in one image)

The `Dockerfile` builds `frontend/` as a static SPA and bundles it into
`backend/`'s Next.js server. That server serves the UI on every non-`/api`
path and the REST API under `/api`, so both come from one container and one
origin. Run from the repo root:

```
docker build -t faceoff-brackets .
docker run -p 3000:3000 --env-file backend/.env.local faceoff-brackets
```

The app is then at http://localhost:3000. Runtime env vars are the same as
`backend/.env.example`'s (`NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` are required). `FRONTEND_ORIGIN` is unused
in this setup. The frontend's Supabase values are baked in at build time
from the checked-in `frontend/.env`. `VITE_API_BASE_URL` defaults to `/api`
and can be overridden with `--build-arg VITE_API_BASE_URL=...`.

The image doesn't run migrations: apply them with `npx prisma migrate
deploy` from `backend/` first. It doesn't schedule round advancement either,
so call `/api/cron/advance-rounds` from an external scheduler as described
above.
