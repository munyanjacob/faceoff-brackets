import type { BracketTreeState, MatchupCell, RoundColumn, TreeItem } from "./bracket-tree-view-model";
import type { ChampionState } from "./champion-view-model";

/**
 * `/brackets/[id]/tree`'s presentational content (issue #30): the full
 * bracket tree, every round rendered as its own column, converging toward a
 * champion per `_docs/outdated/plan.md` SS14's mockup. Deliberately a
 * sibling of `../matchup-voting.tsx`, not a replacement for it - that file
 * still owns the single-matchup voting UI; this one is read-only and shows
 * the whole tournament shape at once (issue #30's "not just the current
 * matchup" goal).
 *
 * Called as a plain function from `page.tsx`, not as a `<BracketTree ... />`
 * JSX element - same "page tests introspect the return value via
 * `JSON.stringify`" reasoning as every other page/presentational split in
 * this codebase (see e.g. `../matchup-voting.tsx`'s top comment).
 *
 * Per-item is deliberately compact (small thumbnail + title only, no
 * description) - unlike `../matchup-voting.tsx`'s full side-by-side
 * layout - since a large bracket (issue #30's 16-item/4-round example)
 * needs many of these on screen at once.
 *
 * Horizontal scroll (`overflow-x-auto` on the row of columns) is how this
 * "stays usable at a large size" per the issue's acceptance criteria -
 * every column always renders at a fixed readable width rather than
 * shrinking/clipping to fit the viewport.
 *
 * Issue #32's champion section renders here, above the tree grid (below the
 * title row) - per that issue's own acceptance criterion ("a champion
 * section above the full tree"), not "right after the columns" as this
 * file originally guessed before #32 was built; that guess is why a stale
 * comment marker used to sit inside `TreeGrid` below instead. Only rendered
 * when `champion.kind === "champion"` (`./champion-view-model.ts`'s
 * `buildChampion` only produces that for a `COMPLETED` bracket with a
 * decided final matchup - `{ kind: "none" }` for anything else, including
 * `DRAFT`/`SCHEDULED`/`ACTIVE`).
 */
export function BracketTree({
  bracketTitle,
  bracketId,
  treeState,
  champion,
}: {
  bracketTitle: string;
  bracketId: string;
  treeState: BracketTreeState;
  champion: ChampionState;
}) {
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">{bracketTitle}</h1>
        <a href={`/brackets/${bracketId}`} className="text-sm underline">
          Back to voting
        </a>
      </div>
      {champion.kind === "champion" ? ChampionSection({ champion }) : null}
      {treeState.kind === "not-published"
        ? StatusMessage({ message: treeState.message })
        : TreeGrid({ rounds: treeState.rounds })}
    </main>
  );
}

/**
 * The champion section itself: winning item's image (or the same
 * placeholder convention `../matchup-voting.tsx`'s `ItemPanel` uses for a
 * missing `imageUrl`) and title, plus the final matchup's vote tally when
 * there is one (`champion.tally` is `null` only for the unreachable-in-
 * practice bye-as-final-matchup case - see `./champion-view-model.ts`'s top
 * comment).
 */
function ChampionSection({
  champion,
}: {
  champion: Extract<ChampionState, { kind: "champion" }>;
}) {
  return (
    <section
      aria-label="Champion"
      className="flex flex-col items-center gap-2 rounded border border-yellow-400 bg-yellow-50 p-6 text-center"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-yellow-700">
        Champion
      </span>
      {champion.winner.imageUrl ? (
        // A plain <img> deliberately, not next/image - same reasoning as
        // ../matchup-voting.tsx's ItemPanel: user-uploaded, unknown-aspect-
        // ratio images from an external (Supabase Storage) domain.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={champion.winner.imageUrl}
          alt={champion.winner.title}
          className="h-32 w-32 object-cover"
        />
      ) : (
        <div
          role="img"
          aria-label={`No image provided for ${champion.winner.title}`}
          className="flex h-32 w-32 items-center justify-center border border-dashed bg-gray-100 text-sm text-gray-500"
        >
          No image
        </div>
      )}
      <p className="text-lg font-semibold">{champion.winner.title}</p>
      {champion.tally ? (
        // A single interpolated string, not several JSX expressions, so
        // this codebase's page tests (which assert on `JSON.stringify` of
        // the returned tree - see e.g. `./page.test.tsx`) can match it as
        // one readable string rather than several array entries.
        <p className="text-sm text-gray-600">{formatVoteTally(champion.tally)}</p>
      ) : null}
    </section>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite">
      {message}
    </p>
  );
}

