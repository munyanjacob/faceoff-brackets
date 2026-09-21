/**
 * Wire types — mirrors docs/openapi.yaml exactly.
 * These are the only shapes that cross the services-layer boundary.
 */

export type Visibility = "PUBLIC" | "PRIVATE";
export type VotingRequirement = "ACCOUNT_REQUIRED" | "ANONYMOUS_ALLOWED";
export type BracketStatus = "DRAFT" | "SCHEDULED" | "ACTIVE" | "COMPLETED";
export type MatchupStatus = "PENDING" | "ACTIVE" | "TIE_BREAKER" | "COMPLETED";
export type RoundStatus = "PENDING" | "ACTIVE" | "COMPLETED";

export interface Bracket {
  id: string;
  creatorId: string;
  title: string;
  description: string | null;
  visibility: Visibility;
  votingRequirement: VotingRequirement;
  defaultRoundDurationMinutes: number;
  roundDurationOverrides: Record<string, number>;
  scheduledStartAt: string | null;
  status: BracketStatus;
  createdAt: string;
  publishedAt: string | null;
}

export interface BracketWithRounds extends Bracket {
  rounds: { roundNumber: number }[];
}

export interface BracketDetail extends Bracket {
  creator: { displayName: string | null };
  viewerIsOwner: boolean;
}

export interface CreateBracketRequest {
  title: string;
  description?: string | undefined;
  visibility: Visibility;
  votingRequirement: VotingRequirement;
}

export interface BracketItem {
  id: string;
  bracketId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  seed: number | null;
  createdAt: string;
}

export interface UpsertItemInput {
  title: string;
  description?: string | undefined;
  image?: File | undefined;
}

export interface UpdateRoundDurationRequest {
  defaultRoundDurationMinutes: number;
  overrides: Record<string, number>;
}

export interface UpdateScheduleRequest {
  startMode: "immediate" | "scheduled";
  scheduledStartAt?: string | undefined;
}

export interface MatchupSummary {
  id: string;
  status: MatchupStatus;
  /** Always present — only itemB can be absent (a bye). See specification.md §4.6. */
  itemA: BracketItem;
  itemB: BracketItem | null;
}

export type VotableMatchupsResponse =
  | { kind: "message"; message: string }
  | { kind: "matchups"; matchups: MatchupSummary[] };

export type VoterContext =
  | { kind: "blocked"; message: string }
  | {
      kind: "eligible";
      existingVoteItemId: string | null;
      voteCounts: Record<string, number> | null;
    };

export interface MatchupVotingView {
  matchup: MatchupSummary;
  bracketTitle: string;
  isTieBreaker: boolean;
  countdownEndsAt: string | null;
  voter: VoterContext;
}

export interface CastVoteRequest {
  itemId: string;
  comment?: string | undefined;
}

export interface CastVoteResponse {
  votedItemId: string;
  alreadyVoted: boolean;
}

export interface MatchupComment {
  /** The underlying Vote row's id. */
  id: string;
  comment: string;
  itemId: string;
  createdAt: string;
}

export type MatchupResult =
  | { kind: "bye"; advancingItem: BracketItem }
  | { kind: "not_completed" }
  | {
      kind: "decided";
      winner: BracketItem;
      winnerVoteCount: number;
      loser: BracketItem;
      loserVoteCount: number;
      decidedByTieBreaker: boolean;
      comments: MatchupComment[];
    };

/**
 * A discriminated union, deliberately — not a flatter
 * `{status, itemA, itemB, winnerItemId}` shape. That flat shape can
 * represent illegal states (e.g. `status: "COMPLETED"` with a null
 * `winnerItemId`, or a `winnerItemId` that isn't either item's id); this
 * union makes those states unrepresentable. See issue #49.
 */
export type MatchupCell =
  | { kind: "bye"; matchupId: string; advancingItem: BracketItem }
  | { kind: "completed"; matchupId: string; winner: BracketItem; loser: BracketItem }
  | {
      kind: "active";
      matchupId: string;
      itemA: BracketItem;
      itemB: BracketItem;
      isTieBreaker?: boolean;
    }
  | { kind: "pending"; matchupId: string; itemA: BracketItem; itemB: BracketItem | null }
  | { kind: "upcoming"; label: string };

/**
 * Tree-rendering-only status: like RoundStatus, plus NOT_STARTED, meaning no
 * Round row exists yet for this round number. The persisted Round entity's
 * own status never has this value — it's synthesized for this view only.
 */
export type TreeRoundStatus = RoundStatus | "NOT_STARTED";

export interface BracketTreeRound {
  roundNumber: number;
  status: TreeRoundStatus;
  /** Display hint ("Final" / "Semifinal" / "Round N") — always present. */
  label: string;
  /** Empty when status is NOT_STARTED (no matchups generated for this round yet). */
  cells: MatchupCell[];
}

export interface BracketTree {
  bracketTitle: string;
  bracketStatus: BracketStatus;
  totalRounds: number;
  rounds: BracketTreeRound[];
  champion: {
    item: BracketItem;
    finalTally: { item: BracketItem; votes: number }[];
  } | null;
}

export interface DiscoverRow {
  id: string;
  title: string;
  status: BracketStatus;
  publishedAt: string | null;
  creatorName: string;
}

export interface DiscoverResponse {
  recent: DiscoverRow[];
  active: DiscoverRow[];
  completed: DiscoverRow[];
}
