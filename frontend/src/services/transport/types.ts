import type {
  Bracket,
  BracketDetail,
  BracketItem,
  BracketTree,
  BracketWithRounds,
  CastVoteRequest,
  CastVoteResponse,
  CreateBracketRequest,
  DiscoverResponse,
  MatchupResult,
  MatchupVotingView,
  UpdateRoundDurationRequest,
  UpdateScheduleRequest,
  UpsertItemInput,
  VotableMatchupsResponse,
} from "../types";

/** Identity of the caller, resolved from the Supabase session. */
export interface Caller {
  userId: string;
  email: string;
  displayName: string | null;
  accessToken: string;
}

export type CallerResolver = () => Promise<Caller | null>;

/**
 * Every backend operation in openapi.yaml, in one place. The services layer
 * calls only this interface, so swapping the in-memory contract stand-in for
 * the real REST API is a one-line change in ./index.ts.
 */
export interface ApiTransport {
  listMyBrackets(): Promise<BracketWithRounds[]>;
  createBracket(input: CreateBracketRequest): Promise<Bracket>;
  getBracket(bracketId: string): Promise<BracketDetail>;
  listItems(bracketId: string): Promise<BracketItem[]>;
  addItem(bracketId: string, input: UpsertItemInput): Promise<BracketItem>;
  updateItem(bracketId: string, itemId: string, input: UpsertItemInput): Promise<BracketItem>;
  removeItem(bracketId: string, itemId: string): Promise<void>;
  updateRoundDuration(bracketId: string, input: UpdateRoundDurationRequest): Promise<Bracket>;
  updateSchedule(bracketId: string, input: UpdateScheduleRequest): Promise<Bracket>;
  publish(bracketId: string): Promise<Bracket>;
  getVotableMatchups(bracketId: string): Promise<VotableMatchupsResponse>;
  getMatchup(bracketId: string, matchupId: string): Promise<MatchupVotingView>;
  castVote(matchupId: string, input: CastVoteRequest): Promise<CastVoteResponse>;
  getMatchupResult(bracketId: string, matchupId: string): Promise<MatchupResult>;
  getBracketTree(bracketId: string): Promise<BracketTree>;
  listPublic(): Promise<DiscoverResponse>;
}
