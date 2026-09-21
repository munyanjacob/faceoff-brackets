import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Creates a Supabase client for use on the server (Server Components and
 * Server Actions), reading/writing the session via the request's cookies.
 *
 * Must be called fresh for each request — never share a client across
 * requests. `next/headers`'s `cookies()` is async in this Next.js version.
 *
 * Server Components cannot set cookies (only read them); `setAll` is
 * wrapped in a try/catch so calling this from a Server Component doesn't
 * throw. When that happens, session refresh must be handled by `src/proxy.ts`
 * instead, per the `@supabase/ssr` docs.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — cookies can't be set here.
            // Ignorable as long as src/proxy.ts refreshes the session.
          }
        },
      },
    }
  );
}
