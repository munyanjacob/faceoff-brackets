import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bracketService, type BracketItem } from "@/services";
import { queryKeys } from "@/lib/queryKeys";
import { useAsyncAction } from "@/hooks/useAsyncAction";

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
  const { busy, error, run } = useAsyncAction();

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        await run(async () => {
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
        });
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

export function ItemsPanel({ bracketId, locked }: { bracketId: string; locked: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const { error, run } = useAsyncAction();

  const { data: items } = useQuery({
    queryKey: queryKeys.items(bracketId),
    queryFn: () => bracketService.listItems(bracketId),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.items(bracketId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.bracket(bracketId) }),
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
                    onClick={() =>
                      run(async () => {
                        await bracketService.removeItem(bracketId, item.id);
                        await refresh();
                      })
                    }
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
