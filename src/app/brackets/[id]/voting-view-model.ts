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
 * 4 matchups from 8 items). Issue #21 flagged this as a genuine ambiguity
 * - no per-matchup URL, no switcher, no picking rule. Issue #40 resolves
 * it: `/brackets/[id]/matchups/[matchupId]` (a sibling page, see
 * `./matchup-voting.tsx`'s doc comment) is the real per-matchup view now,
 * and `determineVotingState` below - "pick the first votable matchup,
 * deterministically" - is kept as-is specifically because `/brackets/[id]`
 * still needs exactly that rule for its redirect-when-there's-only-one
 * case (`./page.tsx`). `listVotableMatchups` below is the new sibling for
 * the index case (more than one votable matchup), and
 * `determineMatchupVotingState` is the sibling for the per-matchup route
 * itself (look up *this* matchup id, not "the first one"). All three share
 * `findActiveRoundOrMessage`'s bracket-level "is there even a live round
 * right now" logic, so the not-started/completed/between-rounds messages
 * stay in exactly one place.
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
  /**
   * Issue #25: a `TIE_BREAKER` matchup's own end time (`prisma/schema.
   * prisma`'s `Matchup.tieBreakerEndsAt`), separate from its Round's
   * `endsAt` - see `./matchups/[matchupId]/page.tsx`'s top comment for why
   * the countdown shown during a tie-breaker uses this instead. Optional
   * (rather than required) for the same reason `VotingBracket.
   * scheduledStartAt` is above: every existing call site/test that only
   * cares about `status`/`itemA`/`itemB` doesn't have to start threading a
   * value it never uses, and a non-`TIE_BREAKER` matchup never has one
   * anyway.
   */
  tieBreakerEndsAt?: Date | null;
};

export type VotingRound = {
  status: string; // Round status ("ACTIVE" is the only one this cares about)
  matchups: VotingMatchup[];
};

export type VotingBracket = {
  status: string; // Bracket status
  /**
   * Issue #28: when set on a `SCHEDULED` bracket, lets the not-started
   * message below state *when* voting opens instead of just that it hasn't
   * yet - `Bracket.scheduledStartAt` from `prisma/schema.prisma`, passed
   * straight through from `./page.tsx`'s/`./matchups/[matchupId]/page.tsx`'s
   * unfiltered `prisma.bracket.findUnique` result (no `select` there, so
   * every scalar column, including this one, is already present - no query
   * change was needed for this).
   *
   * Optional (rather than required) so every existing test/call site that
   * only cares about `status` (and every `DRAFT` bracket, which never has a
   * committed `scheduledStartAt` worth announcing - see
   * `notStartedMessage` below) doesn't have to thread a value through it
   * doesn't use.
   */
  scheduledStartAt?: Date | null;
};

export type VotingState =
  | { kind: "no-active-matchup"; message: string }
  | { kind: "matchup"; matchup: VotingMatchup; isTieBreaker: boolean };

export const NOT_STARTED_MESSAGE =
  "This bracket hasn't started voting yet. Check back once it opens.";

/**
 * Human-readable rendering of a scheduled start time for the not-started
 * message below. No timezone is pinned (same convention as
 * `../../dashboard/bracket-view-model.ts`'s `formatCreatedAt` and
 * `../../discover/discovery-view-model.ts`'s equivalent) - it renders in
 * whichever timezone the process (server-rendering this page) is running
 * in, consistent with how this codebase already formats every other date it
 * shows a voter.
 */
export function formatScheduledStartAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/**
 * Issue #28's not-started message: a generic "hasn't started" for a `DRAFT`
 * bracket (which has nothing committed to announce - a creator can still
 * change or clear `scheduledStartAt` before publishing), or - for a
 * `SCHEDULED` bracket with a `scheduledStartAt` - a message stating exactly
 * when voting opens, so a voter arriving early isn't just told "not yet"
 * with no indication of when to come back.
 *
 * Falls back to the generic `NOT_STARTED_MESSAGE` for a `SCHEDULED` bracket
 * with no `scheduledStartAt` too (shouldn't happen in practice - see
 * `findDueScheduledBrackets`'s doc comment on why a `SCHEDULED` bracket
 * always has one - but this keeps the message rendering defensive rather
 * than crashing or printing "Invalid Date" if that invariant is ever
 * violated).
 */
function notStartedMessage(bracket: VotingBracket): string {
  if (bracket.status === "SCHEDULED" && bracket.scheduledStartAt) {
    return `This bracket hasn't started yet. It's scheduled to begin at ${formatScheduledStartAt(
      bracket.scheduledStartAt
    )}.`;
  }
  return NOT_STARTED_MESSAGE;
}

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
 * A matchup that's actually votable *and* has both its items populated -
 * the same two-part test `determineVotingState`'s `votableMatchup` search
 * used inline before issue #40 factored it out for reuse by
 * `listVotableMatchups` and `determineMatchupVotingState` below. A type
 * predicate (not just a boolean) so callers that `.filter()` with it get a
 * narrowed, non-null `itemA`/`itemB` back without a separate cast - see
 * `MatchupListState` below, whose whole reason to exist is handing the
 * index page items it can safely read `.title` off of.
 */
