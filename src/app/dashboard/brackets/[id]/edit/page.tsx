import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

/**
 * `/dashboard/brackets/[id]/edit` - placeholder landing page for a newly
 * created draft (issue #10's Server Action redirects here). #11-#14 build
 * the real editor (items, round durations, start time) on this same route;
 * this issue only needs *a* page here so the redirect has somewhere valid
 * to land.
 *
 * Still does a real ownership-scoped lookup (rather than trusting the URL's
 * `id` outright) per the Next.js Server Actions/Server Components security
 * guidance: derive identity from the session and look up by ownership, not
 * by an unchecked id from the request. A bracket that doesn't exist, or
 * isn't this signed-in creator's, 404s instead of leaking another
 * creator's title.
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

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">Editing &quot;{bracket.title}&quot;</h1>
      <p>
        This is a placeholder page - #11-#14 build the real editor (items,
        round durations, start time) here.
      </p>
    </div>
  );
}
