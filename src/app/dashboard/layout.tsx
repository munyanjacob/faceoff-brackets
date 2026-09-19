import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "./actions";

/**
 * Shared layout for everything under `/dashboard`.
 *
 * This is the one place the signed-in/signed-out check lives for the whole
 * `/dashboard` subtree - individual pages (starting with the placeholder
 * `page.tsx` here, and whatever #8 replaces it with) don't repeat it.
 * Deliberately not handled in `src/proxy.ts`: its matcher runs on nearly
 * every route, so an auth redirect there would risk also gating `/`,
 * `/login`, and `/signup`.
 */
export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <span className="font-semibold">Dashboard</span>
        <form action={logout}>
          <button type="submit">Log out</button>
        </form>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
