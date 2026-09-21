import type {
  MatchupResultState,
  ResultComment,
  ResultItem,
} from "./matchup-result-view-model";

/**
 * `/brackets/[id]/matchups/[matchupId]/result`'s presentational content
 * (issue #31): the full record of one decided matchup - both items, the
 * winner marked distinctly from the loser, the final vote count for each
 * side, and any comments left with a vote on it. A bye renders as a bye
 * (no vote tally implied); a tie-breaker-decided matchup is labeled as such
 * rather than looking like a clean majority win. See
 * `./matchup-result-view-model.ts`'s top comment for why this is a sibling
 * of `../matchup-voting.tsx`, not a second state of it.
 *
 * Called as a plain function from `page.tsx`, not as a
 * `<MatchupResult ... />` JSX element - same "page tests introspect the
 * return value via `JSON.stringify`" reasoning as every other page/
 * presentational split in this codebase (see e.g. `../../../matchup-voting.tsx`'s
 * top comment).
 *
 * Comments are shown read-only, in submission order - editing/moderating
 * them is explicitly out of scope for issue #31.
 */
export function MatchupResult({
  bracketTitle,
  bracketId,
  resultState,
}: {
  bracketTitle: string;
  bracketId: string;
  resultState: MatchupResultState;
}) {
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">{bracketTitle}</h1>
        <a href={`/brackets/${bracketId}/tree`} className="text-sm underline">
          View full bracket
        </a>
      </div>
      {ResultBody({ resultState })}
    </main>
  );
}

function ResultBody({ resultState }: { resultState: MatchupResultState }) {
  if (resultState.kind === "unresolved") {
    return (
      <p role="status" aria-live="polite">
        This matchup&apos;s result isn&apos;t available.
      </p>
    );
  }

  if (resultState.kind === "bye") {
    return (
      <section aria-label="Matchup result" className="flex flex-col gap-4">
        <p role="status" aria-live="polite" className="text-sm text-gray-600">
          Decided by bye - no voting took place.
        </p>
        <div className="flex w-full flex-col items-center gap-2 border p-4 sm:w-72">
          {ItemMedia({ item: resultState.advancing })}
          <p className="text-center text-lg font-medium">{resultState.advancing.title}</p>
          <p className="text-sm font-semibold text-green-700">Advanced automatically</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Matchup result" className="flex flex-col gap-6">
      {resultState.decidedByTieBreaker ? (
        <p role="status" aria-live="polite" className="text-sm font-medium text-amber-700">
          Decided by a tie-breaker vote, not a clean majority.
        </p>
      ) : null}
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
        {ItemResultPanel({
          item: resultState.winner,
          voteCount: resultState.winnerVoteCount,
          isWinner: true,
        })}
        {ItemResultPanel({
          item: resultState.loser,
          voteCount: resultState.loserVoteCount,
          isWinner: false,
        })}
      </div>
      {CommentsList({ comments: resultState.comments })}
    </section>
  );
}

function ItemResultPanel({
  item,
  voteCount,
  isWinner,
}: {
  item: ResultItem;
  voteCount: number;
  isWinner: boolean;
}) {
  return (
    <div
      aria-label={isWinner ? `Winner: ${item.title}` : `Runner-up: ${item.title}`}
      className={`flex w-full flex-col items-center gap-2 border p-4 sm:w-72 ${
        isWinner ? "border-2 border-green-600 bg-green-50" : "border-gray-200"
      }`}
    >
      {isWinner ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-green-700">
          Winner
        </p>
      ) : null}
      {ItemMedia({ item })}
      <p className="text-center text-lg font-medium">{item.title}</p>
      {item.description ? (
        <p className="text-center text-sm text-gray-600">{item.description}</p>
      ) : null}
      <p className="text-sm text-gray-600">
        {`${voteCount} ${voteCount === 1 ? "vote" : "votes"}`}
      </p>
    </div>
  );
}

function ItemMedia({ item }: { item: ResultItem }) {
  return item.imageUrl ? (
    // A plain <img> deliberately, not next/image - same reasoning as
    // ../../../matchup-voting.tsx's ItemPanel: user-uploaded, unknown-aspect-
    // ratio images from an external (Supabase Storage) domain.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.imageUrl} alt={item.title} className="h-48 w-48 object-cover" />
  ) : (
    <div
      role="img"
      aria-label={`No image provided for ${item.title}`}
      className="flex h-48 w-48 items-center justify-center border border-dashed bg-gray-100 text-sm text-gray-500"
    >
      No image
    </div>
  );
}

function CommentsList({ comments }: { comments: ResultComment[] }) {
  if (comments.length === 0) {
    return (
      <p className="text-sm text-gray-500">No comments were left on this matchup.</p>
    );
  }

  return (
    <ul aria-label="Vote comments" className="flex flex-col gap-3">
      {comments.map((commentRow) => (
        <li key={commentRow.id} className="border-l-2 border-gray-200 pl-3 text-sm">
          {commentRow.comment}
        </li>
      ))}
    </ul>
  );
}
