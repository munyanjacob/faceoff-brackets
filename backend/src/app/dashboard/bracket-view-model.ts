/**
 * Pure, framework-agnostic view-model helpers for the dashboard's bracket
 * list (issue #8). Kept separate from `page.tsx` and free of any Prisma
 * import so the "current round number" rule and the human-readable date
 * formatting can be unit-tested without a database connection - and so they
 * are ready to wire straight into the live query once
 * `src/lib/prisma.ts` exists (see the blocker noted in `page.tsx` and in
 * the issue #8 comment).
 */

export type BracketRow = {
  id: string;
  title: string;
  status: string;
  currentRoundNumber: number | "-";
  createdAt: string;
};

// The minimal shape this needs from a Prisma `Bracket` (with its `rounds`
// relation loaded). Kept structural, rather than importing the generated
// Prisma model type, so this file has no dependency on
// `src/generated/prisma` and stays usable no matter how the live query ends
// up being wired.
export type BracketWithRounds = {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  rounds: { roundNumber: number }[];
};

/**
 * Per grooming: "current round number" for a bracket is the highest
 * `roundNumber` among its `Round` rows, or the placeholder "-" if it has
 * none yet (true for every DRAFT/SCHEDULED bracket, which have no `Round`
 * rows).
 */
export function currentRoundNumber(
  rounds: { roundNumber: number }[]
): number | "-" {
  if (rounds.length === 0) {
    return "-";
  }
  return Math.max(...rounds.map((round) => round.roundNumber));
}

/**
 * Formats a creation date for a human to read, not a raw ISO timestamp.
 */
export function formatCreatedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Maps a Prisma `Bracket` (with `rounds` loaded) to the flat view-model
 * `BracketList` renders. Status is passed through as the raw
 * `BracketStatus` enum value per grooming - no copy/label mapping here.
 */
export function toBracketRow(bracket: BracketWithRounds): BracketRow {
  return {
    id: bracket.id,
    title: bracket.title,
    status: bracket.status,
    currentRoundNumber: currentRoundNumber(bracket.rounds),
    createdAt: formatCreatedAt(bracket.createdAt),
  };
}

// The four `Bracket.status` values (`prisma/schema.prisma`'s `BracketStatus`
// enum), in the order issue #33 lists them for the dashboard's sections.
export type BracketStatusValue = "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";

export type DashboardSection = {
  status: BracketStatusValue;
  heading: string;
};

export const DASHBOARD_SECTIONS: readonly DashboardSection[] = [
  { status: "DRAFT", heading: "Drafts" },
  { status: "SCHEDULED", heading: "Scheduled" },
  { status: "ACTIVE", heading: "Active" },
  { status: "COMPLETED", heading: "Completed" },
];

function isBracketStatusValue(status: string): status is BracketStatusValue {
  return DASHBOARD_SECTIONS.some((section) => section.status === status);
}

/**
 * Partitions a creator's brackets into the four dashboard sections (issue
 * #33), keyed by the raw `BracketStatus` enum value, each preserving the
 * caller's original ordering (`page.tsx` queries newest-first).
 *
 * A status that isn't one of the four known values is dropped rather than
 * thrown on - defensive only, since `Bracket.status` is a Postgres enum and
 * every row Prisma returns is guaranteed to be one of the four.
 */
export function groupBracketsByStatus(
  brackets: BracketRow[]
): Record<BracketStatusValue, BracketRow[]> {
  const groups: Record<BracketStatusValue, BracketRow[]> = {
    DRAFT: [],
    SCHEDULED: [],
    ACTIVE: [],
    COMPLETED: [],
  };

  for (const bracket of brackets) {
    if (isBracketStatusValue(bracket.status)) {
      groups[bracket.status].push(bracket);
    }
  }

  return groups;
}

const EDIT_FLOW_STATUSES: readonly BracketStatusValue[] = ["DRAFT", "SCHEDULED"];

/**
 * Where a dashboard row links to, per issue #33: a draft or scheduled
 * bracket links to its edit flow (#10-#16); an active or completed bracket
 * links to the public bracket view.
 *
 * That public view route (#21/#30) doesn't exist yet, so `/brackets/[id]`
 * is a placeholder link target for whoever builds it - the same convention
 * #10's engineer used for its own placeholder `/dashboard/brackets/[id]/edit`
 * page ahead of #11-#14.
 */
export function bracketLinkHref(
  bracket: Pick<BracketRow, "id" | "status">
): string {
  if (isBracketStatusValue(bracket.status) && EDIT_FLOW_STATUSES.includes(bracket.status)) {
    return `/dashboard/brackets/${bracket.id}/edit`;
  }
  return `/brackets/${bracket.id}`;
}
