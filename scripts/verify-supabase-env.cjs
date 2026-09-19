// One-off Supabase credential check for issue #2 (not wired into the app or its dependencies).
// pg isn't a project dependency; run with: npx -y -p pg node --env-file=.env.local scripts/verify-supabase-env.cjs
const pg = require("pg");

const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "DIRECT_URL",
  "CRON_SECRET",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let ok = true;

async function checkAuthHealth() {
  const res = await fetch(`${url}/auth/v1/health`, {
    headers: { apikey: anonKey },
  });
  console.log(`auth/v1/health -> ${res.status}`);
  if (!res.ok) ok = false;
}

async function checkStorageBuckets() {
  const res = await fetch(`${url}/storage/v1/bucket`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await res.text();
  console.log(`storage/v1/bucket -> ${res.status} ${body.slice(0, 200)}`);
  if (!res.ok) ok = false;
}

async function checkPg(label, connectionString) {
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const result = await client.query("select 1 as ok");
    console.log(`${label} -> connected, select 1 = ${result.rows[0].ok}`);
  } catch (err) {
    console.log(`${label} -> FAILED: ${err.message}`);
    ok = false;
  } finally {
    await client.end().catch(() => {});
  }
}

(async () => {
  await checkAuthHealth();
  await checkStorageBuckets();
  await checkPg("DATABASE_URL", process.env.DATABASE_URL);
  await checkPg("DIRECT_URL", process.env.DIRECT_URL);

  if (!ok) {
    console.error("\nOne or more checks failed.");
    process.exit(1);
  }
  console.log("\nAll credential checks passed.");
})();
