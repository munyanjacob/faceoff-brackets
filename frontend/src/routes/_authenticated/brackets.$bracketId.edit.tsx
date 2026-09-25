import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import { bracketService, toServiceError } from "@/services";
import { pageMeta } from "@/lib/pageMeta";
import { queryKeys } from "@/lib/queryKeys";
import { ItemsPanel } from "./brackets.$bracketId.edit/ItemsPanel";
import { StructurePreview } from "./brackets.$bracketId.edit/StructurePreview";
import { TimingPanel } from "./brackets.$bracketId.edit/TimingPanel";

export const Route = createFileRoute("/_authenticated/brackets/$bracketId/edit")({
  head: () => ({
    meta: pageMeta({
      title: "Edit bracket — Bracket Arena",
      description:
        "Add contenders, set round timers, choose a start time, and publish your bracket.",
      ogDescription: "Add contenders, set round timers, choose a start time, and publish.",
    }),
  }),
  component: EditBracket,
});

function EditBracket() {
  const { bracketId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [publishError, setPublishError] = useState<string | null>(null);

  const { data: bracket, isLoading } = useQuery({
    queryKey: queryKeys.bracket(bracketId),
    queryFn: () => bracketService.get(bracketId),
  });

  const publish = useMutation({
    mutationFn: () => bracketService.publish(bracketId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.myBrackets() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.discover() });
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
