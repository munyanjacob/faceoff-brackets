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
    // Load .env.local (and friends) into process.env for tests, the same
    // way Next.js does for the app, so tests can talk to the real Supabase
    // project configured there (e.g. the getUser() check in
    // src/lib/supabase/get-user.signed-out.test.ts).
    env: loadEnv(mode, process.cwd(), ""),
    // Parallel-agent git worktrees live under .worktrees/ (see
    // .gitignore) as separate checkouts of other branches, each with its
    // own dependencies/modules. Without this exclude, running tests from
    // this checkout recurses into them and fails on imports that don't
    // exist on this branch.
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
}));