function isVotableAndComplete(
  matchup: VotingMatchup
): matchup is VotingMatchup & { itemA: VotingItem; itemB: VotingItem } {
  return (
    isVotableMatchupStatus(matchup.status) &&
    matchup.itemA !== null &&
    matchup.itemB !== null
  );
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

/**
 * Issue #24's live-results data: a matchup's two items' current vote
 * tallies, keyed by `VotingItem.id`. Deliberately just a plain
 * `Record<string, number>`, not a richer shape - `./matchup-voting.tsx`'s
 * `VoteControl` only ever needs "how many votes does *this* item have" for
 * whichever item it's currently rendering.
 *
 * Only ever populated by `./matchups/[matchupId]/page.tsx` when
 * `VoterContext.existingVoteItemId` is non-null (the voter has already
 * voted on this matchup) - see that file's top comment for why counts are
 * never even fetched otherwise, matching the issue's "a voter who hasn't
 * voted never sees vote counts" criterion at the data layer, not just the
 * rendering layer.
 */
export type VoteCounts = Record<string, number>;

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
 * The bracket-level half of `determineVotingState`'s old logic (issue #21):
 * not-started/completed/between-rounds, or "here's the live round" when
 * voting is actually possible right now. Factored out by issue #40 so
 * `determineVotingState`, `listVotableMatchups`, and
 * `determineMatchupVotingState` below all give identical answers to "is
 * there even a live round" without repeating the three bracket-status
 * checks three times.
 */
function findActiveRoundOrMessage(
  bracket: VotingBracket,
  activeRounds: VotingRound[]
):
  | { kind: "no-active-matchup"; message: string }
  | { kind: "round"; round: VotingRound } {
  if (bracket.status === "DRAFT" || bracket.status === "SCHEDULED") {
    return { kind: "no-active-matchup", message: notStartedMessage(bracket) };
  }

  if (bracket.status === "COMPLETED") {
    return { kind: "no-active-matchup", message: COMPLETED_MESSAGE };
  }

  // bracket.status === "ACTIVE" (the only remaining known value).
  const activeRound = activeRounds.find((round) => round.status === "ACTIVE");
  if (!activeRound) {
    return { kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE };
  }

  return { kind: "round", round: activeRound };
}

/**
 * Determines what `/brackets/[id]` should redirect to (the common,
 * exactly-one-votable-matchup case) or show inline (a status message) when
 * there isn't one right now. Kept picking "the first votable matchup,
 * deterministically" rather than being replaced by `listVotableMatchups`
 * below - `./page.tsx` still needs exactly this rule for its
 * redirect-when-there's-only-one behavior (issue #40), and this function's
 * behavior/signature are otherwise unchanged from issue #21/#22.
 */
export function determineVotingState(
  bracket: VotingBracket,
  activeRounds: VotingRound[]
): VotingState {
  const availability = findActiveRoundOrMessage(bracket, activeRounds);
  if (availability.kind === "no-active-matchup") {
    return availability;
  }

  const votableMatchup = availability.round.matchups.find(isVotableAndComplete);

  if (!votableMatchup) {
    return { kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE };
  }

  return {
    kind: "matchup",
    matchup: votableMatchup,
    isTieBreaker: votableMatchup.status === "TIE_BREAKER",
  };
}

/**
 * `/brackets/[id]`'s state when its active round has more than one votable
 * matchup at once (issue #40's index case): every votable matchup in the
 * round, for `./matchup-index.tsx` to render as a plain list of links into
 * `/brackets/[id]/matchups/[matchupId]` - or the same bracket-level status
 * message `determineVotingState` would show, when there's no live round to
 * list matchups from at all.
 *
 * The "exactly one" case is deliberately *not* special-cased here - it
 * still comes back as `{ kind: "matchups", matchups: [oneMatchup] }`.
 * `./page.tsx` is the one that decides "exactly one -> redirect instead of
 * rendering an index", since that's a routing decision, not a view-model
 * one.
 */
export type MatchupListState =
  | { kind: "no-active-matchup"; message: string }
  | {
      kind: "matchups";
      matchups: (VotingMatchup & { itemA: VotingItem; itemB: VotingItem })[];
    };

export function listVotableMatchups(
  bracket: VotingBracket,
  activeRounds: VotingRound[]
): MatchupListState {
  const availability = findActiveRoundOrMessage(bracket, activeRounds);
  if (availability.kind === "no-active-matchup") {
    return availability;
  }

  const votableMatchups = availability.round.matchups.filter(isVotableAndComplete);

  if (votableMatchups.length === 0) {
    return { kind: "no-active-matchup", message: BETWEEN_ROUNDS_MESSAGE };
  }

  return { kind: "matchups", matchups: votableMatchups };
}

/**
 * `/brackets/[id]/matchups/[matchupId]`'s state (issue #40): the one
 * specific matchup the URL names, the same bracket-level status message
 * `determineVotingState`/`listVotableMatchups` would show when there's no
 * live round at all, or `{ kind: "not-found" }` when the round *is* live
 * but this particular matchup id isn't a votable matchup in it (wrong id,
 * already-decided matchup, belongs to a different round/bracket, etc.) -
 * `./page.tsx` turns that into a 404 via `notFound()`, the same convention
 * `./page.tsx`'s sibling already uses for an unknown bracket id.
 */
export type MatchupPageState = VotingState | { kind: "not-found" };

export function determineMatchupVotingState(
  bracket: VotingBracket,
  activeRounds: VotingRound[],
  matchupId: string
): MatchupPageState {
  const availability = findActiveRoundOrMessage(bracket, activeRounds);
  if (availability.kind === "no-active-matchup") {
    return availability;
  }

  const matchup = availability.round.matchups.find((m) => m.id === matchupId);
  if (!matchup || !isVotableAndComplete(matchup)) {
    return { kind: "not-found" };
  }

  return {
    kind: "matchup",
    matchup,
    isTieBreaker: matchup.status === "TIE_BREAKER",
  };
}
