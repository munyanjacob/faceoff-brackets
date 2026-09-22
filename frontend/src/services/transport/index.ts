import { supabase } from "@/integrations/supabase/client";
import { createHttpTransport } from "./httpTransport";
import { createMockTransport } from "./mockTransport";
import type { ApiTransport, Caller } from "./types";

const baseUrl = import.meta.env["VITE_API_BASE_URL"] as string | undefined;

/** Resolves the caller from the Supabase session (the only auth source, §6). */
async function getCaller(): Promise<Caller | null> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return null;
  return {
    userId: session.user.id,
    email: session.user.email ?? "",
    displayName:
      (session.user.user_metadata?.["display_name"] as string | undefined) ??
      session.user.email ??
      null,
    accessToken: session.access_token,
  };
}

/**
 * The single backend entry point for the whole app.
 *
 * Set VITE_API_BASE_URL (see frontend/.env.example) to talk to the real
 * backend/ REST API via httpTransport.ts. Leave it unset to fall back to
 * mockTransport.ts's in-browser stand-in - kept, deliberately, as an
 * opt-in dev/demo fallback rather than deleted now that the real backend
 * exists (issue #61; see docs/frontend-rework-specification.md §9.7).
 */
export const transport: ApiTransport = baseUrl
  ? createHttpTransport(baseUrl, getCaller)
  : createMockTransport(getCaller);

export const usingLiveBackend = Boolean(baseUrl);
