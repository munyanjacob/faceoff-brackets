"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Server Action backing the "Log out" control in `src/app/dashboard/layout.tsx`.
 * Uses the server-side Supabase client (`src/lib/supabase/server.ts`) so the
 * session cookie is cleared on the response, matching the Server Action
 * pattern used by `src/app/login/actions.ts` and `src/app/signup/actions.ts`.
 */
export async function logout(): Promise<void> {
  const supabase = await createClient();

  // signOut() succeeds (no thrown error) even when there's no session to
  // clear - e.g. a stale tab, a double submit, or an already-expired
  // session - so there's nothing to branch on here. Either way the visitor
  // ends up signed out and redirected to /login.
  await supabase.auth.signOut();

  // Deliberately outside any try/catch: redirect() works by throwing, and a
  // surrounding catch would swallow the navigation.
  redirect("/login");
}
