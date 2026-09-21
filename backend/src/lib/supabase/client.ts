import { createBrowserClient } from "@supabase/ssr";

/**
 * Creates a Supabase client for use in the browser (Client Components).
 *
 * Session state is persisted via cookies (not localStorage) so that
 * server-rendered requests can read the same session. Create a new client
 * per component/module that needs one; `@supabase/ssr` deduplicates the
 * underlying client via `isSingleton` by default.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
