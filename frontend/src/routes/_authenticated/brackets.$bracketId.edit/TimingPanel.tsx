import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bracketService, type BracketDetail } from "@/services";
import { totalRoundsFor, roundLabel } from "@/lib/bracket-logic";
import { queryKeys } from "@/lib/queryKeys";
import { useAsyncAction } from "@/hooks/useAsyncAction";

export function TimingPanel({ bracket }: { bracket: BracketDetail }) {
  const queryClient = useQueryClient();
  const [defaultMinutes, setDefaultMinutes] = useState(String(bracket.defaultRoundDurationMinutes));
  const [overrides, setOverrides] = useState<Record<string, number>>(
    bracket.roundDurationOverrides ?? {},
  );
  const [startMode, setStartMode] = useState<"immediate" | "scheduled">(
    bracket.scheduledStartAt ? "scheduled" : "immediate",
  );
  const [startAt, setStartAt] = useState(
    bracket.scheduledStartAt ? bracket.scheduledStartAt.slice(0, 16) : "",
  );
  const [message, setMessage] = useState<string | null>(null);
  const { error, run } = useAsyncAction();

  const { data: items } = useQuery({
    queryKey: queryKeys.items(bracket.id),
    queryFn: () => bracketService.listItems(bracket.id),
  });
  const rounds = totalRoundsFor(items?.length ?? 0);

  useEffect(() => {
    setOverrides(bracket.roundDurationOverrides ?? {});
  }, [bracket.roundDurationOverrides]);

  async function save() {
    setMessage(null);
    await run(async () => {
      await bracketService.updateRoundDuration(bracket.id, {
        defaultRoundDurationMinutes: Number(defaultMinutes),
        overrides,
      });
      await bracketService.updateSchedule(bracket.id, {
        startMode,
        scheduledStartAt:
          startMode === "scheduled" && startAt ? new Date(startAt).toISOString() : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.bracket(bracket.id) });
      setMessage("Timing saved.");
    });
  }

  return (
    <section className="arena-panel space-y-5 p-6">
      <div>
        <h2 className="text-stencil text-xl">Timing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each round closes automatically when its clock runs out.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default-minutes">Default round length (minutes)</Label>
        <Input
          id="default-minutes"
          type="number"
          min={1}
          value={defaultMinutes}
          onChange={(e) => setDefaultMinutes(e.target.value)}
          className="max-w-40"
        />
      </div>

      {rounds > 0 && (
        <div className="space-y-2">
          <Label>Per-round overrides</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: rounds }, (_, i) => i + 1).map((roundNumber) => (
              <div key={roundNumber} className="flex items-center gap-3">
                <span className="w-28 text-sm text-muted-foreground">
                  {roundLabel(roundNumber, rounds)}
                </span>
                <Input
                  type="number"
                  min={1}
                  placeholder={defaultMinutes}
                  value={overrides[String(roundNumber)] ?? ""}
                  onChange={(e) => {
                    const next = { ...overrides };
                    if (e.target.value === "") delete next[String(roundNumber)];
                    else next[String(roundNumber)] = Number(e.target.value);
                    setOverrides(next);
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <Label>Start</Label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={startMode === "immediate" ? "default" : "outline"}
            size="sm"
            onClick={() => setStartMode("immediate")}
          >
            As soon as I publish
          </Button>
          <Button
            type="button"
            variant={startMode === "scheduled" ? "default" : "outline"}
            size="sm"
            onClick={() => setStartMode("scheduled")}
          >
            At a set time
          </Button>
        </div>
        {startMode === "scheduled" && (
          <Input
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            className="max-w-64"
          />
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}
      <Button onClick={save} variant="outline">
        Save timing
      </Button>
    </section>
  );
}
