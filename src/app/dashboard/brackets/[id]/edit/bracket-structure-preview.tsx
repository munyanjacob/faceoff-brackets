import { generateFirstRound } from "@/lib/bracket/generate-first-round";

export type PreviewItem = {
  id: string;
  title: string;
};

/**
 * "Preview structure" view on a draft bracket's edit page (issue #15).
 *
 * Calls `generateFirstRound` (issue #17, `src/lib/bracket/generate-first-round.ts`)
 * directly rather than reimplementing any pairing/bye logic here, so this
 * preview and the eventual publish step (#18) can never disagree about the
 * structure.
 *
 * This is a plain function component, not a Client Component: it does no
 * data fetching or mutation of its own, just formats whatever `items` its
 * caller (`./page.tsx`) already fetched. `./page.tsx` queries
 * `prisma.bracketItem` fresh on every request (no caching layer sits in
 * front of it, and issue #11's Server Actions call `revalidatePath` on this
 * route after every add/edit/remove), so every render of this component -
 * including every time a viewer expands the `<details>` below - reflects
 * the current item list rather than a structure computed once and cached.
 * Native `<details>`/`<summary>` is used instead of client-side state so
 * "reopening" the preview needs no JavaScript and can never resurrect stale
 * props.
 *
 * `generateFirstRound` throws for fewer than 2 items, so that case is
 * checked here first and shown as a plain message instead of calling it.
 *
 * Purely presentational and read-only: no `prisma` import, no Server
 * Action, no mutation of any kind. Viewing (or re-expanding) this preview
 * creates zero database rows.
 */
export function BracketStructurePreview({ items }: { items: PreviewItem[] }) {
  return (
    <details className="border p-3">
      <summary className="cursor-pointer font-semibold">
        Preview structure
      </summary>

      <div className="mt-3">
        {items.length < 2 ? (
          <p>A bracket needs at least 2 items to preview its structure.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {generateFirstRound(items).map((matchup) => (
              <li key={matchup.itemA.id}>
                {matchup.itemB === null
                  ? `${matchup.itemA.title} — Bye (advances automatically)`
                  : `${matchup.itemA.title} vs ${matchup.itemB.title}`}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
