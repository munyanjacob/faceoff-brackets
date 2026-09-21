import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { groupPublicBrackets } from "@/app/discover/discovery-view-model";
import { preflightResponse, withCors } from "@/lib/api/cors";
import { withErrorHandling } from "@/lib/api/errors";

// GET /api/discover
//
// Public bracket discovery (issue #58, docs/openapi.yaml `/discover`). No
// authentication of any kind - same reasoning as
// `../../discover/page.tsx`'s own comment on why it has no
// `getAuthenticatedUserId`/`createClient()` call: this must be reachable
// by anyone, signed in or not, so unlike the creator-only endpoints (#51
// etc.) there is no auth gate here at all.
//
// Reuses `../../discover/discovery-view-model.ts`'s `groupPublicBrackets`
// for the actual PUBLIC-only/no-DRAFT filtering and Recent/Active/Completed
// bucketing - including the "Recent" = SCHEDULED-only rule (not a general
// recency view across all statuses) and the `creatorName` "A creator"
// fallback - rather than reimplementing any of that here. See that file's
// own comment for the full reasoning behind the status-to-group mapping.
// The Prisma query below (`where`/`orderBy`/`include`) mirrors
// `../../discover/page.tsx`'s exactly, for the same reason.
//
// One deliberate difference from `groupPublicBrackets`'s own row shape:
// its rows carry a *human-formatted* `publishedAt` (`formatPublishedAt`,
// e.g. "September 19, 2026", or "-" for `null`) meant for the HTML page -
// not the raw ISO-8601 timestamp `docs/openapi.yaml`'s
// `DiscoverRow.publishedAt` (`format: date-time, nullable: true`)
// specifies for the wire contract. `toWireRow` below swaps that one field
// back to the raw `Date`/`null` from the original Prisma rows (looked up
// by id - no second query) before the response is serialized, without
// touching the shared grouping/filtering logic itself.

type DiscoverRow = {
  id: string;
  title: string;
  status: string;
  publishedAt: string | null;
  creatorName: string;
};

type DiscoverResponseBody = {
  recent: DiscoverRow[];
  active: DiscoverRow[];
  completed: DiscoverRow[];
};

function toWireRow(
  row: { id: string; title: string; status: string; creatorName: string },
  rawPublishedAtById: Map<string, Date | null>
): DiscoverRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    publishedAt: rawPublishedAtById.get(row.id)?.toISOString() ?? null,
    creatorName: row.creatorName,
  };
}

async function handleGet(): Promise<Response> {
  const brackets = await prisma.bracket.findMany({
    where: {
      visibility: "PUBLIC",
      status: { in: ["SCHEDULED", "ACTIVE", "COMPLETED"] },
    },
    orderBy: { publishedAt: "desc" },
    include: { creator: { select: { displayName: true } } },
  });

  const groups = groupPublicBrackets(brackets);
  const rawPublishedAtById = new Map(
    brackets.map((bracket) => [bracket.id, bracket.publishedAt])
  );

  const body: DiscoverResponseBody = {
    recent: groups.recent.map((row) => toWireRow(row, rawPublishedAtById)),
    active: groups.active.map((row) => toWireRow(row, rawPublishedAtById)),
    completed: groups.completed.map((row) =>
      toWireRow(row, rawPublishedAtById)
    ),
  };

  return NextResponse.json(body);
}

const getWithErrorHandling = withErrorHandling(handleGet);

// CORS is applied to every response - success or the generic 500 from
// `withErrorHandling` - per docs/frontend-rework-specification.md §8.5:
// the frontend and backend are separate subdomains (issue #50), so even
// this fully public, unauthenticated endpoint is still a cross-origin
// request from the browser's perspective.
export async function GET(request: Request): Promise<Response> {
  const response = await getWithErrorHandling();
  return withCors(request, response);
}

export function OPTIONS(request: Request): Response {
  return preflightResponse(request);
}
