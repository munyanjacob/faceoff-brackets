import {
  DASHBOARD_SECTIONS,
  bracketLinkHref,
  groupBracketsByStatus,
} from "./bracket-view-model";
import type { BracketRow } from "./bracket-view-model";

/**
 * Renders the signed-in creator's brackets grouped into the four dashboard
 * sections from issue #33 (Drafts, Scheduled, Active, Completed), matching
 * `Bracket.status`. Every section is always rendered (never hidden) so an
 * empty section still shows an explicit "none yet" message rather than an
 * empty gap - see `groupBracketsByStatus` in `./bracket-view-model` for the
 * partitioning itself.
 *
 * Each row still shows title, status, current round (the "-" placeholder
 * for drafts/scheduled, which have no `Round` rows yet), and creation date,
 * per #8. The title links to the edit flow for drafts/scheduled, or the
 * (placeholder, per #33) public bracket view for active/completed - see
 * `bracketLinkHref`.
 *
 * A plain `<a>`, not `next/link`'s `<Link>`, deliberately - `next/link`'s
 * default export is a `forwardRef` object whose own `default` property
 * points back to itself, so nesting a `<Link>` element in this component's
 * return value makes it a circular structure, which breaks the
 * `JSON.stringify(BracketList(...))` introspection this codebase's tests
 * rely on throughout (e.g. `./bracket-list.test.tsx`,
 * `./dashboard-query.integration.test.ts`). A plain `<a>` still navigates
 * correctly; it just forgoes `<Link>`'s client-side prefetch/transition.
 */
export function BracketList({ brackets }: { brackets: BracketRow[] }) {
  const grouped = groupBracketsByStatus(brackets);

  return (
    <>
      {DASHBOARD_SECTIONS.map(({ status, heading }) => {
        const rows = grouped[status];

        return (
          <section key={status} aria-label={heading}>
            <h2>{heading}</h2>
            {rows.length === 0 ? (
              <p>{`No ${heading.toLowerCase()} yet.`}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Current round</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bracket) => (
                    <tr key={bracket.id}>
                      <td>
                        <a href={bracketLinkHref(bracket)}>{bracket.title}</a>
                      </td>
                      <td>{bracket.status}</td>
                      <td>{bracket.currentRoundNumber}</td>
                      <td>{bracket.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </>
  );
}
