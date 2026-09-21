/**
 * Pure, framework-agnostic view-model helpers for `/discover`, the public
 * discovery page (issue #34). Kept separate from `page.tsx` and free of any
 * Prisma import - same reasoning as `../dashboard/bracket-view-model.ts` -
 * so the PUBLIC-only/no-DRAFT filtering and the Recent/Active/Completed
 * bucketing can be unit-tested without a database connection.
 *
 * ## What "Recent" means here
 *
 * The issue names exactly three groups - Recent, Active, Completed - and
 * (per grooming/`_docs/outdated/plan.md` SS12) explicitly rules out any
 * ranking/recommendation logic, so "Recent" can't be a second, overlapping
 * "recently published" view across all statuses (that would let a bracket
 * appear in two groups at once, e.g. a just-published ACTIVE bracket
 * showing in both Recent and Active).
 *
 * `Bracket.status` has four values. DRAFT is excluded entirely (never
 * published). That leaves exactly three published statuses - SCHEDULED,
 * ACTIVE, COMPLETED - for exactly three named groups. Unlike #33's own
 * creator-dashboard grouping (which names all four statuses, including a
 * "Scheduled" section), #34 never mentions "Scheduled" - the natural
 * reading is that "Recent" *is* the bucket for a published bracket that
 * hasn't started voting yet, i.e. `status = SCHEDULED`, named "Recent"
 * because these are the brackets most recently made public. This keeps the
 * three groups mutually exclusive and matches "simple recency/status
 * ordering" (each bucket then orders by `publishedAt` descending - see
 * `page.tsx`). Flagged on the issue (see the posted comment) rather than
 * guessed silently, since the issue text doesn't spell this mapping out.
 */

export type DiscoveryBracket = {
  id: string;
  title: string;
  visibility: string;
  status: string;
  publishedAt: Date | null;
  creator: { displayName: string | null };
};

export type DiscoveryRow = {
  id: string;
  title: string;
  status: string;
  publishedAt: string;
  creatorName: string;
};

export type GroupedBrackets = {
  recent: DiscoveryRow[];
  active: DiscoveryRow[];
  completed: DiscoveryRow[];
};

export const DISCOVERY_GROUP_NAMES = ["recent", "active", "completed"] as const;
export type DiscoveryGroupName = (typeof DISCOVERY_GROUP_NAMES)[number];

// The one-to-one mapping described above: every published (non-DRAFT)
// status maps to exactly one group. DRAFT (and anything else unrecognized)
// maps to `undefined` and is dropped in `groupPublicBrackets` below.
const STATUS_TO_GROUP: Record<string, DiscoveryGroupName | undefined> = {
  SCHEDULED: "recent",
  ACTIVE: "active",
  COMPLETED: "completed",
};

/**
 * Formats `publishedAt` for a human to read, not a raw ISO timestamp or
 * `null`. Mirrors `../dashboard/bracket-view-model.ts`'s `formatCreatedAt`.
 */
export function formatPublishedAt(date: Date | null): string {
  if (!date) {
    return "-";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function toDiscoveryRow(bracket: DiscoveryBracket): DiscoveryRow {
  return {
    id: bracket.id,
    title: bracket.title,
    status: bracket.status,
    publishedAt: formatPublishedAt(bracket.publishedAt),
    creatorName: bracket.creator.displayName ?? "A creator",
  };
}

/**
 * Filters a list of brackets down to the ones `/discover` may ever show,
 * and buckets the rest into Recent/Active/Completed.
 *
 * This is the actual PUBLIC-only/no-DRAFT enforcement, done defensively
 * here (not just in the Prisma `where` clause in `page.tsx`) so it's
 * unit-testable without a database and so the rule holds even if the
 * caller's query is ever loosened:
 *
 * - `visibility !== "PUBLIC"` (i.e. PRIVATE) is dropped, in every group.
 * - `status === "DRAFT"` has no entry in `STATUS_TO_GROUP` and is dropped.
 * - Anything else unrecognized is also dropped, rather than guessed into a
 *   bucket.
 *
 * Preserves the input order within each bucket - ordering (by
 * `publishedAt` descending) is the caller's responsibility, same pattern
 * as `../dashboard/bracket-list.tsx`.
 */
export function groupPublicBrackets(brackets: DiscoveryBracket[]): GroupedBrackets {
  const groups: GroupedBrackets = { recent: [], active: [], completed: [] };

  for (const bracket of brackets) {
    if (bracket.visibility !== "PUBLIC") {
      continue;
    }

    const groupName = STATUS_TO_GROUP[bracket.status];
    if (!groupName) {
      continue;
    }

    groups[groupName].push(toDiscoveryRow(bracket));
  }

  return groups;
}
