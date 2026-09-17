# Backlog — Bracket Polling App

Tasks assume the reader has access to `_docs/plan.md` (product spec) and `_docs/architecture.md` (stack/schema decisions), but not this file's other tasks or any prior discussion. Each task is scoped to one session. Later tasks depend on earlier ones existing in the codebase, but each description is self-contained about what to build and why.

## Phase 1 — Foundation

### 1. Set up an empty project with a passing test
Goal: Get a scaffolded, testable Next.js project into the repo.
Description: Initialize a Next.js (TypeScript, App Router) project using the versions pinned in `_docs/architecture.md`, add a test runner (e.g. Vitest), and write one trivial test (e.g. a smoke test on a placeholder function or component) so `npm test` passes. Commit the scaffold.

### 2. Configure Supabase project and environment variables
Goal: Connect the app to a real Supabase backend.
Description: Create (or confirm access to) a Supabase project, then populate `.env.local` from a checked-in `.env.example` with the project URL, anon key, service role key, and Postgres connection strings per `_docs/architecture.md`. Verify the app boots with these values present; never commit real secrets.

### 3. Add Prisma and define the core schema
Goal: Model brackets, items, rounds, matchups, and votes in Postgres.
Description: Install Prisma at the pinned version and write `prisma/schema.prisma` covering `Profile`, `Bracket`, `BracketItem`, `Round`, `Matchup`, and `Vote` using the field list in `_docs/architecture.md`. Run the initial migration against the Supabase database and confirm the tables exist.

### 4. Add Supabase Auth client helpers
Goal: Make Supabase Auth usable from both server and browser code.
Description: Add `@supabase/supabase-js` and `@supabase/ssr`, then create browser and server Supabase client helpers plus the Next.js middleware needed to refresh auth sessions on each request, following Supabase's standard SSR pattern for the App Router.

### 5. Build sign-up and log-in pages
Goal: Let a user create an account and sign in with email/password.
Description: Build `/signup` and `/login` pages with email/password forms that call Supabase Auth through server actions, showing a basic error message on failure (e.g. wrong password, duplicate email). Rely on Supabase's default email confirmation behavior; don't customize it.

### 6. Add logout and route protection for the dashboard
Goal: Keep the creator dashboard behind authentication.
Description: Add a logout action that ends the current Supabase session, and a layout guard on the `/dashboard` route that redirects signed-out visitors to `/login`.

### 7. Sync a Profile row on signup
Goal: Give every authenticated user an application-level profile row.
Description: Add a Postgres trigger (or equivalent) that inserts a row into the `Profile` table whenever Supabase creates a new row in `auth.users`, copying over the id and email. This lets the rest of the schema foreign-key to `Profile` instead of Supabase's internal auth schema.

### 8. Build the empty creator dashboard page
Goal: Give creators a landing page for their brackets before bracket creation exists.
Description: Build `/dashboard` to query brackets owned by the signed-in user and render them in a table (title, status, current round, creation date), with a clear empty state when the user has none yet.

### 9. Scaffold the round-advancement cron endpoint
Goal: Put the infrastructure for scheduled round advancement in place before the logic exists.
Description: Add an API route (e.g. `/api/cron/advance-rounds`) that checks a bearer token against a `CRON_SECRET` env var and returns 200 with no other behavior yet. Add a `vercel.json` cron entry that calls it on a schedule, per the caveats noted in `_docs/architecture.md`.

## Phase 2 — Bracket Creation

### 10. Build the "create bracket" form
Goal: Let a signed-in user start defining a new bracket.
Description: Build a form collecting title, optional description, public/private visibility, and whether voting requires an account. Submitting it creates a `Bracket` row with status `DRAFT` owned by the current user. Items and timing are handled in separate tasks.

### 11. Add item entry to a draft bracket
Goal: Let a creator add the things being compared.
Description: On the draft bracket's edit page, build a form to add, edit, and remove `BracketItem` rows (title, optional description) belonging to that bracket, validating that title is required before an item can be saved.

### 12. Add image upload for bracket items
Goal: Let creators attach an image to an item.
Description: Add an image upload control to the item form from the previous task that uploads the file to Supabase Storage and stores the resulting public URL on `BracketItem.image_url`, with basic file-type and size validation.

### 13. Add round duration configuration
Goal: Let creators control how long each round runs.
Description: Add a "default round duration" field to the bracket edit form, plus a way to override the duration for individual rounds. Since rounds don't exist until publish, store per-round overrides against round number (e.g. "Round 1", "Final") and apply them when rounds are actually created later.

### 14. Add immediate vs. scheduled start selection
Goal: Let creators choose when the bracket goes live.
Description: Add a start-time control to the bracket edit form offering "start immediately on publish" or "schedule a start date/time," storing the choice on `Bracket.scheduled_start_at` (null meaning immediate).

### 15. Build the pre-publish bracket structure preview
Goal: Show the creator what will be generated before they commit to it.
Description: Given a draft bracket's current items, compute and display the resulting first-round matchup pairings and any byes for review, without creating any `Round`/`Matchup` database rows yet.

### 16. Implement the publish action
Goal: Lock in a bracket and make it live.
Description: Add a "Publish" action on the draft bracket page that transitions `Bracket.status` from `DRAFT` to `SCHEDULED` or `ACTIVE` depending on the start-time choice, and prevents any further add/edit/remove of items afterward.

## Phase 3 — Bracket Engine

### 17. Implement the bracket-generation algorithm
Goal: Turn a flat list of items into a seeded single-elimination structure.
Description: Write a pure function taking an ordered list of items and returning the first-round pairing structure, including byes for non-power-of-two counts, with no dependency on the database or UI so it can be unit tested directly. Cover the examples in `_docs/plan.md` §6 (4, 8, 10, and 16 items).

