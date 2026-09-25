import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import { resultsService, type MatchupCell } from "@/services";
import { queryKeys } from "@/lib/queryKeys";

export const Route = createFileRoute("/brackets/$bracketId/tree")({
  head: () => ({
    meta: [
      { title: "Bracket tree — Bracket Arena" },
      {
        name: "description",
        content: "Every round of the tournament, from the opening matchups to the champion.",
      },
      { property: "og:title", content: "Bracket tree — Bracket Arena" },
      {
        property: "og:description",
        content: "Every round of the tournament, from the opening matchups to the champion.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TreePage,
});

function Side({ title, highlight }: { title: string; highlight: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
        highlight ? "bg-primary/15 font-semibold text-primary" : "bg-secondary/40 text-muted-foreground"
      }`}
    >
      <span className="truncate">{title}</span>
    </div>
  );
}

/**
 * cell is the discriminated MatchupCell union from openapi.yaml (kept
 * discriminated rather than a flatter {status, itemA, itemB, winnerItemId}
 * shape — see issue #49 / specification.md §9.6). "upcoming" cells (a
 * round that hasn't been generated yet) have no matchupId to link to.
 */
function Cell({ bracketId, cell }: { bracketId: string; cell: MatchupCell }) {
  if (cell.kind === "upcoming") {
    return (
      <div className="arena-panel block space-y-2 p-3 opacity-60">
        <Side title="TBD" highlight={false} />
        <Side title="TBD" highlight={false} />
      </div>
    );
  }

  const [top, bottom] =
    cell.kind === "bye"
      ? [
          { title: cell.advancingItem.title, highlight: true },
          { title: "Bye", highlight: false },
        ]
      : cell.kind === "completed"
        ? [
            { title: cell.winner.title, highlight: true },
            { title: cell.loser.title, highlight: false },
          ]
        : [
            { title: cell.itemA.title, highlight: false },
            { title: cell.itemB?.title ?? "TBD", highlight: false },
          ];

  return (
    <Link
      to="/brackets/$bracketId/matchups/$matchupId/result"
      params={{ bracketId, matchupId: cell.matchupId }}
      className="arena-panel block space-y-2 p-3 transition-transform hover:-translate-y-0.5"
    >
      <Side title={top.title} highlight={top.highlight} />
      <Side title={bottom.title} highlight={bottom.highlight} />
    </Link>
  );
}

function TreePage() {
  const { bracketId } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.tree(bracketId),
    queryFn: () => resultsService.getBracketTree(bracketId),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="label-kicker">Tournament tree</p>
          <h1 className="text-stencil mt-3 text-4xl">{data?.bracketTitle ?? "Loading…"}</h1>
        </div>
        <div className="flex items-center gap-3">
          {data && <StatusPill status={data.bracketStatus} />}
          <Link to="/brackets/$bracketId" params={{ bracketId }}>
            <Button variant="outline" size="sm">
              Back to bracket
            </Button>
          </Link>
        </div>
      </div>

      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading tree…</p>}

      {data?.champion && (
        <section className="arena-panel arena-glow mt-8 p-8 text-center">
          <p className="label-kicker">Champion</p>
          <h2 className="text-stencil mt-3 text-4xl text-primary">{data.champion.item.title}</h2>
          <ul className="mt-5 inline-flex flex-col gap-1 text-sm text-muted-foreground">
            {data.champion.finalTally.map((row) => (
              <li key={row.item.id}>
                {row.item.title} — {row.votes} vote{row.votes === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && (
        <div className="mt-10 flex gap-6 overflow-x-auto pb-4">
          {data.rounds.map((round) => (
            <div key={round.roundNumber} className="w-64 shrink-0">
              <div className="flex items-center justify-between">
                <h2 className="text-stencil text-lg">{round.label}</h2>
                {round.status !== "NOT_STARTED" && <StatusPill status={round.status} />}
              </div>
              <div className="mt-4 space-y-3">
                {round.cells.map((cell, index) => (
                  <Cell
                    key={cell.kind === "upcoming" ? `upcoming-${index}` : cell.matchupId}
                    bracketId={bracketId}
                    cell={cell}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
