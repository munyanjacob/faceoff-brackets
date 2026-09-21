import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { resultsService, type BracketItem } from "@/services";

export const Route = createFileRoute("/brackets/$bracketId/matchups/$matchupId/result")({
  head: () => ({
    meta: [
      { title: "Matchup result — Bracket Arena" },
      { name: "description", content: "See who advanced, the final tally, and voter comments." },
      { property: "og:title", content: "Matchup result — Bracket Arena" },
      {
        property: "og:description",
        content: "See who advanced, the final tally, and voter comments.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResultPage,
});

function Card({
  item,
  votes,
  winner,
}: {
  item: BracketItem;
  votes: number;
  winner: boolean;
}) {
  return (
    <div className={`arena-panel p-6 ${winner ? "border-primary ring-2 ring-primary" : ""}`}>
      {item.imageUrl && (
        <img
          src={item.imageUrl}
          alt={item.title}
          className="mb-4 h-40 w-full rounded object-cover"
        />
      )}
      <p className="label-kicker">{winner ? "Advances" : "Eliminated"}</p>
      <h2 className="mt-2 text-xl font-semibold">{item.title}</h2>
      <p className="text-stencil mt-3 text-3xl text-primary">
        {votes} vote{votes === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function ResultPage() {
  const { bracketId, matchupId } = Route.useParams();
  const { data, isLoading } = useQuery({
    queryKey: ["matchup-result", bracketId, matchupId],
    queryFn: () => resultsService.getMatchupResult(bracketId, matchupId),
  });

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 pt-10">
      <p className="label-kicker">Result</p>
      <h1 className="text-stencil mt-3 text-4xl">Matchup result</h1>

      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading…</p>}

      {data?.kind === "not_completed" && (
        <p className="arena-panel mt-8 p-6 text-muted-foreground">
          This matchup hasn't finished yet.
        </p>
      )}

      {data?.kind === "bye" && (
        <div className="arena-panel mt-8 p-6">
          <p className="label-kicker">Bye</p>
          <h2 className="mt-2 text-2xl font-semibold">{data.advancingItem.title}</h2>
          <p className="mt-2 text-muted-foreground">Advanced without a vote.</p>
        </div>
      )}

      {data?.kind === "decided" && (
        <>
          {data.decidedByTieBreaker && (
            <p className="mt-4 text-sm text-destructive">Decided by a sudden-death tie-breaker.</p>
          )}
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Card item={data.winner} votes={data.winnerVoteCount} winner />
            <Card item={data.loser} votes={data.loserVoteCount} winner={false} />
          </div>

          <section className="mt-10">
            <h2 className="text-stencil text-xl">Voter comments</h2>
            {data.comments.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No comments on this matchup.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {data.comments.map((comment) => (
                  <li key={comment.id} className="arena-panel p-4">
                    <p className="text-sm">{comment.comment}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      voted{" "}
                      {comment.itemId === data.winner.id ? data.winner.title : data.loser.title}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <div className="mt-10 flex gap-3">
        <Link to="/brackets/$bracketId" params={{ bracketId }}>
          <Button variant="outline">Back to bracket</Button>
        </Link>
        <Link to="/brackets/$bracketId/tree" params={{ bracketId }}>
          <Button variant="ghost">See the tree</Button>
        </Link>
      </div>
    </div>
  );
}
