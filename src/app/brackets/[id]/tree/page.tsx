import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BracketTree } from "./bracket-tree";
import { buildBracketTree } from "./bracket-tree-view-model";

/**
 * `/brackets/[id]/tree` - the full bracket-tree view (issue #30).
 *
 * Issue #40 turned `/brackets/[id]` into a routing layer that either
 * redirects straight into a single live matchup or shows a lightweight
 * index of several - it no longer renders any page content of its own in
 * the common case, so there's nowhere left on that route for "the whole
 * tournament tree" to live. This route is that place instead: unlike
 * `/brackets/[id]`, it always renders (a message, or the tree), regardless
 * of `Bracket.status` - draft/scheduled/active/completed all resolve to
 * *something* sensible here rather than a redirect or a 404-if-no-active-
 * round.
 *
 * Looks the bracket up by `id` alone, same as `../page.tsx` - 404s via
 * `notFound()` when it doesn't exist.
 *
 * Fetches *every* round (not just the `ACTIVE` one `../page.tsx` cares
 * about), ordered oldest-first, each round's matchups ordered by
 * `itemA.createdAt` ascending - the same bracket-order convention
 * `@/lib/rounds/evaluate-round.ts` reads/writes rounds in (see that file's
 * top comment), so this tree's top-to-bottom order within a column is
 * consistent round over round. A `DRAFT` bracket has no rounds at all yet
 * (round 1 is only created at publish time - #18) - `buildBracketTree`
 * turns that empty list into an explicit "not published yet" message
 * rather than an empty/broken-looking tree.
 */
export default async function BracketTreePage({
  params,
}: PageProps<"/brackets/[id]/tree">) {
  const { id } = await params;

  const bracket = await prisma.bracket.findUnique({
    where: { id },
    include: {
      rounds: {
        orderBy: { roundNumber: "asc" },
        include: {
          matchups: {
            orderBy: { itemA: { createdAt: "asc" } },
            include: { itemA: true, itemB: true },
          },
        },
      },
    },
  });

  if (!bracket) {
    notFound();
  }

  const treeState = buildBracketTree(bracket.rounds);

  // Called directly as a plain function, not as a `<BracketTree ... />` JSX
  // element - same reasoning as every other page/presentational split in
  // this codebase (see e.g. `../matchup-voting.tsx`'s top comment): this
  // codebase's page tests introspect the return value via
  // `JSON.stringify`, which can't see into an unrendered child element.
  return BracketTree({ bracketTitle: bracket.title, bracketId: id, treeState });
}
