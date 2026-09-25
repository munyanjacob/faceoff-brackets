import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import { bracketService, type BracketStatus, type BracketWithRounds } from "@/services";
import { pageMeta } from "@/lib/pageMeta";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: pageMeta({
      title: "My brackets — Bracket Arena",
      description: "Manage the brackets you've created.",
    }),
  }),
  component: Dashboard,
});

const GROUPS: { status: BracketStatus; title: string; empty: string }[] = [
  { status: "DRAFT", title: "Drafts", empty: "No drafts yet." },
  { status: "SCHEDULED", title: "Scheduled", empty: "No scheduled brackets yet." },
  { status: "ACTIVE", title: "Live", empty: "No live brackets yet." },
  { status: "COMPLETED", title: "Finished", empty: "No finished brackets yet." },
];

function Row({ bracket }: { bracket: BracketWithRounds }) {
  const editable = bracket.status === "DRAFT" || bracket.status === "SCHEDULED";
  const content = (
    <div className="arena-panel flex items-center justify-between gap-4 p-5 transition-transform hover:-translate-y-0.5">
      <div>
        <h3 className="text-lg">{bracket.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {bracket.visibility === "PUBLIC" ? "Public" : "Private"} ·{" "}
          {bracket.votingRequirement === "ACCOUNT_REQUIRED"
            ? "Account required to vote"
            : "Anyone can vote"}
          {bracket.rounds.length > 0 ? ` · ${bracket.rounds.length} round(s)` : ""}
        </p>
      </div>
      <StatusPill status={bracket.status} />
    </div>
  );

  return editable ? (
    <Link to="/brackets/$bracketId/edit" params={{ bracketId: bracket.id }}>
      {content}
    </Link>
  ) : (
    <Link to="/brackets/$bracketId" params={{ bracketId: bracket.id }}>
      {content}
    </Link>
  );
}

function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["my-brackets"],
    queryFn: () => bracketService.listMine(),
  });

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="label-kicker">Creator desk</p>
          <h1 className="text-stencil mt-3 text-4xl">My brackets</h1>
        </div>
        <Link to="/brackets/new">
          <Button className="arena-glow">New bracket</Button>
        </Link>
      </div>

      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading…</p>}

      {data &&
        GROUPS.map((group) => {
          const rows = data.filter((b) => b.status === group.status);
          return (
            <section key={group.status} className="mt-10">
              <h2 className="text-stencil text-xl">{group.title}</h2>
              {rows.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{group.empty}</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {rows.map((bracket) => (
                    <Row key={bracket.id} bracket={bracket} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
    </div>
  );
}
