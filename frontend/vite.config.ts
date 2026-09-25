import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// Hosting target: Vercel — see docs/frontend-rework-specification.md §9.5 for why.
// Nitro's `vercel` preset (built into the `nitro` package already listed in
// devDependencies) compiles the SSR server for Vercel's Build Output API;
// no additional deploy-target package is required.
//
// FRONTEND_SPA_BUILD=true switches to TanStack Start's SPA mode instead: the
// build prerenders a single `_shell.html` alongside the hashed client assets
// (under `.vercel/output/static/`), so the whole UI can be served as plain
// static files by backend/ - this is what the repo-root Dockerfile does.
// The app has no server functions, so nothing is lost by skipping SSR there.
const spaBuild = process.env.FRONTEND_SPA_BUILD === "true";

export default defineConfig({
  css: {
    // @tailwindcss/vite (below) compiles Tailwind directly and needs no
    // PostCSS plugins of its own. Without this, Vite's PostCSS config
    // search walks up past frontend/ and picks up the repo-root
    // postcss.config.mjs (the Next.js backend's own config, which
    // references @tailwindcss/postcss — not installed under
    // frontend/node_modules). Pinning an empty inline config here scopes
    // PostCSS resolution to this project and skips that upward search.
    postcss: {},
  },
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
      spa: { enabled: spaBuild },
    }),
    nitro({ preset: "vercel" }),
    viteReact(),
  ],
});
