import { useQuery } from "@tanstack/react-query";
import { bracketService } from "@/services";
import { generateFirstRound, roundLabel, totalRoundsFor } from "@/lib/bracket-logic";
import { queryKeys } from "@/lib/queryKeys";

export function StructurePreview({ bracketId }: { bracketId: string }) {
  const { data: items } = useQuery({
    queryKey: queryKeys.items(bracketId),
    queryFn: () => bracketService.listItems(bracketId),
  });

  if (!items || items.length < 2) return null;
  const rounds = totalRoundsFor(items.length);
  const pairings = generateFirstRound(items);

  return (
    <section className="arena-panel p-6">
      <h2 className="text-stencil text-xl">Preview structure</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {rounds} round{rounds === 1 ? "" : "s"} · first round is{" "}
        {roundLabel(1, rounds).toLowerCase()}
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        {pairings.map((pair, index) => (
          <li key={index} className="rounded border border-border bg-secondary/30 px-4 py-2">
            {pair.b ? (
              <>
                <span className="font-semibold">{pair.a.title}</span> vs{" "}
                <span className="font-semibold">{pair.b.title}</span>
              </>
            ) : (
              <>
                <span className="font-semibold">{pair.a.title}</span>{" "}
                <span className="text-muted-foreground">advances on a bye</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
