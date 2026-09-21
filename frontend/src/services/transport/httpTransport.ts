import { ServiceError, GENERIC_ERROR_MESSAGE } from "../serviceError";
import type { ApiTransport, CallerResolver } from "./types";
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

/**
 * Real REST transport against the backend described by openapi.yaml.
 * Active as soon as VITE_API_BASE_URL is set.
 *
 * `credentials: "include"` is mandatory on every call so the backend-set,
 * httpOnly, signed `voter_id` cookie round-trips (specification §6).
 */
export function createHttpTransport(baseUrl: string, getCaller: CallerResolver): ApiTransport {
  const root = baseUrl.replace(/\/$/, "");

  async function request<T>(
    path: string,
    init: { method?: string; json?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const caller = await getCaller();
    const headers: Record<string, string> = {};
    if (caller) headers["Authorization"] = `Bearer ${caller.accessToken}`;
    if (init.json !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: init.method ?? "GET",
        credentials: "include",
        headers,
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : null),
      });
    } catch {
      throw new ServiceError("NETWORK", GENERIC_ERROR_MESSAGE, 0);
    }

    if (response.status === 204) return undefined as T;

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        payload && typeof payload.code === "string" ? (payload.code as string) : "UNEXPECTED";
      const message =
        payload && typeof payload.message === "string"
          ? (payload.message as string)
          : GENERIC_ERROR_MESSAGE;
      throw new ServiceError(code, message, response.status);
    }
    return payload as T;
  }

  function itemForm(input: UpsertItemInput): FormData {
    const form = new FormData();
    form.set("title", input.title);
    if (input.description !== undefined) form.set("description", input.description);
    if (input.image) form.set("image", input.image);
    return form;
  }

  return {
    listMyBrackets: () => request<BracketWithRounds[]>("/brackets/mine"),
    createBracket: (input: CreateBracketRequest) =>
      request<Bracket>("/brackets", { method: "POST", json: input }),
    getBracket: (bracketId) => request<BracketDetail>(`/brackets/${bracketId}`),
    listItems: (bracketId) => request<BracketItem[]>(`/brackets/${bracketId}/items`),
    addItem: (bracketId, input) =>
      request<BracketItem>(`/brackets/${bracketId}/items`, {
        method: "POST",
        form: itemForm(input),
      }),
    updateItem: (bracketId, itemId, input) =>
      request<BracketItem>(`/brackets/${bracketId}/items/${itemId}`, {
        method: "PATCH",
        form: itemForm(input),
      }),
    removeItem: (bracketId, itemId) =>
      request<void>(`/brackets/${bracketId}/items/${itemId}`, { method: "DELETE" }),
    updateRoundDuration: (bracketId, input: UpdateRoundDurationRequest) =>
      request<Bracket>(`/brackets/${bracketId}/round-duration`, { method: "PATCH", json: input }),
    updateSchedule: (bracketId, input: UpdateScheduleRequest) =>
      request<Bracket>(`/brackets/${bracketId}/schedule`, { method: "PATCH", json: input }),
    publish: (bracketId) => request<Bracket>(`/brackets/${bracketId}/publish`, { method: "POST" }),
    getVotableMatchups: (bracketId) =>
      request<VotableMatchupsResponse>(`/brackets/${bracketId}/matchups`),
    getMatchup: (bracketId, matchupId) =>
      request<MatchupVotingView>(`/brackets/${bracketId}/matchups/${matchupId}`),
    castVote: (matchupId, input: CastVoteRequest) =>
      request<CastVoteResponse>(`/matchups/${matchupId}/votes`, { method: "POST", json: input }),
    getMatchupResult: (bracketId, matchupId) =>
      request<MatchupResult>(`/brackets/${bracketId}/matchups/${matchupId}/result`),
    getBracketTree: (bracketId) => request<BracketTree>(`/brackets/${bracketId}/tree`),
    listPublic: () => request<DiscoverResponse>("/discover"),
  };
}
