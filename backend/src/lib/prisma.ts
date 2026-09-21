import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * The app's single shared Prisma client (issue #8 permits creating exactly
 * one of these, since nothing under `src/lib/` queried Prisma before now).
 *
 * Prisma 7's generated client throws in its own constructor unless given a
 * driver adapter - see the issue #8 comment for what was tried and ruled
 * out. `@prisma/adapter-pg` (approved for this issue) is the adapter for a
 * plain Postgres/Supabase connection, pointed at the pooled `DATABASE_URL`
 * (not `DIRECT_URL`, which is reserved for `prisma migrate`/`prisma studio`
 * via `prisma7.config.ts` - see that file's comment on why Migrate bypasses
 * Supabase's pooler).
 *
 * Cached on `globalThis` in development so Next.js's hot-reloading doesn't
 * spin up a new pooled connection (and adapter/client instance) on every
 * edit - the standard Prisma-with-Next.js singleton pattern. Not needed in
 * production, where the module is only ever evaluated once per process.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
