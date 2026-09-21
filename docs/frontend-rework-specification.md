# Bracket Polling App — Backend/Frontend Split & Frontend Rework Specification

**Status:** Draft specification, not yet implemented.
**Audience:** A frontend-development agent (human or AI) redesigning the UI, and whoever implements the `backend/` extraction this spec assumes.
**Companion file:** [`openapi.yaml`](./openapi.yaml) in this same folder — the machine-readable API contract this document describes in prose. The two must be kept in sync; `openapi.yaml` is the source of truth for exact request/response shapes, this document is the source of truth for *why* and for the business rules that don't fit in a schema.

This document reverse-engineers the current single Next.js app (server actions + server-rendered pages) into:

1. A **`backend/`** service: the REST API in `openapi.yaml`, owning Prisma/Postgres, Supabase Storage (service-role), the round-advancement cron job, and all business-rule enforcement.
2. A **`frontend/`** app: a new UI, free to be redesigned from scratch, that talks to the backend exclusively through a **services layer** (one module per resource area, cataloged in §7) plus Supabase Auth directly (see §6 for why).
3. A **`docs/`** folder (this file + `openapi.yaml`), the shared contract both sides build against.

Nothing in `src/` has been changed to produce this document — it is pure analysis of the app as it exists today (commit `ee960e0` and earlier), read file-by-file. Where the current implementation has a quirk or an ambiguity that the split forces a decision on, it's called out explicitly in **§9 Decisions & Open Questions** rather than silently resolved.

---

## 1. What this application does (product summary)