### 18. Persist generated rounds and matchups
Goal: Turn the generated structure into real database rows.
Description: On bracket publish, use the generation function from the previous task to create the first `Round` and its `Matchup` rows, applying that round's configured duration and immediately marking bye matchups as decided.

### 19. Implement matchup winner determination
Goal: Decide who wins a completed matchup.
Description: Write a function that takes a matchup's vote counts and returns a winner, a tie, or (for a bye) the auto-advanced item. This task only covers the decision logic, not wiring it into round-closing.

### 20. Implement round-closing and next-round generation
Goal: Advance a bracket automatically once a round's matchups are all decided.
Description: Write the function that closes an active round, collects each matchup's winner (using the function from the previous task), generates the next round's matchups, or declares a champion if only one item remains, and creates the corresponding database rows.

## Phase 4 — Voting

### 21. Build the matchup voting page
Goal: Show voters the current matchup and let them cast a vote.
Description: Build the page showing item A and item B side-by-side (image, title, description) with a vote action under each, matching the layout in `_docs/plan.md` §13. Vote submission itself is handled in the next task.

### 22. Implement vote submission with duplicate prevention
Goal: Record a vote exactly once per voter per matchup.
Description: Add a server action that records a `Vote` tied to the matchup and chosen item, using the signed-in user's id when logged in or a browser/session identifier when anonymous voting is allowed, and rejects a second vote from the same voter on the same matchup.

### 23. Add optional comments to votes
Goal: Let voters explain their pick.
Description: Add an optional comment field to the voting form that, when filled in, is saved on the same `Vote` row created in the previous task, with a reasonable max length enforced.

### 24. Show live results after voting
Goal: Give voters feedback immediately after they vote.
Description: After a vote is submitted, display the current vote counts for both items in that matchup, and ensure this results view also appears for anyone revisiting a matchup they've already voted on.

## Phase 5 — Timing

### 25. Build the round countdown display
Goal: Show how much time is left in the current round.
Description: Add a client-side countdown component to the bracket/matchup pages, computed from the active round's `ends_at`, that updates without requiring a page refresh.

### 26. Implement round-expiration detection
Goal: Identify rounds whose time has run out.
Description: Write a read-only query/function that finds all `ACTIVE` rounds whose `ends_at` has passed. This is a building block for the cron job wiring in the next task, not the advancement logic itself.

### 27. Wire automatic advancement into the cron endpoint
Goal: Make round advancement actually happen on a schedule.
Description: Replace the no-op cron endpoint (scaffolded in an earlier task) with logic that finds expired rounds and runs the round-closing/next-round-generation logic against each one, handling multiple brackets in a single invocation.

### 28. Implement scheduled bracket starts
Goal: Make a bracket with a future start time go live automatically.
Description: Extend the cron logic to detect `SCHEDULED` brackets whose `scheduled_start_at` has passed, transition them to `ACTIVE`, and generate their first round. Also ensure the bracket-viewer page shows a "not started yet, starts at X" state beforehand, per `_docs/plan.md` §9.

### 29. Implement tie-breaker handling
Goal: Resolve tied matchups without stalling the bracket.
Description: When round-closing finds a tied matchup, put it into a tie-breaker state for 25% of the round's duration (minimum 1 hour) instead of immediately deciding a winner. Add cron logic to resolve tie-breaker matchups once their window ends, using the tie-breaker vote if decisive and otherwise picking randomly, per `_docs/plan.md` §11.

## Phase 6 — Results

### 30. Build the full bracket visualization
Goal: Show the whole tournament tree, not just the current matchup.
Description: Build a page/component rendering every round's matchups as a bracket tree (per the diagram in `_docs/plan.md` §14), visually distinguishing completed, in-progress, and upcoming matchups.

### 31. Build the completed-matchup detail view
Goal: Show the full history of a decided matchup.
Description: For any completed matchup, display the winner, the losing item, final vote totals, and any comments left with votes, reachable from the bracket visualization built in the previous task.

### 32. Build the champion display
Goal: Give a finished bracket a clear "winner" moment.
Description: When a bracket's final matchup completes, show a distinct champion view (item, image, final vote tally) at the top of the completed bracket's page.

### 33. Populate the creator dashboard with grouped, real data
Goal: Make the dashboard useful once real brackets exist.
Description: Update the dashboard built in an earlier task to group the creator's brackets into Drafts, Scheduled, Active, and Completed sections per `_docs/plan.md` §16, each entry linking to the right view/manage page.

## Phase 7 — Polish

### 34. Build the public discovery page
Goal: Let anyone browse public brackets without a direct link.
Description: Build a page listing public brackets grouped into Recent, Active, and Completed per `_docs/plan.md` §12, excluding any bracket marked private, with no ranking or recommendation logic.

### 35. Add anonymous-voter abuse protections
Goal: Make duplicate anonymous voting meaningfully harder without over-engineering it.
Description: Harden the anonymous voter identifier used for vote submission (e.g. a signed cookie plus basic rate limiting on the vote endpoint) so casual duplicate voting is discouraged, explicitly not aiming for election-grade fraud prevention, per `_docs/plan.md` §7.

### 36. Add validation and error/empty/loading states across the app
Goal: Make the app feel finished rather than merely functional.
Description: Pass over the bracket-creation, voting, and dashboard flows to add consistent client- and server-side validation messages, loading indicators, and empty states wherever data hasn't loaded yet or doesn't exist.

### 37. Add automated tests for the bracket engine
Goal: Lock in correctness of the trickiest logic before it's touched again.
Description: Write unit tests for the bracket-generation, winner-determination, round-closing, and tie-breaker functions built in earlier tasks, covering the item-count examples and tie scenarios described in `_docs/plan.md`.
