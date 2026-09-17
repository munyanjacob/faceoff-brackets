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
