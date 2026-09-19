import type { BracketRow } from "./bracket-view-model";

/**
 * Renders the signed-in creator's brackets as a flat list, newest-first
 * (the caller is responsible for ordering - see the query in `page.tsx`),
 * or an explicit empty-state message when there are none.
 *
 * Per issue #8's "Out of scope": no "create a bracket" CTA (here or on the
 * empty state) and no per-row link to a bracket detail page - #10 adds
 * both once that route exists.
 */
export function BracketList({ brackets }: { brackets: BracketRow[] }) {
  if (brackets.length === 0) {
    return <p>You haven&apos;t created any brackets yet.</p>;
  }

  return (
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
        {brackets.map((bracket) => (
          <tr key={bracket.id}>
            <td>{bracket.title}</td>
            <td>{bracket.status}</td>
            <td>{bracket.currentRoundNumber}</td>
            <td>{bracket.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
