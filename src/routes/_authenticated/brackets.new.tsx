import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bracketService, toServiceError, type Visibility, type VotingRequirement } from "@/services";

export const Route = createFileRoute("/_authenticated/brackets/new")({
  head: () => ({
    meta: [
      { title: "New bracket — Bracket Arena" },
      { name: "description", content: "Start a new head-to-head voting bracket." },
      { property: "og:title", content: "New bracket — Bracket Arena" },
      { property: "og:description", content: "Start a new head-to-head voting bracket." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NewBracket,
});

function Choice({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-4 text-left transition-colors ${
        active ? "border-primary bg-primary/10" : "border-border bg-secondary/40 hover:bg-secondary"
      }`}
    >
      <span className="block font-semibold">{title}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{body}</span>
    </button>
  );
}

function NewBracket() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("PUBLIC");
  const [votingRequirement, setVotingRequirement] =
    useState<VotingRequirement>("ANONYMOUS_ALLOWED");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const bracket = await bracketService.create({
        title,
        description: description || undefined,
        visibility,
        votingRequirement,
      });
      await queryClient.invalidateQueries({ queryKey: ["my-brackets"] });
      navigate({ to: "/brackets/$bracketId/edit", params: { bracketId: bracket.id } });
    } catch (caught) {
      setError(toServiceError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10">
      <p className="label-kicker">Step one</p>
      <h1 className="text-stencil mt-3 text-4xl">New bracket</h1>

      <form onSubmit={submit} className="arena-panel mt-8 space-y-6 p-6">
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">Description (optional)</Label>
          <Textarea
            id="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-3">
          <Label>Visibility</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              active={visibility === "PUBLIC"}
              onClick={() => setVisibility("PUBLIC")}
              title="Public"
              body="Listed on Discover for anyone to find."
            />
            <Choice
              active={visibility === "PRIVATE"}
              onClick={() => setVisibility("PRIVATE")}
              title="Private"
              body="Only reachable by direct link."
            />
          </div>
        </div>

        <div className="space-y-3">
          <Label>Who can vote</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              active={votingRequirement === "ANONYMOUS_ALLOWED"}
              onClick={() => setVotingRequirement("ANONYMOUS_ALLOWED")}
              title="Anyone"
              body="No account needed — one vote per device."
            />
            <Choice
              active={votingRequirement === "ACCOUNT_REQUIRED"}
              onClick={() => setVotingRequirement("ACCOUNT_REQUIRED")}
              title="Account required"
              body="Voters must sign in first."
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create draft"}
        </Button>
      </form>
    </div>
  );
}
