import { connection } from "next/server";
import { prisma } from "@/lib/prisma";
import { DiscoveryGroups } from "./discovery-groups";
import { groupPublicBrackets } from "./discovery-view-model";

/**
 * `/discover` - the public discovery page (issue #34). Deliberately has no
 * auth check of any kind (no `createClient()`/`supabase.auth.getUser()`
 * call, unlike `../dashboard/page.tsx`): this route must be reachable by
 * anyone, signed in or not.
 *
 * This project's Next.js version renamed `middleware.ts` to `src/proxy.ts`
 * (see that file's own comment). Its matcher runs on nearly every path,
 * including `/discover`, but it only refreshes the Supabase session and
 * always falls through with `NextResponse.next()` - it never redirects.
 * The only auth *redirect* in this codebase lives in
 * `../dashboard/layout.tsx` (#6), which wraps just the `/dashboard`
 * subtree, so `/discover` isn't at risk of an accidental auth redirect
 * from either file.
 *
 * The `where` clause is the first (query-level) layer of the PUBLIC-only/
 * no-DRAFT rule; `groupPublicBrackets` re-enforces the same rule in pure,
 * unit-tested code (see its own comment for why). `orderBy: publishedAt
 * desc` is the "simple recency" ordering the issue asks for, applied
 * uniformly so each group is newest-published-first.
 */
export default async function DiscoverPage() {
  // Nothing else here reads the request, so without this Next prerenders
  // the page at build time - querying the database from `next build` (which
  // fails in the Docker build, with no database reachable) and freezing the
  // list at that snapshot. See node_modules/next/dist/docs/.../connection.md.
  await connection();

  const brackets = await prisma.bracket.findMany({
    where: {
      visibility: "PUBLIC",
      status: { in: ["SCHEDULED", "ACTIVE", "COMPLETED"] },
    },
    orderBy: { publishedAt: "desc" },
    include: { creator: { select: { displayName: true } } },
  });

  const groups = groupPublicBrackets(brackets);

  // Called directly as a plain function, not as a `<DiscoveryGroups ... />`
  // JSX element - same reasoning as `../dashboard/page.tsx`: this
  // codebase's page tests introspect the return value via
  // `JSON.stringify`, which can't see into an unrendered child element.
  return DiscoveryGroups({ groups });
}
