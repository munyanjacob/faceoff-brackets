import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { BracketList } from "./bracket-list";
import { toBracketRow } from "./bracket-view-model";

/**
 * `/dashboard` - the signed-in creator's own brackets, newest first, or an
 * explicit empty-state message when they have none yet (issue #8).
 *
 * The signed-in/signed-out check itself lives in `./layout.tsx` (#6) - by
 * the time this component renders, `supabase.auth.getUser()` is guaranteed
 * to resolve with a user, since the layout already redirected to `/login`
 * otherwise. It's called again here (rather than threading the id down)
 * because Server Components have no other way to receive data from a
 * parent layout.
 *
 * `creatorId` scopes the query to the signed-in user's own `Profile.id`
 * (the Supabase auth user id - see #7's sync trigger), so a visitor only
 * ever sees their own brackets, never another creator's. `rounds` is
 * selected (not the full relation) since `toBracketRow`/
 * `currentRoundNumber` only need each round's `roundNumber`.
 */
export default async function DashboardPage() {
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

  const brackets = await prisma.bracket.findMany({
    where: { creatorId: user.id },
    orderBy: { createdAt: "desc" },
    include: { rounds: { select: { roundNumber: true } } },
  });

  // Called directly as a plain function, not as a `<BracketList ... />`
  // JSX element - this codebase's tests (e.g. `./bracket-list.test.tsx`)
  // introspect a component's return value via `JSON.stringify`, which
  // cannot see into an unrendered child element (its `type` is a function
  // reference, dropped by `JSON.stringify`). Calling it directly resolves
  // it inline, and is otherwise equivalent for React.
  return BracketList({ brackets: brackets.map(toBracketRow) });
}
