import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Countdown } from "@/components/countdown";
import { votingService, toServiceError, type BracketItem } from "@/services";
import { pageMeta } from "@/lib/pageMeta";

export const Route = createFileRoute("/brackets/$bracketId/matchups/$matchupId/")({
  head: () => ({
    meta: pageMeta({
      title: "Cast your vote — Bracket Arena",
      description: "Pick your side in this head-to-head matchup.",
    }),
  }),
  component: VotePage,
});

function VoteChoice({
  item,
  selected,
  votes,
  disabled,
  onSelect,
}: {
  item: BracketItem;
  selected: boolean;
  votes: number | null;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`arena-panel block w-full p-6 text-left transition-transform ${
        selected ? "border-primary ring-2 ring-primary" : ""
      } ${disabled ? "cursor-default opacity-90" : "hover:-translate-y-1"}`}
    >
      {item.imageUrl && (
        <img
          src={item.imageUrl}
          alt={item.title}
          className="mb-4 h-40 w-full rounded object-cover"
        />
      )}
      <h2 className="text-xl font-semibold">{item.title}</h2>
      {item.description && (
        <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
      )}
      {votes !== null && (
        <p className="text-stencil mt-4 text-2xl text-primary">
          {votes} vote{votes === 1 ? "" : "s"}
        </p>
      )}
    </button>
  );
}

function VotePage() {
  const { bracketId, matchupId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["matchup", bracketId, matchupId],
    queryFn: () => votingService.getMatchup(bracketId, matchupId),
  });

  if (isLoading || !data) {
    return <p className="mx-auto max-w-4xl px-4 pt-10 text-sm text-muted-foreground">Loading…</p>;
  }

  const { matchup, voter } = data;
  const blocked = voter.kind === "blocked";
  const existingVoteItemId = voter.kind === "eligible" ? voter.existingVoteItemId : null;
  const voteCounts = voter.kind === "eligible" ? voter.voteCounts : null;

  async function vote(itemId: string) {
    setError(null);
    setBusy(true);
    try {
      await votingService.castVote(matchupId, {
        itemId,
        comment: comment.trim() || undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ["matchup", bracketId, matchupId] });
      await queryClient.invalidateQueries({ queryKey: ["matchups", bracketId] });
    } catch (caught) {
      setError(toServiceError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 pt-10">
      <p className="label-kicker">{data.bracketTitle}</p>
      <h1 className="text-stencil mt-3 text-4xl">
        {data.isTieBreaker ? "Sudden-death tie-breaker" : "Cast your vote"}
      </h1>
      <p className="mt-2 text-muted-foreground">
        Closes in <Countdown endsAt={data.countdownEndsAt} className="text-foreground" />
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <VoteChoice
          item={matchup.itemA}
          selected={existingVoteItemId === matchup.itemA.id}
          votes={voteCounts ? (voteCounts[matchup.itemA.id] ?? 0) : null}
          disabled={blocked || busy || existingVoteItemId !== null}
          onSelect={() => vote(matchup.itemA.id)}
        />
        {matchup.itemB && (
          <VoteChoice
            item={matchup.itemB}
            selected={existingVoteItemId === matchup.itemB.id}
            votes={voteCounts ? (voteCounts[matchup.itemB.id] ?? 0) : null}
            disabled={blocked || busy || existingVoteItemId !== null}
            onSelect={() => vote(matchup.itemB!.id)}
          />
        )}
      </div>

      {blocked && voter.kind === "blocked" && (
        <div className="arena-panel mt-6 p-6">
          <p className="text-muted-foreground">{voter.message}</p>
          <Button className="mt-4" onClick={() => navigate({ to: "/auth" })}>
            Sign in
          </Button>
        </div>
      )}

      {!blocked && existingVoteItemId === null && (
        <div className="arena-panel mt-6 space-y-3 p-6">
          <p className="label-kicker">Say why (optional)</p>
          <Textarea
            rows={3}
            placeholder="Add a short comment with your vote"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      )}

      {existingVoteItemId !== null && (
        <p className="mt-6 text-sm text-success">Your vote is locked in.</p>
      )}

      {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

      <div className="mt-8 flex gap-3">
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