A timed, head-to-head bracket/tournament voting app. A signed-in creator builds a bracket from manually-entered items (title + optional description + optional image), configures visibility, voting-account requirements, round durations, and start timing, then publishes it. Voters (who may or may not need an account, per the creator's choice) vote on one item per matchup, optionally with a comment. Rounds close automatically on a timer; winners advance; ties trigger a short revote, then a random tie-break; the bracket ends with a single champion. Full product rules: `_docs/outdated/plan.md` (moved from the path AGENTS.md references — read it there).

The current UI is the unmodified `create-next-app` scaffold plus minimal unstyled server-rendered forms — there is no design system to preserve. The frontend agent has full visual/UX latitude; what must be preserved is the **behavior**: every validation rule, error message, state transition, and timing rule cataloged below.

---

## 2. Current architecture (what's being split apart)

Single Next.js 16 (App Router) app, `src/app/`. Every mutation is a Server Action (`"use server"` files); every read is a Server Component doing a direct `prisma` query at render time — there is no existing REST/JSON API. Auth is Supabase Auth via `@supabase/ssr`, session carried in cookies, refreshed on every request by `src/proxy.ts`. Anonymous (no-account) voting is identified by an HMAC-signed, httpOnly cookie (`voter_id`) minted by the vote action itself. Images upload to Supabase Storage using the **service-role key** from server-only code — ownership is enforced entirely at the application layer (Prisma bypasses Postgres RLS; the Storage bucket has no anon/authenticated insert policy).

Stack (pinned in `_docs/outdated/architecture.md`, not to be changed without asking, per `AGENTS.md`):
- Next.js 16.3.5, TypeScript 7.0.2, React 19.2.8
- Prisma 7.10.0 + `@prisma/adapter-pg` against Postgres 17 (Supabase-hosted)
- Supabase Auth (`@supabase/supabase-js` 2.116.0, `@supabase/ssr` 0.12.7) + Supabase Storage
- No validation library is actually installed despite `architecture.md` mentioning Zod — all validation in the current code is hand-rolled (`validation.ts` files per feature).
- Tailwind CSS 4.3.3 (present, essentially unused beyond scaffold defaults)

This spec does not require abandoning this stack for the backend — `backend/` can simply be "the same Next.js app, minus the pages, plus Route Handlers instead of Server Actions." That is the path of least resistance and is what §8 assumes. The frontend is free to be a new Next.js app, a Vite SPA, or anything else that can call a JSON API and hold a Supabase session — that choice is explicitly left to whoever builds `frontend/`, not decided here.

---

## 3. Data model

Source of truth: `prisma/schema.prisma`. Reproduced here for the frontend agent, who won't have direct DB access.

### Entities

**Profile** — mirrors a Supabase `auth.users` row (created by a DB trigger on signup, not app code).
- `id` (string, = Supabase auth user id), `email` (unique), `displayName` (nullable), `createdAt`

**Bracket**
- `id` (uuid), `creatorId` → Profile, `title`, `description` (nullable)
- `visibility`: `PUBLIC | PRIVATE`
- `votingRequirement`: `ACCOUNT_REQUIRED | ANONYMOUS_ALLOWED`
- `defaultRoundDurationMinutes` (int, NOT NULL, no DB default — see §9.1 on the `60`-minute creation placeholder)
- `roundDurationOverrides` (nullable JSON: `Record<roundNumber, minutes>`, e.g. `{"3": 2880}` overrides only round 3)
- `scheduledStartAt` (nullable datetime; `null` = start immediately on publish)
- `status`: `DRAFT | SCHEDULED | ACTIVE | COMPLETED`
- `createdAt`, `publishedAt` (nullable, set at publish time)

**BracketItem**
- `id`, `bracketId`, `title`, `description` (nullable), `imageUrl` (nullable), `seed` (nullable int, currently unused by any read path), `createdAt`
- Unique on `(bracketId, seed)`

**Round**
- `id`, `bracketId`, `roundNumber` (1-based), `durationMinutes`, `startsAt` (nullable), `endsAt` (nullable), `status`: `PENDING | ACTIVE | COMPLETED`

**Matchup**
- `id`, `roundId`, `itemAId` (nullable), `itemBId` (nullable — `null` means this is a bye), `winnerItemId` (nullable), `status`: `PENDING | ACTIVE | TIE_BREAKER | COMPLETED`, `tieBreakerEndsAt` (nullable)

**Vote**
- `id`, `matchupId`, `itemId`, `userId` (nullable), `anonymousVoterIdentifier` (nullable), `comment` (nullable, ≤500 chars), `phase`: `ORIGINAL | TIE_BREAKER` (default `ORIGINAL`), `createdAt`
- Unique on `(matchupId, userId, phase)` and `(matchupId, anonymousVoterIdentifier, phase)` — one vote per identity per matchup **per phase**, enforced at the DB level. This is the actual source of truth against race conditions; the API's "did I already vote" checks are a courtesy, not the guarantee.

### Entity-relationship summary

```
Profile 1──* Bracket 1──* BracketItem
                │              │
                │              ├──(itemA)──┐
                1──* Round 1──* Matchup ────┤
                                │  (itemB)──┘
                                │
                                1──* Vote *──1 BracketItem
                                              *──1 Profile (nullable)
```

---

## 4. Domain state machines & business rules

This is the part a redesigned UI must not get wrong — it's the actual product logic, currently spread across 6+ files.

### 4.1 BracketStatus

`DRAFT → SCHEDULED | ACTIVE → COMPLETED`. No transition ever goes backward (no un-publish, no re-opening a completed bracket).

- **Created** as `DRAFT`.
- **`DRAFT → SCHEDULED`**: publish with a future `scheduledStartAt` set.
- **`DRAFT → ACTIVE`**: publish with no scheduled start (immediate).
- **`SCHEDULED → ACTIVE`**: cron-driven, when `scheduledStartAt` is in the past (see §4.5).
- **`ACTIVE → COMPLETED`**: when closing a round leaves exactly one winner (the champion).

**Locking rule:** once a bracket leaves `DRAFT`, its structure is permanently locked — items can no longer be added/edited/removed, round durations can't change, the scheduled start can't change, and publish can't be re-run. Every one of these actions independently re-checks `status === DRAFT` server-side on every call — never trust that the UI only rendered the control while it was valid.

### 4.2 RoundStatus

`PENDING → ACTIVE → COMPLETED`. Round 1 is created `PENDING` (scheduled bracket) or `ACTIVE` (immediate). Every later round is created directly `ACTIVE` (never `PENDING` — only round 1 can be gated on a scheduled start). A round stays `ACTIVE` while any of its matchups is in a tie-breaker, even past its own `endsAt` — round-level closing waits for every matchup to resolve.

### 4.3 MatchupStatus

`PENDING → ACTIVE → (TIE_BREAKER →) COMPLETED`, or a **bye** shortcut straight to `COMPLETED` at creation time (no vote ever happens on a bye).

- **Bye** (`itemBId === null`): created `COMPLETED` immediately, `winnerItemId` = the lone item.
- **Non-bye, round 1 of a scheduled bracket**: created `PENDING` (visible, not yet votable).
- **Non-bye, everything else**: created `ACTIVE`.
- **`PENDING → ACTIVE`**: bulk-flipped when the bracket's scheduled start arrives (§4.5).
- **`ACTIVE → COMPLETED`**: round closes, `determineWinner` finds a strict majority.
- **`ACTIVE → TIE_BREAKER`**: round closes, vote counts equal (including 0–0). Sets `tieBreakerEndsAt = now + max(round.durationMinutes × 60,000ms × 0.25, 3,600,000ms)` — **exactly 25% of the round's duration, minimum 1 hour, no maximum**.
- **`TIE_BREAKER → COMPLETED`**: `tieBreakerEndsAt` passes; tallies **only** `TIE_BREAKER`-phase votes; still tied → uniform random pick between the two items.

Votable statuses (i.e. a vote button should render): `ACTIVE` and `TIE_BREAKER` only. `PENDING` and `COMPLETED` are never votable.

### 4.4 VotePhase

Set by the backend from the matchup's status **at the moment the vote is cast**, never accepted from the client: `TIE_BREAKER` if the matchup is currently `TIE_BREAKER`, else `ORIGINAL`. This is what lets one voter cast one original vote and, independently, one tie-breaker revote on the same matchup.

### 4.5 Round-advancement engine (currently a cron job; must stay a backend-owned background process)

A single scheduled job (today: `GET /api/cron/advance-rounds`, `Authorization: Bearer <CRON_SECRET>`, exact string comparison, 401 on any mismatch or unset secret) runs three independent sweeps every invocation, each isolated so one failure doesn't block the others:

1. **Expired active rounds** (`Round.status = ACTIVE AND endsAt < now`) → evaluate each:
   - Tally votes per item per undecided matchup (`Vote.count`, both phases — a matchup reaching this branch shouldn't have tie-breaker votes yet, but the count isn't phase-filtered here).
   - Decisive → matchup `COMPLETED` + `winnerItemId`.
   - Tied → matchup `TIE_BREAKER` + `tieBreakerEndsAt` per the formula above; **the round does not close** while any matchup is `TIE_BREAKER`.
   - Once every matchup in the round is `COMPLETED`: round → `COMPLETED`. If exactly one winner across the round → bracket → `COMPLETED` (champion decided), else create round `N+1` (`ACTIVE`, `startsAt = now`, `endsAt = now + durationMinutes`, duration from `roundDurationOverrides[N+1]` else the bracket default) by pairing winners in bracket order — the same bye-generation algorithm as round 1 applies defensively (shouldn't trigger in practice since elimination halves the field each round, but isn't assumed).
   - "Bracket order" = `itemA.createdAt` ascending. There's no explicit seed/ordinal column consumed by this logic — a winning item's pairing position next round is inherited from its own original `createdAt`, not recomputed. **The API design must preserve an equivalent explicit ordering signal** (see §9.3).
2. **Expired tie-breakers** (`Matchup.status = TIE_BREAKER AND tieBreakerEndsAt < now`) → resolve via §4.3's tie-breaker-phase tally + random fallback, then re-run the round-closing check (resolving the last open tie-breaker may close the round).
3. **Due scheduled brackets** (`Bracket.status = SCHEDULED AND scheduledStartAt < now`) → bracket → `ACTIVE`; round 1 → `ACTIVE`, with `endsAt` **recomputed from the actual transition time** (not the original `scheduledStartAt`), so a late cron run doesn't shorten the round; every `PENDING` matchup in round 1 → `ACTIVE` (byes are already `COMPLETED` and untouched).

All three sweeps are idempotent against being re-run on stale data (e.g. resolving a tie-breaker twice, or starting an already-`ACTIVE` bracket, is a safe no-op) — this matters because a real cron scheduler can retry or double-fire.

### 4.6 Bracket generation / bye algorithm

Pure, framework-free logic (`generateFirstRound`) — port it verbatim to the frontend for the "preview structure" UI (see §9.2 for why this must not be reimplemented independently):

1. `bracketSize` = smallest power of 2 ≥ item count. Throws for fewer than 2 items.
2. `byeCount = bracketSize − itemCount`.
3. The first `byeCount` items (in creation order) each get a bye.
4. Remaining items pair up consecutively in creation order: `(items[byeCount], items[byeCount+1])`, `(items[byeCount+2], items[byeCount+3])`, …

### 4.7 Voting rules (`POST` a vote)

In order, every check below is a real, independent server-side re-check — never trust that the client only ever showed a reachable vote button:

1. Matchup must exist.
2. `itemId` must be one of the matchup's two items.
3. The matchup's round must be `ACTIVE` (not `PENDING`/`COMPLETED`).
4. The matchup itself must be votable (`ACTIVE` or `TIE_BREAKER`).
5. Voter identity resolution:
   - Signed in → identity = `userId`.
   - Not signed in, bracket requires an account (`votingRequirement = ACCOUNT_REQUIRED`) → rejected.
   - Not signed in, anonymous allowed → identity = a signed, httpOnly cookie value (minted on first vote if absent; existing invalid/tampered/unsigned cookie is treated as absent, silently re-minted — never a hard error).
6. If a vote already exists for this identity+matchup+phase → **not an error**: respond as if the vote succeeded, returning the *existing* choice (including the correct behavior when a genuine race loses to the DB's unique constraint — recover by re-reading the winning row, don't surface the constraint violation).
7. Rate limit: this identity has cast ≥20 votes (any matchup, any bracket) in the trailing 10 minutes → rejected. Only counted once steps 1–6 confirm this would be a genuinely new insert (resubmitting an already-voted matchup never counts against the limit).
8. Comment (optional): trimmed; whitespace-only → stored as `null`; over 500 characters → rejected.
9. Insert the vote; on success, the caller's client-side cache for this bracket and this matchup must be invalidated/refetched (no more automatic Next.js `revalidatePath` once split — see §8.3).

Exact current user-facing error strings (preserve unless the product owner asks to change copy — see the mapping table in §7.3 for the code these map to in the new API):

| Case | Message |
|---|---|
| Matchup doesn't exist | `This matchup no longer exists.` |
| `itemId` isn't in the matchup | `That's not a valid choice for this matchup.` |
| Round not active | `Voting has closed for this round.` |
| Matchup not in a votable status | `Voting isn't open for this matchup.` |
| Account required, not signed in | `Sign in to vote on this bracket.` |
| Rate limited | `You've cast a lot of votes very quickly - please wait a few minutes and try again.` |
| Comment too long | `Comments can be at most 500 characters.` |
| Any unexpected failure | `Something went wrong. Please try again.` |

### 4.8 Validation rules (creator-side forms)

**Create bracket**: `title` required (trimmed non-empty) → else `Title is required.`; `visibility` must be `PUBLIC`/`PRIVATE` → else `Choose a visibility: Public or Private.`; `votingRequirement` must be `ACCOUNT_REQUIRED`/`ANONYMOUS_ALLOWED` → else `Choose whether voting requires an account.`; `description` optional, trimmed, empty → `null`.

**Bracket item** (add/edit): `title` required → else `Title is required.`; `description` optional, trimmed, empty → `null`; `image` optional file — must be PNG/JPEG/WebP (`Image must be a PNG, JPEG, or WebP file.`), ≤5MB (`Image must be 5MB or smaller.`); an empty/zero-size file input is treated as "no file chosen," not an error.

**Round duration**: `defaultRoundDurationMinutes` required, positive integer minutes (`Default round duration is required.` / `Default round duration must be a positive number of minutes.`); per-round overrides keyed by **absolute round number** (1, 2, 3…, never a name like "Final" — display names are a pure derived hint: `Final` if it's the last round, `Semifinal` if it's second-to-last and there are ≥2 rounds, else no hint), each optional, and if present must be a positive whole number of minutes (`Round {n}'s duration must be a whole number of minutes.` / `Round {n}'s duration must be a positive number of minutes.`). The valid round-number range is always recomputed server-side from the bracket's *current* item count (`⌈log2(itemCount)⌉`) — never trust a client-supplied total-rounds value.

**Scheduled start**: mode is either `immediate` or `scheduled`. Immediate mode never validates the datetime field at all (it's ignored). Scheduled mode requires a real parseable date/time (`A scheduled start requires a valid date and time.`) strictly after the current server time (`The scheduled start time must be in the future.`). See §9.4 for a timezone caveat the new API should fix rather than carry forward.

### 4.9 Authorization pattern (creator-owned resources)

Every creator-mutating endpoint re-derives the caller's identity from their auth token and looks the bracket up **scoped to `id AND creatorId = caller`** — never by `id` alone. Not found *or* not owned → **404**, not 403 (don't leak whether a bracket with that id exists to a non-owner). A bracket that exists and is owned but in the wrong state (e.g. not `DRAFT`) is a different case — that's a **409**-style business error with its own specific message (see the table in §4.1), not a 404. Item lookups are additionally scoped to the parent bracket id, so an item id can't be reused across brackets even by the same creator.

### 4.10 Anti-abuse / anonymous-identity design (must be preserved)

- The anonymous voter cookie is HMAC-SHA256 signed (`id.hexSignature`) with a server-only secret, `httpOnly`, and verified with a timing-safe comparison — a voter cannot hand-edit the cookie to impersonate a different identity or reset their own rate-limit/vote-history without the signing secret. A missing or invalid-signature cookie is *not* an error; it's treated as "first-time voter," which mints and signs a fresh one. This is an accepted, documented gap (clearing cookies resets identity) — not something the new backend needs to close, just preserve as-is.
- The 20-votes-per-10-minutes rate limit is deliberately generous for real usage and only meaningfully blunts scripted abuse; it is **not** meant to be airtight (see the file comment in the current code for the full reasoning) — don't tighten it without a product decision.

---

## 5. Screen / route inventory

For the frontend agent designing the new UI. Each entry: current route, who can see it, what data it needs (→ services layer call from §7), and current gaps worth deliberately improving (the product rules are fixed; the *presentation* is wide open).

| Route (current) | Audience | Data needed | Current UI honesty check |
|---|---|---|---|
| `/` | anyone | none | Unmodified scaffold — total blank slate for the new frontend's landing/marketing page. |
| `/signup` | signed-out | — | Redirects away if already signed in. |
| `/login` | signed-out | — | Same. |
| `/dashboard` | signed-in (creator) | `bracketService.listMine()` | Lists **only the caller's own brackets**, grouped Drafts/Scheduled/Active/Completed, every group always shown (even empty, with a "No … yet." message). Click-through: Draft/Scheduled → edit page; Active/Completed → public bracket page. |
| `/dashboard/brackets/new` | signed-in | `bracketService.create()` | One form: title, description, visibility, voting requirement. |
| `/dashboard/brackets/:id/edit` | signed-in creator, owner only | `bracketService.get()`, `.listItems()`, `.updateRoundDuration()`, `.updateSchedule()`, `.addItem/.updateItem/.removeItem()`, `.publish()` | The "everything" screen: item CRUD w/ image upload, round-duration config (only while ≥2 items exist do overrides make sense — but is enterable regardless), scheduled-start toggle, a read-only "preview structure" (bye/pairing preview, computed live from current items), and the publish action (only offered once ≥2 items exist). All controls disabled/hidden once not `DRAFT`. |
| `/brackets/:id` | anyone (public link) | `votingService.getVotableMatchups()` | Not a real page in the new design necessarily — today it's a redirect hub: 0 votable matchups shows a status message, exactly 1 auto-navigates to the matchup page, >1 shows a plain list of links. The frontend can collapse this into client-side routing logic rather than a distinct screen. |
| `/brackets/:id/matchups/:matchupId` | anyone | `votingService.getMatchup()`, `votingService.castVote()` | The actual voting screen — two items side by side, a live countdown, vote buttons, an optional shared comment field, and (only once you've voted) both items' vote counts. This is the dominant screen of the product — per the product philosophy, voting should be the most prominent action in the whole app. |
| `/brackets/:id/matchups/:matchupId/result` | anyone | `resultsService.getMatchupResult()` | Shown once a matchup is decided: winner/loser panels with vote totals, a "decided by tie-breaker" banner when applicable, and a read-only comment list. Bye matchups get a distinct "no voting took place" variant. |
| `/brackets/:id/tree` | anyone | `resultsService.getBracketTree()` | Full tournament visualization across every round (including not-yet-reached rounds shown as placeholders), plus a champion banner with final tally once completed. |
| `/discover` | anyone | `discoveryService.listPublic()` | Three fixed sections — Recent (published, not yet started), Active, Completed — public brackets only, newest-published first, no algorithmic ranking (explicitly out of scope per the product doc). |

---

## 6. Auth & identity model for the split (Decision)

**Decision: the frontend talks to Supabase Auth directly** (via the `supabase-js` browser client), not through the new backend. The backend only ever *verifies* a bearer token; it never issues or manages sessions itself.

Why: Supabase already owns the credential store, password rules, email confirmation flow, and session refresh entirely outside this app's database — proxying it through a custom backend would mean re-implementing session/token refresh logic for no product benefit. This also means **there is no `/auth/*` path in `openapi.yaml`** — that surface belongs to Supabase's own API, which the frontend calls with the public anon key exactly as `src/lib/supabase/client.ts` does today.

What the frontend's `authService` (§7.1) must still replicate, because it's genuine business logic currently living in this app's server actions, not Supabase's:

| Case | Current behavior | Where it must move |
|---|---|---|
| Login failure (any reason) | Always the generic `Incorrect email or password.` — never Supabase's raw error, to avoid confirming an email is registered. | `authService.login()` catches any Supabase error and returns this fixed string. |
| Signup, email already registered+confirmed | Supabase's `signUp()` doesn't error for this — it returns a user with `identities: []`. Detected explicitly and turned into `This email is already registered. Try logging in instead.` | `authService.signup()` must inspect `data.user.identities.length === 0` itself. |
| Signup, genuine new account | `Check your email to confirm your account before logging in.` | Same. |
| Signup, Supabase-side rejection (e.g. weak password) | Supabase's raw `error.message` is shown as-is (this is the one path that *isn't* genericized). | Same passthrough. |

**Authenticated calls to the backend** (creator-only endpoints) send `Authorization: Bearer <supabase access token>`. The backend verifies it against Supabase (e.g. `supabase.auth.getUser(token)` using the anon key, or JWT-secret verification) to recover the caller's user id — it does not need the service-role key for this.

**Anonymous voter identity** stays a **backend-set, httpOnly, signed cookie** (`voter_id`) — it must *not* move to `localStorage` or any client-readable/settable storage, since the entire point of the HMAC signature is that the voter's own browser JS can't forge or tamper with it. This has a real deployment consequence: the frontend origin and backend origin need a cookie relationship that survives the split.

**Decision (issue #48): topology (a) — one parent domain.** The frontend and backend are hosted as subdomains of a single parent domain (e.g. `app.example.com` frontend, `api.example.com` backend, both under `.example.com`), *not* as genuinely cross-site origins. This is a final decision, not conditional on deployment specifics — there is no stated hosting constraint that forces a cross-site topology, so the cross-site option ((b): `SameSite=None; Secure` + explicit-origin CORS) is rejected. If a future hosting constraint makes a shared parent domain impossible, that's a new decision to revisit explicitly, not a fallback silently taken here.

The vote-cast endpoint (#56) must set the `voter_id` cookie with exactly these attributes:

| Attribute | Value |
|---|---|
| `Domain` | `.example.com` (the shared parent domain — leading dot so it's sent to both `app.example.com` and `api.example.com`) |
| `SameSite` | `Lax` |
| `Secure` | `true` |
| `httpOnly` | `true` |
| `Path` | `/` |

`Secure` is set even though `SameSite=Lax` doesn't strictly require it, because the parent-domain hosting is expected to be HTTPS end-to-end in every deployed environment. Local development implication: a `Secure` cookie is dropped by the browser over plain `http://localhost`, so local dev must either run both apps over HTTPS on loopback (e.g. via a local TLS proxy) or use real subdomains of a shared parent domain (e.g. `app.localtest.dev` / `api.localtest.dev` with a dev certificate) — plain `http://localhost:3000` + `http://localhost:3001` will silently fail to persist the cookie. This is a local-dev setup detail, not a change to the attributes above.

The backend's CORS policy (#50), for every Route Handler under the REST API surface, must be exactly:

- **Allowed origin:** the frontend's exact origin (`https://app.example.com` in production; the equivalent per-environment origin elsewhere, e.g. a staging subdomain) — an explicit origin, never `*`, since credentials are involved and a wildcard origin is incompatible with `Access-Control-Allow-Credentials: true`
- **`Access-Control-Allow-Credentials`:** `true`
- **Allowed methods:** `GET, POST, PATCH, DELETE, OPTIONS`
- **Allowed headers:** `Authorization, Content-Type`

Every frontend fetch to the backend must set `credentials: "include"` so the browser attaches the `voter_id` cookie (and, on relevant requests, sends the `Authorization` header) cross-subdomain.

**Image uploads** must go through the backend (`POST /brackets/{id}/items` as `multipart/form-data`, or an update with a new image file) — the frontend must never hold the Supabase **service-role key**; only the backend does. If a presigned-upload flow is preferred later for large files, that's an additive change to `openapi.yaml`, not required for parity with current behavior.

---

## 7. Frontend services layer

One module per resource area. Every function's request/response shape is exactly `openapi.yaml`'s schema for that operation — treat this section as the "why," `openapi.yaml` as the "exact wire shape." All functions throw a single `ServiceError { code: string; message: string; status: number }` on any non-2xx response (`code` is the stable machine-readable slug from §7.3; `message` is the human-facing copy, defaulting to the server's message but overridable by the UI for localization/tone later).

### 7.1 `authService` (wraps Supabase directly — see §6)
```ts
signup(email: string, password: string): Promise<{ message: string }>
login(email: string, password: string): Promise<{ session: Session }>  // throws ServiceError{code:"INVALID_CREDENTIALS"} on any failure
logout(): Promise<void>
getSession(): Promise<Session | null>
onAuthStateChange(cb: (session: Session | null) => void): Unsubscribe
```

### 7.2 `bracketService` (creator-owned resource management — all require an authenticated session)
```ts
listMine(): Promise<BracketWithRounds[]>
create(input: { title: string; description?: string; visibility: Visibility; votingRequirement: VotingRequirement }): Promise<Bracket>
get(bracketId: string): Promise<BracketDetail>              // works for anyone; richer fields if caller is the owner — see openapi.yaml
listItems(bracketId: string): Promise<BracketItem[]>          // owner-only
addItem(bracketId: string, input: { title: string; description?: string; image?: File }): Promise<BracketItem>
updateItem(bracketId: string, itemId: string, input: { title: string; description?: string; image?: File }): Promise<BracketItem>
removeItem(bracketId: string, itemId: string): Promise<void>
updateRoundDuration(bracketId: string, input: { defaultRoundDurationMinutes: number; overrides: Record<number, number> }): Promise<Bracket>
updateSchedule(bracketId: string, input: { startMode: "immediate" | "scheduled"; scheduledStartAt?: string /* ISO 8601, UTC */ }): Promise<Bracket>
publish(bracketId: string): Promise<Bracket>
```

### 7.3 `votingService` (public — no auth required, but sends the auth header when present so signed-in voters are recognized)
```ts
getVotableMatchups(bracketId: string): Promise<VotableMatchupsResponse>   // discriminated union: {kind:"message", message} | {kind:"matchups", matchups: MatchupSummary[]}
getMatchup(bracketId: string, matchupId: string): Promise<MatchupVotingView>
castVote(matchupId: string, input: { itemId: string; comment?: string }): Promise<{ votedItemId: string; alreadyVoted: boolean }>
```

Error → code mapping `castVote` (and the UI) must branch on:

| HTTP status | `code` | Meaning |
|---|---|---|
| 404 | `MATCHUP_NOT_FOUND` | matchup id doesn't exist |
| 400 | `INVALID_ITEM` | itemId not one of this matchup's two items |
| 409 | `ROUND_CLOSED` | round no longer active |
| 409 | `MATCHUP_NOT_VOTABLE` | matchup pending/already completed |
| 401 | `SIGN_IN_REQUIRED` | account-required bracket, no session |
| 429 | `RATE_LIMITED` | >20 votes/10min for this identity |
| 400 | `COMMENT_TOO_LONG` | comment over 500 chars |
| 500 | `UNEXPECTED` | anything else |
| 200 | — | success, including the "you already voted" non-error case (`alreadyVoted: true`) |

### 7.4 `resultsService` (public)
```ts
getMatchupResult(bracketId: string, matchupId: string): Promise<MatchupResult>   // discriminated union: bye | decided | not_completed
getBracketTree(bracketId: string): Promise<BracketTree>                          // rounds of cells + optional champion section
```

### 7.5 `discoveryService` (public)
```ts
listPublic(): Promise<{ recent: DiscoverRow[]; active: DiscoverRow[]; completed: DiscoverRow[] }>
```

### 7.6 Cross-cutting rules for the services layer

- **No client-side caching layer is assumed or required by this spec** — the current app relies on Next's `revalidatePath`, which has no meaning once the frontend is a separate app. Each service call is a plain request; it's up to the frontend's own data-fetching approach (React Query, SWR, plain refetch-on-mutation, etc. — frontend agent's choice) to decide when to refetch after a mutation. At minimum, every mutation in `bracketService`/`votingService` should be followed by a refetch of the screen's own data — there is no server-push/websocket layer, so live vote counts and countdowns are client-side polling/timers, exactly as today (`CountdownDisplay` ticks every 1s locally against a fixed end timestamp; it does not poll the server for the countdown itself — only re-fetch matchup data on vote or on a slower interval if "other people's votes updating live" is wanted, which is not a current feature).
- **The bye/pairing preview algorithm (§4.6) is duplicated, deliberately, as a small ported pure function in the frontend** for the live "preview structure" UI — *not* fetched from the backend on every keystroke/item change. This is safe specifically because it's a pure, stateless function with no business rule beyond arithmetic; if it ever needs a rule change, change it in both places (backend's authoritative publish-time version, and this ported copy) — flagged here so it's a deliberate, documented duplication rather than an accidental drift risk.
- Every other rule in §4 is enforced **only** server-side; the frontend may mirror validation for responsiveness (e.g. disable the vote button once a comment exceeds 500 characters) but must always treat the server's response as authoritative and display its returned error, not assume its own pre-check was sufficient.

---

## 8. Backend responsibilities (for whoever builds `backend/`)

Not the frontend agent's concern, but stated for completeness since the split is bidirectional:

1. Every Route Handler wraps its logic in the same generic-500 pattern as today (catch, log, return `{code:"UNEXPECTED", message:"Something went wrong. Please try again."}`) — never leak a raw stack trace or DB error to the client.
2. The round-advancement job (§4.5) must keep running on a real scheduler independent of any request — this is not something an HTTP handler can trigger lazily; a request coming in doesn't advance rounds, only the scheduled job does. Preserve its three-independent-sweeps, one-failure-doesn't-block-others structure.
3. `SUPABASE_SERVICE_ROLE_KEY` lives only in the backend's environment, used only for Storage uploads. Never sent to or reachable from the frontend.
4. `VOTE_COOKIE_SECRET` and `CRON_SECRET` also stay backend-only, unchanged in purpose from today's `.env.example`.
5. CORS: allow exactly the frontend's origin(s), `Access-Control-Allow-Credentials: true` (required for the anonymous-voter cookie to travel), and explicitly enumerate allowed methods/headers (`Authorization`, `Content-Type`) — no wildcard origin, since credentials are involved.

---

## 9. Decisions & open questions

Flagged explicitly rather than silently resolved — a product/engineering call, not something the frontend agent should decide unilaterally.

### 9.1 `defaultRoundDurationMinutes` is hardcoded to 60 at creation

The create-bracket form never asks for a round duration; every new bracket is created with a placeholder `60`-minute default, changed afterward via the round-duration screen on the edit page. This spec preserves that sequencing as-is (`POST /brackets` doesn't accept a duration). If the new frontend wants to collect it up front instead, that's a real product/API change (`CreateBracketRequest` would need a new required or defaulted field) — not assumed here.

### 9.2 Should "preview structure" be a backend endpoint instead of a ported pure function?

§7.6 recommends porting `generateFirstRound` to the frontend since it's pure and has no side effects, avoiding a round-trip on every item edit. The alternative — a `GET /brackets/{id}/preview` endpoint that runs the exact same server-side function — guarantees zero drift at the cost of a network round-trip per preview toggle. If the frontend and backend teams are different people/agents who might let the two copies drift, prefer the endpoint. Pick one; don't half-do both.

### 9.3 Bracket-order / seeding has no explicit column today

Winner pairing for round `N+1` (and the "bracket order" used to render the tree and to determine "which matchup is item X in") is derived by sorting on `BracketItem.createdAt` — there's a `seed` column in the schema but nothing in the current app reads or writes it. This is fragile (relies on insertion order, invisible to the API consumer, and DB-order isn't guaranteed to be stable across arbitrary queries without an explicit `ORDER BY`, which the current code does apply, but only in specific queries). Recommend the backend extraction take this opportunity to populate `seed` explicitly at item-creation time (or a dedicated `position` field) and expose it in the API (`BracketItem.seed`), rather than perpetuating an implicit `createdAt`-order convention into a public REST contract. This is a schema/behavior improvement, not required for parity — flagged for a decision, not made unilaterally here.

### 9.4 Scheduled-start timezone handling is currently server-local-time, likely a latent bug

The current `datetime-local` input is parsed with no timezone information at all — "the future" is judged against the *server process's* local clock interpretation of that raw string, not the *voter's browser's* timezone. In a decoupled frontend/backend, this discrepancy becomes far more visible/likely to bite (frontend and backend commonly run in different timezones/regions). **Recommendation:** the new API should require a real timezone-aware ISO-8601 datetime (`scheduledStartAt: "2026-09-25T14:00:00-04:00"` or UTC), with the frontend responsible for converting its local `<input type="datetime-local">` value using the browser's own timezone offset before sending it — this is a genuine behavior fix, not a pure refactor, so call it out to the product owner rather than changing it silently.

### 9.5 Frontend framework choice is unconstrained

This spec assumes nothing about what `frontend/` is built with beyond "can call a JSON API, can hold a Supabase session, can set `credentials:'include'` on fetches." Next.js (App Router or Pages), a Vite+React SPA, Remix, etc. are all compatible with this contract. That decision belongs to whoever designs the frontend, not this document.

---

## 10. Non-functional carry-overs (must not regress)

- **Rate limit**: 20 votes / identity / rolling 10 minutes, across all brackets/matchups.
- **Comment limit**: 500 characters, trimmed, empty → stored as no comment.
- **Image limits**: PNG/JPEG/WebP only, ≤5MB.
- **Tie-breaker window**: 25% of the round's own duration, minimum 1 hour, no cap.
- **Anonymous voter cookie**: 1-year max-age, httpOnly, signed, `SameSite=Lax` (or `None` if genuinely cross-site — see §6).
- **404-not-403** for any creator-resource-ownership failure; a real-but-wrong-state resource is a distinct 409-style error with its own message, never conflated with "not found."
- **Generic 500 message** (`Something went wrong. Please try again.`) for every unhandled failure — never a raw error surfaced to the end user.
