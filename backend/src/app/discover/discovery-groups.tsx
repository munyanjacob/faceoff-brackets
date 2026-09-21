import type { DiscoveryRow, GroupedBrackets } from "./discovery-view-model";

const SECTION_TITLES: Record<keyof GroupedBrackets, string> = {
  recent: "Recent",
  active: "Active",
  completed: "Completed",
};

const EMPTY_MESSAGES: Record<keyof GroupedBrackets, string> = {
  recent: "No recently published brackets yet.",
  active: "No active brackets yet.",
  completed: "No completed brackets yet.",
};

/**
 * Renders one Recent/Active/Completed section: a table of brackets, or an
 * explicit "nothing here yet" message (issue #34's acceptance criterion -
 * a group with no matches shows a message, not an empty gap).
 */
function DiscoverySection({
  group,
  rows,
}: {
  group: keyof GroupedBrackets;
  rows: DiscoveryRow[];
}) {
  return (
    <section aria-labelledby={`discover-${group}`}>
      <h2 id={`discover-${group}`}>{SECTION_TITLES[group]}</h2>
      {rows.length === 0 ? (
        <p>{EMPTY_MESSAGES[group]}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Creator</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.title}</td>
                <td>{row.creatorName}</td>
                <td>{row.publishedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * `/discover`'s three grouped sections, in Recent, Active, Completed order.
 * `groups` is expected to already be filtered/bucketed by
 * `groupPublicBrackets` - this component only renders what it's given.
 *
 * `DiscoverySection` is called directly as a plain function, not as a
 * `<DiscoverySection ... />` JSX element - same reasoning as
 * `../dashboard/page.tsx`'s call to `BracketList`: this codebase's tests
 * introspect a component's return value via `JSON.stringify`, which can't
 * see into an unrendered child element (its `type` is a function
 * reference, dropped by `JSON.stringify`). Calling it directly resolves it
 * inline, and is otherwise equivalent for React.
 */
export function DiscoveryGroups({ groups }: { groups: GroupedBrackets }) {
  return (
    <main>
      <h1>Discover brackets</h1>
      {DiscoverySection({ group: "recent", rows: groups.recent })}
      {DiscoverySection({ group: "active", rows: groups.active })}
      {DiscoverySection({ group: "completed", rows: groups.completed })}
    </main>
  );
}
