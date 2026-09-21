import { transport } from "./transport";
import type {
  CastVoteRequest,
  CastVoteResponse,
  MatchupVotingView,
  VotableMatchupsResponse,
} from "./types";

/** Public voting surface. Auth is sent when present so voters are recognized. */
export const votingService = {
  getVotableMatchups: (bracketId: string): Promise<VotableMatchupsResponse> =>
    transport.getVotableMatchups(bracketId),
  getMatchup: (bracketId: string, matchupId: string): Promise<MatchupVotingView> =>
    transport.getMatchup(bracketId, matchupId),
  castVote: (matchupId: string, input: CastVoteRequest): Promise<CastVoteResponse> =>
    transport.castVote(matchupId, input),
};
