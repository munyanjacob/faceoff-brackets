import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Reads `process.env[name]`, throwing a clear error instead of returning
 * `undefined` when it's unset or empty.
 *
 * Used in place of a non-null assertion (`process.env.FOO!`) at every
 * Supabase client construction site, so a missing env var in a given
 * deploy fails fast with a message that names the var, rather than
 * surfacing later as a cryptic error deep inside the Supabase SDK (e.g.
 * "supabaseUrl is required").
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The Supabase project URL, shared by every client below. */
export function getSupabaseUrl(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_URL");
}

/** The public anon key - safe to expose to the browser. */
export function getSupabaseAnonKey(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * The service-role key - bypasses Row Level Security. Server-only; never
 * expose this to the browser or use it to handle untrusted input directly.
 */
export function getSupabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Builds a plain `@supabase/supabase-js` client authenticated with the anon
 * key - for callers that don't need `@supabase/ssr`'s cookie-bound session
 * handling (e.g. verifying a caller-supplied bearer token directly).
 */
export function createSupabaseAnonClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey());
}

/**
 * Builds a plain `@supabase/supabase-js` client authenticated with the
 * service-role key, which bypasses Storage/Postgres Row Level Security.
 * Server-only - never call this from code that runs in the browser.
 */
export function createSupabaseServiceRoleClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey());
}
