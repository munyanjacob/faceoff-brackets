import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import { discoveryService } from "@/services";
import { pageMeta } from "@/lib/pageMeta";
import { queryKeys } from "@/lib/queryKeys";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: pageMeta({
      title: "Bracket Arena — Head-to-head voting brackets",
      description:
        "Build a timed tournament bracket, publish it, and let the crowd vote one matchup at a time until a champion is crowned.",
      ogDescription: "Timed, head-to-head bracket voting. Build it, publish it, crown a champion.",
      twitterCard: "summary_large_image",
    }),
  }),
  component: Landing,
});

function Landing() {
  const { data } = useQuery({
    queryKey: queryKeys.discover(),
    queryFn: () => discoveryService.listPublic(),
  });
  const live = data?.active.slice(0, 3) ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24">
      <section className="py-16 text-center sm:py-24">
        <p className="label-kicker">Single elimination · Timed rounds · One champion</p>
        <h1 className="text-stencil mt-6 text-5xl leading-[0.95] sm:text-7xl">
          Settle it in the
          <span className="block text-primary">bracket.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
          Pit anything against anything. Rounds close on a timer, winners advance, ties go to a
          sudden-death revote.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link to="/discover">
            <Button size="lg" className="arena-glow">
              Vote in a live bracket
            </Button>
          </Link>
          <Link to="/dashboard">
            <Button size="lg" variant="outline">
              Build your own
            </Button>
          </Link>
        </div>
      </section>

      {live.length > 0 && (
        <section className="mt-4">
          <h2 className="text-stencil text-2xl">Live right now</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {live.map((row) => (
              <Link
                key={row.id}
                to="/brackets/$bracketId"
                params={{ bracketId: row.id }}
                className="arena-panel block p-6 transition-transform hover:-translate-y-1"
              >
                <StatusPill status={row.status} />
                <h3 className="mt-4 text-xl">{row.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">by {row.creatorName}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mt-20 grid gap-6 sm:grid-cols-3">
        {[
          {
            step: "01",
            title: "Load the field",
            body: "Add every contender with a title, blurb, and image. Byes are generated automatically.",
          },
          {
            step: "02",
            title: "Set the clock",
            body: "Pick a default round length, override individual rounds, and start now or later.",
          },
          {
            step: "03",
            title: "Let them vote",
            body: "Share the link. Voters pick a side, leave a comment, and watch the tree fill in.",
          },
        ].map((card) => (
          <div key={card.step} className="arena-panel p-6">
            <span className="text-stencil text-3xl text-primary">{card.step}</span>
            <h3 className="mt-3 text-lg">{card.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{card.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
