import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { StatusPill } from "@/components/status-pill";
import { discoveryService, type DiscoverRow } from "@/services";
import { pageMeta } from "@/lib/pageMeta";

export const Route = createFileRoute("/discover")({
  head: () => ({
    meta: pageMeta({
      title: "Discover brackets — Bracket Arena",
      description: "Browse public voting brackets: starting soon, live right now, and finished.",
      twitterCard: "summary_large_image",
    }),
  }),
  component: Discover,
});

function Section({ title, rows, empty }: { title: string; rows: DiscoverRow[]; empty: string }) {
  return (
    <section className="mt-12">
      <h2 className="text-stencil text-2xl">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <Link
              key={row.id}
              to={row.status === "COMPLETED" ? "/brackets/$bracketId/tree" : "/brackets/$bracketId"}
              params={{ bracketId: row.id }}
              className="arena-panel block p-6 transition-transform hover:-translate-y-1"
            >
              <StatusPill status={row.status} />
              <h3 className="mt-4 text-xl">{row.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">by {row.creatorName}</p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function Discover() {
  const { data, isLoading } = useQuery({
    queryKey: ["discover"],
    queryFn: () => discoveryService.listPublic(),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-10">
      <p className="label-kicker">Public brackets</p>
      <h1 className="text-stencil mt-3 text-4xl">Discover</h1>
      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading brackets…</p>}
      {data && (
        <>
          <Section title="Starting soon" rows={data.recent} empty="Nothing scheduled yet." />
          <Section title="Live now" rows={data.active} empty="No brackets are voting right now." />
          <Section title="Finished" rows={data.completed} empty="No champions crowned yet." />
        </>
      )}
    </div>
  );
}
