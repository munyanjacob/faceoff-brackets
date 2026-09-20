import type { VotingItem, VotingMatchup } from "./voting-view-model";

type IndexMatchup = VotingMatchup & { itemA: VotingItem; itemB: VotingItem };

/**
 * `/brackets/[id]`'s lightweight index (issue #40): shown only when the
 * bracket's active round has *more than one* votable matchup at once - the
 * common case (exactly one, including every round after round 1 shrinks
 * the bracket down) never reaches this component at all, since `./page.tsx`
 * redirects straight into `/brackets/[id]/matchups/[matchupId]` instead
 * (see that file and `./voting-view-model.ts`'s `listVotableMatchups`).
 *
 * Deliberately minimal per the issue #40 grooming comment: item titles as
 * the link text is enough here - no images/descriptions/vote controls, all
 * of which the destination matchup page (`./matchup-voting.tsx`, via
 * `./matchups/[matchupId]/page.tsx`) already renders in full once a voter
 * picks a matchup. The not-started/between-rounds/completed status
 * messages from issue #21 deliberately do *not* move to the per-matchup
 * route or here - they describe the bracket as a whole, not any one
 * matchup, so `./page.tsx` keeps rendering them itself (via
 * `./matchup-voting.tsx`, reused unchanged) rather than duplicating them
 * per matchup.
 *
 * A plain `<a>`, not `next/link`'s `<Link>`, deliberately - same reasoning
 * as `../../dashboard/bracket-list.tsx`'s top comment: `next/link`'s
 * default export is a circular `forwardRef` object (its own `default`
 * property points back to itself), so nesting a `<Link>` element in this
 * component's return value would make `JSON.stringify(...)` throw - and
 * this codebase's page tests rely on that introspection throughout (see
 * e.g. `./page.test.tsx`). A plain `<a>` still navigates correctly; it
 * just forgoes `<Link>`'s client-side prefetch/transition.
 */
export function MatchupIndex({
  bracketTitle,
  bracketId,
  matchups,
}: {
  bracketTitle: string;
  bracketId: string;
  matchups: IndexMatchup[];
}) {
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{bracketTitle}</h1>
      <ul aria-label="Open matchups" className="flex flex-col gap-2">
        {matchups.map((matchup) => (
          <li key={matchup.id}>
            <a href={`/brackets/${bracketId}/matchups/${matchup.id}`}>
              {`${matchup.itemA.title} vs ${matchup.itemB.title}`}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