function TreeGrid({ rounds }: { rounds: RoundColumn[] }) {
  return (
    <div className="overflow-x-auto">
      <div
        role="list"
        aria-label="Bracket rounds"
        className="flex min-w-max gap-8 p-2"
      >
        {rounds.map((round) => RoundColumnView({ round }))}
      </div>
    </div>
  );
}

function RoundColumnView({ round }: { round: RoundColumn }) {
  return (
    <div
      key={round.roundNumber}
      role="listitem"
      aria-label={round.label}
      className="flex w-56 flex-none flex-col gap-4"
    >
      <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-gray-500">
        {round.label}
      </h2>
      <ul className="flex h-full flex-col justify-around gap-6">
        {round.matchups.map((cell) => (
          <li key={cell.id}>{MatchupCellView({ cell })}</li>
        ))}
      </ul>
    </div>
  );
}

function MatchupCellView({ cell }: { cell: MatchupCell }) {
  if (cell.kind === "upcoming") {
    return (
      <div
        aria-label="Not yet reached"
        className="rounded border border-dashed border-gray-300 p-2 text-sm text-gray-400"
      >
        TBD
      </div>
    );
  }

  if (cell.kind === "bye") {
    return (
      <div
        aria-label={`${cell.advancing.title} advances on a bye`}
        className="flex flex-col gap-1 rounded border border-gray-200 bg-gray-50 p-2 text-sm"
      >
        {ItemLine({ item: cell.advancing })}
        <span className="text-xs text-gray-500">(bye - advances automatically)</span>
      </div>
    );
  }

  if (cell.kind === "pending") {
    return (
      <div
        aria-label="Not started yet"
        className="flex flex-col gap-1 rounded border border-gray-200 p-2 text-sm text-gray-500"
      >
        {ItemLine({ item: cell.itemA })}
        {ItemLine({ item: cell.itemB })}
      </div>
    );
  }

  if (cell.kind === "active") {
    return (
      <div
        aria-label={cell.isTieBreaker ? "Tie-breaker in progress" : "Active matchup"}
        className="flex flex-col gap-1 rounded border-2 border-blue-600 bg-blue-50 p-2 text-sm font-medium"
      >
        {ItemLine({ item: cell.itemA })}
        {ItemLine({ item: cell.itemB })}
        {cell.isTieBreaker ? (
          <span className="text-xs font-normal text-blue-700">Tie-breaker</span>
        ) : (
          <span className="text-xs font-normal text-blue-700">Voting now</span>
        )}
      </div>
    );
  }

  // "completed"
  return (
    <div
      aria-label="Completed matchup"
      className="flex flex-col gap-1 rounded border border-gray-200 p-2 text-sm"
    >
      <span className="flex items-center gap-2 font-semibold text-green-700">
        {ItemLine({ item: cell.winner })}
      </span>
      <span className="flex items-center gap-2 text-gray-400 line-through">
        {ItemLine({ item: cell.loser })}
      </span>
    </div>
  );
}

function formatVoteEntry(entry: { item: TreeItem; votes: number }): string {
  return `${entry.item.title}: ${entry.votes} ${entry.votes === 1 ? "vote" : "votes"}`;
}

function formatVoteTally(
  tally: [{ item: TreeItem; votes: number }, { item: TreeItem; votes: number }]
): string {
  return `${formatVoteEntry(tally[0])} - ${formatVoteEntry(tally[1])}`;
}

function ItemLine({ item }: { item: TreeItem | null }) {
  if (!item) {
    return <span>TBD</span>;
  }

  return (
    <span className="flex items-center gap-2">
      {item.imageUrl ? (
        // A plain <img> deliberately, not next/image - same reasoning as
        // ../matchup-voting.tsx's ItemPanel: user-uploaded, unknown-aspect-
        // ratio images from an external (Supabase Storage) domain. Small
        // here since this view is compact per-item by design (see this
        // file's top comment).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.imageUrl} alt="" className="h-6 w-6 flex-none object-cover" />
      ) : null}
      <span className="truncate">{item.title}</span>
    </span>
  );
}
