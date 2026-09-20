/**
 * Pure, framework-agnostic view-model helpers for `/brackets/[id]` (issue
 * #21), the public matchup-voting page. Kept separate from `page.tsx` and
 * free of any Prisma import - same reasoning as `../../discover/
 * discovery-view-model.ts` and `../../dashboard/bracket-view-model.ts` - so
 * "what counts as the active matchup" can be unit-tested without a database
 * connection.
 *
 * ## What "the active matchup" means here
 *
 * The issue asks for a page that shows "the active matchup's two items" -
 * singular - and `_docs/outdated/plan.md` SS13's mockup shows exactly one
 * "Current Matchup" panel per bracket page. A bracket has an active matchup
 * only when:
 *
 * 1. `Bracket.status === "ACTIVE"` (not `DRAFT`/`SCHEDULED`, which haven't
 *    started, and not `COMPLETED`, which is over) - each of those instead
 *    gets its own explanatory status message.
 * 2. It has a `Round` whose `status === "ACTIVE"` - a published bracket can
 *    still be between rounds (the previous round closed and the next
 *    hasn't started - #20/#27 territory) with `Bracket.status` still
 *    `ACTIVE` but no in-progress round.
 * 3. That round has at least one `Matchup` whose `status` is `ACTIVE` or
 *    `TIE_BREAKER` - a round can in principle be all byes/already-decided
 *    matchups momentarily, or between #20 closing a round and #27
 *    generating the next one.
 *
 * `TIE_BREAKER` matchups are treated the same as `ACTIVE` ones (rendered
 * with vote buttons) - #29, which formally implements tie-breaker
 * resolution, isn't built yet, but the schema already models
 * `TIE_BREAKER` as a distinct, still-votable status (see
 * `prisma/schema.prisma`), and hiding vote buttons during a tie-breaker
 * would contradict "voting should be the dominant action on the page"
 * (plan.md SS13) for what is, from a voter's perspective, still an
 * open vote. Flagged as a judgment call in the issue #21 comment.
 *
 * ## Multiple simultaneous matchups in one round
 *
 * A real bracket's round 1 can have several matchups active at once (e.g.
 * 4 matchups from 8 items). This page (and its `/brackets/[id]` route, with
 * no matchup id in the URL) only has room for one. Issue #21 doesn't say
 * how to pick "the" one when there's more than one, and doesn't propose a
 * per-matchup URL or a matchup switcher either. Rather than guess at a UX
 * that might get thrown away, this picks the first votable matchup in a
 * deterministic order (whatever order `page.tsx`'s Prisma query returns
 * them in) and renders only that one. Flagged as a genuine ambiguity in the
 * issue #21 comment, not silently resolved.
 */

export type VotingItem = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
};

export type VotingMatchup = {
  id: string;
  status: string; // Matchup status ("ACTIVE" | "TIE_BREAKER" here; see below)
  itemA: VotingItem | null;
  itemB: VotingItem | null;
};

export type VotingRound = {
  status: string; // Round status ("ACTIVE" is the only one this cares about)
  matchups: VotingMatchup[];
};

export type VotingBracket = {
  status: string; // Bracket status
};

export type VotingState =
  | { kind: "no-active-matchup"; message: string }
  | { kind: "matchup"; matchup: VotingMatchup; isTieBreaker: boolean };

export const NOT_STARTED_MESSAGE =
  "This bracket hasn't started voting yet. Check back once it opens.";

export const COMPLETED_MESSAGE =
  "This bracket has finished. Voting is closed.";

export const BETWEEN_ROUNDS_MESSAGE =
  "Voting isn't open right now - check back soon for the next round.";

/**
 * The `Matchup.status` values a vote can ever be cast against (issue #22).
 * Shared as a single source of truth between `determineVotingState` below
 * (which decides whether to render vote buttons at all) and
 * `./vote-actions.ts`'s `castVote` (which must independently re-check the
 * same rule server-side, never trusting that this page rendered the button
 * - the same "not just a hidden button" reasoning as
 * `../../dashboard/brackets/[id]/edit/publish-actions.ts`).
 *
 * `TIE_BREAKER` is included deliberately, not just `ACTIVE`: issue #21
 * already treats a `TIE_BREAKER` matchup as votable (see this file's top
 * comment), and issue #29 (tie-breaker resolution, not yet built) is
 * explicit that "only votes cast from that point on count toward its
 * outcome" - i.e. tie-breaker votes are real, counted votes, not a no-op.
 * Rejecting them here would make #29 impossible to satisfy later. Judgment
 * call, documented in the issue #22 comment.
 */
export const VOTABLE_MATCHUP_STATUSES = ["ACTIVE", "TIE_BREAKER"] as const;

export function isVotableMatchupStatus(
  status: string
): status is (typeof VOTABLE_MATCHUP_STATUSES)[number] {
  return (VOTABLE_MATCHUP_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether the current visitor is even allowed to attempt a vote on this
 * bracket, and - if they are - which item (if any) they've already voted
 * for on the current matchup. Computed once per page render by
 * `./page.tsx` (it needs a signed-in check and a `Vote` lookup, both of
 * which require I/O `determineVotingState` deliberately doesn't do) and
 * threaded down to `./matchup-voting.tsx`.
 *
 * Kept as a plain, synchronous, I/O-free function here (same reasoning as
 * `determineVotingState`) so the "ACCOUNT_REQUIRED + signed out -> blocked"
 * rule (issue #22's third acceptance criterion) can be unit-tested without
 * a database or a real Supabase session.
 */
export type VoterContext =
  | { kind: "blocked"; message: string }
  | { kind: "eligible"; existingVoteItemId: string | null };

export const SIGN_IN_TO_VOTE_MESSAGE = "Sign in to vote on this bracket.";

export function determineVoterContext(
  votingRequirement: string,
  isSignedIn: boolean,
  existingVoteItemId: string | null
): VoterContext {
  if (votingRequirement === "ACCOUNT_REQUIRED" && !isSignedIn) {
    return { kind: "blocked", message: SIGN_IN_TO_VOTE_MESSAGE };
  }

  return { kind: "eligible", existingVoteItemId };
}

/**
 * Determines what `/brackets/[id]` should show: the one active matchup to
 * vote on, or an explanatory status message when there isn't one right now.
 * See this file's top comment for the full reasoning.
 */
export function determineVotingState(
  bracket: VotingBracket,
  activeRounds: VotingRound[]
): VotingState {
  if (bracket.status === "DRAFT" || bracket.status === "SCHEDULED") {
    return { kind: "no-active-matchup", message: NOT_STARTED_MESSAGE };
  }

  if (bracket.status === "COMPLETED") {
    return { kind: "no-active-matchup", message: COMPLETED_MESSAGE };
  }

  // bracket.status === "ACTIVE" (the only remaining known value).
  const activeRound = activeRounds.find((round) => round.status === "ACTIVE");
  if (!activeRound) {
    return { kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE };
  }

  const votableMatchup = activeRound.matchups.find(
    (matchup) =>
      isVotableMatchupStatus(matchup.status) &&
      matchup.itemA !== null &&
      matchup.itemB !== null
  );

  if (!votableMatchup) {
    return { kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE };
  }

  return {
    kind: "matchup",
    matchup: votableMatchup,
    isTieBreaker: votableMatchup.status === "TIE_BREAKER",
  };
}
