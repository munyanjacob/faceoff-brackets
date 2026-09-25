import type { NextConfig } from "next";

// SERVE_FRONTEND=true (set by the repo-root Dockerfile at build time) makes
// this app also serve frontend/'s SPA build, copied into public/ - so one
// container hosts both the REST API and the UI on a single origin. Unset
// (local dev, Vercel), none of the settings below apply.
const serveFrontend = process.env.SERVE_FRONTEND === "true";

// Every UI path - anything outside /api/ and /_next/ without a file
// extension (frontend/'s routes are all extensionless: /, /auth, /discover,
// /dashboard, /brackets/<id>/...) - is answered with the SPA shell, which
// then routes client-side. Paths with an extension fall through to public/
// (the hashed /assets/* bundles, favicon.ico, robots.txt).
const spaRewrites = [
  { source: "/((?!api/|_next/)[^.]*)", destination: "/_shell.html" },
];

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Next.js caps Server Action request bodies at 1MB by default (see
      // node_modules/next/dist/docs/01-app/02-guides/server-actions.md).
      // Issue #12's bracket item image upload allows files up to 5MB;
      // 10mb leaves headroom above that (multipart encoding overhead, the
      // title/description fields) so an oversized-but-still-under-10MB file
      // reaches `validation.ts`'s own 5MB check and gets this app's
      // friendly error, rather than Next's generic body-too-large
      // rejection at the framework level.
      bodySizeLimit: "10mb",
    },
  },
  ...(serveFrontend && {
    // Self-contained server bundle for the Docker image (see
    // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md).
    output: "standalone",
    // Type-check the app code only; the test files are Vitest's concern
    // and aren't part of what ships in the image.
    typescript: { tsconfigPath: "tsconfig.build.json" },
    async rewrites() {
      // beforeFiles, not the default afterFiles: this app still has its
      // own server-action-era pages at the same paths (/, /dashboard,
      // /brackets/[id], ...), and those must not shadow the SPA.
      return { beforeFiles: spaRewrites, afterFiles: [], fallback: [] };
    },
    async headers() {
      return [
        {
          // Vite content-hashes everything under /assets/.
          source: "/assets/:path*",
          headers: [
            {
              key: "Cache-Control",
              value: "public, max-age=31536000, immutable",
            },
          ],
        },
        {
          // The shell references the current hashed bundles, so it must be
          // revalidated on every load to pick up a new deploy.
          source: "/((?!api/|_next/)[^.]*)",
          headers: [{ key: "Cache-Control", value: "no-cache" }],
        },
      ];
    },
  }),
};

export default nextConfig;
