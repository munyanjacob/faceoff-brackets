import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import { bracketService, votingService, type MatchupSummary } from "@/services";
import { pageMeta } from "@/lib/pageMeta";

export const Route = createFileRoute("/brackets/$bracketId/")({
  head: () => ({
    meta: pageMeta({
      title: "Vote in this bracket — Bracket Arena",
      description: "Pick a side in every open matchup before the round clock runs out.",
    }),
  }),
  component: BracketPage,
});

function MatchupCard({ bracketId, matchup }: { bracketId: string; matchup: MatchupSummary }) {
  const body = (
    <div className="arena-panel p-6 transition-transform hover:-translate-y-1">
      <StatusPill status={matchup.status} />
      <div className="mt-4 flex items-center justify-between gap-4">
        <span className="text-lg font-semibold">{matchup.itemA.title}</span>
        <span className="text-stencil text-primary">vs</span>
        <span className="text-lg font-semibold">
          {matchup.itemB ? matchup.itemB.title : "Bye"}
        </span>
      </div>
    </div>
  );

  if (matchup.status === "COMPLETED" || !matchup.itemB) {
    return (
      <Link
        to="/brackets/$bracketId/matchups/$matchupId/result"
        params={{ bracketId, matchupId: matchup.id }}
      >
        {body}
      </Link>
    );
  }
  return (
    <Link
      to="/brackets/$bracketId/matchups/$matchupId"
      params={{ bracketId, matchupId: matchup.id }}
    >
      {body}
    </Link>
  );
}

function BracketPage() {
  const { bracketId } = Route.useParams();
  const navigate = useNavigate();

  const { data: bracket } = useQuery({
    queryKey: ["bracket", bracketId],
    queryFn: () => bracketService.get(bracketId),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["matchups", bracketId],
    queryFn: () => votingService.getVotableMatchups(bracketId),
  });

  // Exactly one votable matchup: skip the list and go straight to it.
  // See docs/frontend-rework-specification.md §5 on the `/brackets/:id` "redirect hub" behavior.
  const soleMatchup =
    data?.kind === "matchups" && data.matchups.length === 1 ? data.matchups[0] : null;
  const soleMatchupId = soleMatchup ? soleMatchup.id : null;

  useEffect(() => {
    if (soleMatchupId) {
      navigate({
        to: "/brackets/$bracketId/matchups/$matchupId",
        params: { bracketId, matchupId: soleMatchupId },
        replace: true,
      });
    }
  }, [soleMatchupId, bracketId, navigate]);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="label-kicker">Bracket</p>
          <h1 className="text-stencil mt-3 text-4xl">{bracket?.title ?? "Loading…"}</h1>
          {bracket?.description && (
            <p className="mt-2 max-w-xl text-muted-foreground">{bracket.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {bracket && <StatusPill status={bracket.status} />}
          <Link to="/brackets/$bracketId/tree" params={{ bracketId }}>
            <Button variant="outline" size="sm">
              See the tree
            </Button>
          </Link>
        </div>
      </div>

      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading matchups…</p>}

      {data?.kind === "message" && (
        <p className="arena-panel mt-8 p-6 text-muted-foreground">{data.message}</p>
      )}

      {soleMatchupId && (
        <p className="mt-8 text-sm text-muted-foreground">Taking you to the open matchup…</p>
      )}

      {data?.kind === "matchups" && data.matchups.length > 1 && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {data.matchups.map((matchup) => (
            <MatchupCard key={matchup.id} bracketId={bracketId} matchup={matchup} />
          ))}
        </div>
      )}
    </div>
  );
}
