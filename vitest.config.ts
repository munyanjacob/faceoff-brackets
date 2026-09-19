import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      // Mirrors tsconfig.json's `@/*` -> `./src/*` path mapping, so
      // unmocked imports of e.g. `@/lib/supabase/server` resolve the same
      // way under Vitest as they do under Next.js.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Inject only the public Supabase vars tests actually need into
    // process.env (e.g. the getUser() check in
    // src/lib/supabase/get-user.signed-out.test.ts), rather than the full
    // contents of .env.local. `loadEnv(mode, cwd, "")` reads everything in
    // the file - including SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL,
    // DIRECT_URL, and CRON_SECRET - so we still call it (nothing else can
    // read .env.local for us without a new dependency) but only forward the
    // two keys below into every test's process.env. A test that needs one
    // of the server-only vars reads it directly from .env.local itself
    // (see src/app/signup/profile-sync.integration.test.ts and its
    // siblings) instead of relying on this global injection (issue #38).
    env: (() => {
      const fullEnv = loadEnv(mode, process.cwd(), "");
      return {
        NEXT_PUBLIC_SUPABASE_URL: fullEnv.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: fullEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      };
    })(),
  },
}));
