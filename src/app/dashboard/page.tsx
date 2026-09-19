/**
 * `/dashboard` - still the placeholder from #6, NOT yet wired up to a live
 * query. Issue #8 ("Build the empty creator dashboard page") is blocked:
 * see the comment on that issue for the full writeup. Short version -
 * Prisma 7's generated client (`src/generated/prisma`) throws in its own
 * constructor unless a driver adapter (e.g. `@prisma/adapter-pg`, which
 * itself pulls in `pg`) is passed in, and no such adapter is installed or
 * pinned in `_docs/architecture.md`. AGENTS.md requires asking before
 * adding a dependency, so `src/lib/prisma.ts` (the singleton #8 permits
 * this issue to add) hasn't been created, and this page still can't query
 * `Bracket` rows.
 *
 * The parts of #8 that don't need a database connection are already built
 * and unit-tested, ready to wire in once that dependency question is
 * resolved:
 * - `./bracket-view-model.ts` - `currentRoundNumber`, `formatCreatedAt`,
 *   `toBracketRow`
 * - `./bracket-list.tsx` - the `<BracketList>` presentational component
 *   (empty-state message, or a table of title/status/round/created-date)
 *
 * Once `src/lib/prisma.ts` exists, this page becomes: get the signed-in
 * user's id (`@/lib/supabase/server`), `prisma.bracket.findMany({ where: {
 * creatorId }, orderBy: { createdAt: "desc" }, include: { rounds: { select:
 * { roundNumber: true } } } })`, map each row through `toBracketRow`, and
 * render `<BracketList brackets={rows} />`.
 */
export default function DashboardPage() {
  return <h1 className="text-2xl font-semibold">Dashboard</h1>;
}
