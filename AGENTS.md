Documents

- `_docs/process.md` - how work is organized
- `_docs/outdated/plan.md` and `_docs/outdated/architecture.md` - full
  product requirements and the stack/data-model rationale. Despite the
  folder name, these remain the source of truth the Rules below point to -
  "outdated" refers to the docs restructure that moved them here, not their
  content (see `README.md`'s "Layout" section).

Commands

The Next.js app lives in `backend/`. Run these from inside `backend/`
(e.g. `cd backend && npm run dev`):

- `npm install` - install dependencies
- `npm run dev` - start the dev server
- `npm test` - run the whole test suite
- `npx prisma migrate dev` - apply schema changes to the database
- `npx prisma studio` - browse/edit database rows locally

Rules

- Dependencies and their versions are pinned in `_docs/outdated/architecture.md`. Do not add or upgrade a dependency without asking.
- The stack and data model in `_docs/outdated/architecture.md` are already decided (Next.js, Supabase, Prisma schema). Don't swap a piece of the stack or change the schema shape without checking first.
- Full product requirements live in `_docs/outdated/plan.md` - check it for behavior questions (voting rules, tie-breaking, byes, etc.) before guessing.
- The backend/frontend split and the REST contract between them are decided in `docs/frontend-rework-specification.md` and `docs/openapi.yaml` - check those for API shape/behavior questions once you're past `backend/`'s own server-action-era rules.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
