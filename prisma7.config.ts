// Prisma 7 no longer auto-loads .env files, and this project keeps its real
// env vars in .env.local (not .env) per _docs/architecture.md. Load it
// explicitly with Node's built-in loader so `prisma migrate dev`, `prisma
// migrate status`, and `prisma studio` can resolve DATABASE_URL/DIRECT_URL
// from schema.prisma's datasource block without adding a dotenv dependency.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is gitignored and may not exist in CI; commands relying on
  // it will fail with a clear "env var not found" error instead.
}

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Migrate/Studio must bypass Supabase's connection pooler (PgBouncer can't
  // run DDL/advisory locks), so this points at DIRECT_URL rather than the
  // pooled DATABASE_URL the app will use at runtime via a driver adapter.
  // This installed Prisma version's config schema has no separate
  // `directUrl` field (only `url`/`shadowDatabaseUrl`), so a single direct
  // URL is all that's configurable here.
  //
  // Read directly off process.env (not the `env()` helper from
  // "prisma/config") so `prisma generate` still works without .env.local
  // present (e.g. a fresh clone/CI) - `env()` throws immediately if the var
  // is unset, which would break `generate` too, even though it never needs a
  // database connection.
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
