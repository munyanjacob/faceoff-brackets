Documents

- `_docs/process.md` - how work is organized

Commands

- `npm install` - install dependencies
- `npm run dev` - start the dev server
- `npm test` - run the whole test suite
- `npx prisma migrate dev` - apply schema changes to the database
- `npx prisma studio` - browse/edit database rows locally

Rules

- Dependencies and their versions are pinned in `_docs/architecture.md`. Do not add or upgrade a dependency without asking.
- The stack and data model in `_docs/architecture.md` are already decided (Next.js, Supabase, Prisma schema). Don't swap a piece of the stack or change the schema shape without checking first.
- Full product requirements live in `_docs/plan.md` - check it for behavior questions (voting rules, tie-breaking, byes, etc.) before guessing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
