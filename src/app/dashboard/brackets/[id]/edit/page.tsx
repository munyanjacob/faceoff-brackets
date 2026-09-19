import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { AddItemForm } from "./add-item-form";
import { ItemRow } from "./item-row";
import { RoundDurationForm } from "./round-duration-form";
import { ScheduledStartForm } from "./scheduled-start-form";
import {
  computeTotalRounds,
  parseStoredRoundDurationOverrides,
} from "./round-duration";

/**
 * `/dashboard/brackets/[id]/edit` - a draft bracket's item list (issue
 * #11), its round-duration configuration (issue #13), and its immediate-
 * vs-scheduled start time (issue #14), replacing the #10 placeholder that
 * used to live here. #12 still builds the rest of the editor (image
 * upload) on this same route.
 *
 * Still does a real ownership-scoped lookup (rather than trusting the URL's
 * `id` outright) per the Next.js Server Actions/Server Components security
 * guidance: derive identity from the session and look up by ownership, not
 * by an unchecked id from the request. A bracket that doesn't exist, or
 * isn't this signed-in creator's, 404s instead of leaking another
 * creator's title or items.
 *
 * Items are queried scoped to `bracket.id` (never just trusted from
 * elsewhere), so a creator only ever sees/edits their own bracket's items.
 * Add/edit/remove controls (`<AddItemForm>`/`<ItemRow>`) are only usable
 * while `Bracket.status === "DRAFT"` - `isDraft` is threaded down so
 * `<ItemRow>` renders read-only, and the add form is swapped for a plain
 * message once the bracket is no longer a draft.
 */
export default async function EditBracketPage({
  params,
}: PageProps<"/dashboard/brackets/[id]/edit">) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The layout guard (#6) already redirects signed-out visitors before this
  // ever renders; this is just a type-narrowing guard for the (unreachable
  // in practice) case, not a second auth check.
  if (!user) {
    return null;
  }

  const bracket = await prisma.bracket.findFirst({
    where: { id, creatorId: user.id },
  });

  if (!bracket) {
    notFound();
  }

  const items = await prisma.bracketItem.findMany({
    where: { bracketId: bracket.id },
    orderBy: { createdAt: "asc" },
  });

  const isDraft = bracket.status === "DRAFT";
  const totalRounds = computeTotalRounds(items.length);
  const roundDurationOverrides = parseStoredRoundDurationOverrides(
    bracket.roundDurationOverrides
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">
        Editing &quot;{bracket.title}&quot;
      </h1>
      <p>#12 builds the rest of the real editor (image upload) here.</p>

      {isDraft ? (
        <RoundDurationForm
          bracketId={bracket.id}
          defaultRoundDurationMinutes={bracket.defaultRoundDurationMinutes}
          overrides={roundDurationOverrides}
          totalRounds={totalRounds}
        />
      ) : (
        <p>
          This bracket is no longer a draft, so its round duration can&apos;t
          be changed.
        </p>
      )}

      {isDraft ? (
        <ScheduledStartForm
          bracketId={bracket.id}
          scheduledStartAt={bracket.scheduledStartAt}
        />
      ) : (
        <p>
          This bracket is no longer a draft, so its start time can&apos;t be
          changed.
        </p>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Items</h2>

        {items.length === 0 ? (
          <p>No items yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id}>
                <ItemRow
                  bracketId={bracket.id}
                  item={{
                    id: item.id,
                    title: item.title,
                    description: item.description,
                  }}
                  isDraft={isDraft}
                />
              </li>
            ))}
          </ul>
        )}

        {isDraft ? (
          <AddItemForm bracketId={bracket.id} />
        ) : (
          <p>
            This bracket is no longer a draft, so items can&apos;t be added,
            edited, or removed.
          </p>
        )}
      </section>
    </div>
  );
}
