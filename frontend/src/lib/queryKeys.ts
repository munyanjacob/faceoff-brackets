/**
 * Central React Query key factory. Every `useQuery`/`useMutation`
 * `queryKey` (and every `invalidateQueries({ queryKey })` call) in the app
 * should build its key from here instead of writing the array literal by
 * hand, so cache invalidation can't drift out of sync across files.
 */
export const queryKeys = {
  bracket: (bracketId: string) => ["bracket", bracketId] as const,
  items: (bracketId: string) => ["items", bracketId] as const,
  matchups: (bracketId: string) => ["matchups", bracketId] as const,
  matchup: (bracketId: string, matchupId: string) => ["matchup", bracketId, matchupId] as const,
  matchupResult: (bracketId: string, matchupId: string) =>
    ["matchup-result", bracketId, matchupId] as const,
  tree: (bracketId: string) => ["tree", bracketId] as const,
  discover: () => ["discover"] as const,
  myBrackets: () => ["my-brackets"] as const,
};
