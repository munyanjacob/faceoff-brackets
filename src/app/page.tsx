import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * `/` (issue #43) - no landing page of its own; it just routes a visitor to
 * where they belong. Signed in -> `/dashboard`, signed out (or no session)
 * -> `/discover`, the public discovery page. Always redirects, so nothing
 * ever actually renders here.
 *
 * Same shape as the signed-in/signed-out check in `./login/page.tsx` and
 * `./dashboard/layout.tsx`: a fresh `createClient()` + `supabase.auth.getUser()`
 * call, then `redirect()`. Deliberately not handled in `src/proxy.ts` - its
 * matcher runs on nearly every route, so a redirect there would risk also
 * gating `/login` and `/signup` (see `src/proxy.ts`'s own comment).
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/discover");
}
