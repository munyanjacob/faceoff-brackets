import type { NextConfig } from "next";

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
};

export default nextConfig;
