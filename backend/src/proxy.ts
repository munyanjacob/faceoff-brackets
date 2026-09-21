import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every matched request.
 *
 * Supabase access tokens are short-lived; without this, a Server Component
 * reading an expired token via `src/lib/supabase/server.ts` would see the
 * user as signed out until something happened to trigger a refresh. Proxy
 * runs ahead of rendering on every navigation, so it's the place to do that
 * refresh and write the (possibly updated) session back onto both the
 * request, so downstream server code sees it this pass, and the response,
 * so the browser stores it.
 *
 * Next.js 16 renamed the `middleware.ts` file convention (and its exported
 * `middleware` function) to `proxy.ts`/`proxy`; this file uses the current
 * convention.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refreshes the session if it's expired, and writes the refreshed
  // tokens back via `setAll` above. Do not remove this call — it's what
  // keeps sessions alive across requests.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
