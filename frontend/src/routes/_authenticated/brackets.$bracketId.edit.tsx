import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/status-pill";
import {
  bracketService,
  toServiceError,
  type BracketDetail,
  type BracketItem,
} from "@/services";
import { generateFirstRound, roundLabel, totalRoundsFor } from "@/lib/bracket-logic";

export const Route = createFileRoute("/_authenticated/brackets/$bracketId/edit")({
  head: () => ({
    meta: [
      { title: "Edit bracket — Bracket Arena" },
      {
        name: "description",
        content: "Add contenders, set round timers, choose a start time, and publish your bracket.",
      },
      { property: "og:title", content: "Edit bracket — Bracket Arena" },
      {
        property: "og:description",
        content: "Add contenders, set round timers, choose a start time, and publish.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EditBracket,
});

function ItemForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: BracketItem;
  submitLabel: string;
  onSubmit: (input: { title: string; description?: string; image?: File }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [image, setImage] = useState<File | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setBusy(true);
        try {
          await onSubmit({
            title,
            description: description || undefined,
            image,
          });
          if (!initial) {
            setTitle("");
            setDescription("");
            setImage(undefined);
          }
        } catch (caught) {
          setError(toServiceError(caught).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        placeholder="Contender name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        rows={2}
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input
        type="file"
        accept="image/*"
        onChange={(e) => setImage(e.target.files?.[0] ?? undefined)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ItemsPanel({ bracketId, locked }: { bracketId: string; locked: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: items } = useQuery({
    queryKey: ["items", bracketId],
    queryFn: () => bracketService.listItems(bracketId),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["items", bracketId] }),
      queryClient.invalidateQueries({ queryKey: ["bracket", bracketId] }),
    ]);

  return (
    <section className="arena-panel p-6">
      <h2 className="text-stencil text-xl">Contenders</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {items ? `${items.length} in the field` : "Loading…"} — at least 2 are needed to publish.
      </p>

      <div className="mt-5 space-y-3">
        {items?.map((item) =>
          editingId === item.id ? (
            <div key={item.id} className="arena-panel p-4">
              <ItemForm
                initial={item}
                submitLabel="Save"
                onCancel={() => setEditingId(null)}
                onSubmit={async (input) => {
                  await bracketService.updateItem(bracketId, item.id, input);
                  await refresh();
                  setEditingId(null);
                }}
              />
            </div>
          ) : (
            <div key={item.id} className="arena-panel flex items-center gap-4 p-4">
              {item.imageUrl && (
                <img
                  src={item.imageUrl}
                  alt={item.title}
                  className="h-14 w-14 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{item.title}</p>
                {item.description && (
                  <p className="truncate text-sm text-muted-foreground">{item.description}</p>
                )}
              </div>
              {!locked && (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(item.id)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      setError(null);
                      try {
                        await bracketService.removeItem(bracketId, item.id);
                        await refresh();
                      } catch (caught) {
                        setError(toServiceError(caught).message);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ),
        )}
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {!locked && (
        <div className="mt-6 rounded-lg border border-dashed border-border p-4">
          <p className="label-kicker mb-3">Add a contender</p>
          <ItemForm
            submitLabel="Add"
            onSubmit={async (input) => {
              await bracketService.addItem(bracketId, input);
              await refresh();
            }}
          />
        </div>
      )}
    </section>
  );
}

function StructurePreview({ bracketId }: { bracketId: string }) {
  const { data: items } = useQuery({
    queryKey: ["items", bracketId],
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

function TimingPanel({ bracket }: { bracket: BracketDetail }) {
  const queryClient = useQueryClient();
  const [defaultMinutes, setDefaultMinutes] = useState(
    String(bracket.defaultRoundDurationMinutes),
  );
  const [overrides, setOverrides] = useState<Record<string, number>>(
    bracket.roundDurationOverrides,
  );
  const [startMode, setStartMode] = useState<"immediate" | "scheduled">(
    bracket.scheduledStartAt ? "scheduled" : "immediate",
  );
  const [startAt, setStartAt] = useState(
    bracket.scheduledStartAt ? bracket.scheduledStartAt.slice(0, 16) : "",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: items } = useQuery({
    queryKey: ["items", bracket.id],
    queryFn: () => bracketService.listItems(bracket.id),
  });
  const rounds = totalRoundsFor(items?.length ?? 0);

  useEffect(() => {
    setOverrides(bracket.roundDurationOverrides);
  }, [bracket.roundDurationOverrides]);

  async function save() {
    setError(null);
    setMessage(null);
    try {
      await bracketService.updateRoundDuration(bracket.id, {
        defaultRoundDurationMinutes: Number(defaultMinutes),
        overrides,
      });
      await bracketService.updateSchedule(bracket.id, {
        startMode,
        scheduledStartAt:
          startMode === "scheduled" && startAt ? new Date(startAt).toISOString() : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ["bracket", bracket.id] });
      setMessage("Timing saved.");
    } catch (caught) {
      setError(toServiceError(caught).message);
    }
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

function EditBracket() {
  const { bracketId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [publishError, setPublishError] = useState<string | null>(null);

  const { data: bracket, isLoading } = useQuery({
    queryKey: ["bracket", bracketId],
    queryFn: () => bracketService.get(bracketId),
  });

  const publish = useMutation({
    mutationFn: () => bracketService.publish(bracketId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["my-brackets"] });
      await queryClient.invalidateQueries({ queryKey: ["discover"] });
      navigate({ to: "/brackets/$bracketId", params: { bracketId } });
    },
    onError: (caught) => setPublishError(toServiceError(caught).message),
  });

  if (isLoading) {
    return <p className="mx-auto max-w-4xl px-4 pt-10 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!bracket) {
    return (
      <p className="mx-auto max-w-4xl px-4 pt-10 text-sm text-muted-foreground">
        This bracket could not be found.
      </p>
    );
  }

  const locked = bracket.status === "ACTIVE" || bracket.status === "COMPLETED";

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 pb-24 pt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="label-kicker">Creator desk</p>
          <h1 className="text-stencil mt-3 text-4xl">{bracket.title}</h1>
          {bracket.description && (
            <p className="mt-2 max-w-xl text-muted-foreground">{bracket.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={bracket.status} />
          <Link to="/brackets/$bracketId" params={{ bracketId }}>
            <Button variant="outline" size="sm">
              View public page
            </Button>
          </Link>
        </div>
      </div>

      <ItemsPanel bracketId={bracketId} locked={locked} />
      <StructurePreview bracketId={bracketId} />
      {!locked && <TimingPanel bracket={bracket} />}

      {bracket.status === "DRAFT" && (
        <section className="arena-panel p-6">
          <h2 className="text-stencil text-xl">Publish</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Publishing locks the field and builds the bracket. This can't be undone.
          </p>
          {publishError && <p className="mt-3 text-sm text-destructive">{publishError}</p>}
          <Button
            className="arena-glow mt-4"
            disabled={publish.isPending}
            onClick={() => {
              setPublishError(null);
              publish.mutate();
            }}
          >
            {publish.isPending ? "Publishing…" : "Publish bracket"}
          </Button>
        </section>
      )}
    </div>
  );
}
