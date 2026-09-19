// GET /api/cron/advance-rounds
//
// Invoked on a schedule by Vercel Cron (see vercel.json), which always
// calls scheduled routes with GET. Authenticates the caller against the
// CRON_SECRET environment variable via a bearer token.
//
// Intentionally a no-op for now: this scaffolds the authenticated
// endpoint only. Finding expired rounds and actually advancing them is
// wired up in #27.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json({ ok: true });
}
