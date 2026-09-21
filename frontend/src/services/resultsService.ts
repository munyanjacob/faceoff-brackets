import { transport } from "./transport";
import type { BracketTree, MatchupResult } from "./types";

/** Public completed-matchup and full-tree views. */
export const resultsService = {
  getMatchupResult: (bracketId: string, matchupId: string): Promise<MatchupResult> =>
    transport.getMatchupResult(bracketId, matchupId),
  getBracketTree: (bracketId: string): Promise<BracketTree> => transport.getBracketTree(bracketId),
};
