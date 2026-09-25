/**
 * Contract stand-in transport.
 *
 * The real backend in openapi.yaml is not deployed yet, so this module
 * implements the exact same operations in the browser (persisted to
 * localStorage) including every business rule from the specification:
 * status machines, bye generation, tie-breakers, the round-advancement
 * sweep, vote phases, the 20-votes/10-minutes rate limit, and the exact
 * user-facing error strings.
 *
 * Nothing outside src/services imports this file. Point VITE_API_BASE_URL at
 * the real API and it is bypassed entirely.
 *
 * This is the composition root: mockDb.ts owns the schema + persistence,
 * mockSeed.ts owns demo data, mockEngine.ts owns the tournament business
 * rules, and this file wires them into the ApiTransport CRUD surface.
 */

import { ServiceError, GENERIC_ERROR_MESSAGE } from "../serviceError";
import { roundLabel, totalRoundsFor } from "@/lib/bracket-logic";
import type { ApiTransport, CallerResolver } from "./types";
import type {
  Bracket,
  BracketDetail,
  BracketItem,
  BracketTree,
  BracketTreeRound,
  BracketWithRounds,
  CastVoteRequest,
  CastVoteResponse,
  CreateBracketRequest,
  DiscoverResponse,
  DiscoverRow,
  MatchupCell,
  MatchupResult,
  MatchupSummary,
  MatchupVotingView,
  UpdateRoundDurationRequest,
  UpdateScheduleRequest,
  UpsertItemInput,
  VotableMatchupsResponse,
} from "../types";
import {
  anonymousId,
  itemsOf,
  load,
  nowIso,
  save,
  uid,
  type Db,
  type MatchupRow,
  type VoteRow,
} from "./mockDb";
import { createRound, sweep, tallies } from "./mockEngine";

/** Vote rate limit (§4.7-ish anti-abuse rule): votes per caller within the window. */
const VOTE_RATE_LIMIT = 20;
const VOTE_RATE_WINDOW_MS = 10 * 60_000;

/** Max length of a vote's free-text comment. */
const MAX_COMMENT_LENGTH = 500;

/** Item image upload constraints. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function fail(code: string, message: string, status: number): never {
  throw new ServiceError(code, message, status);
}

function withSweep<T>(fn: (db: Db) => T): T {
  const db = load();
  sweep(db);
  const result = fn(db);
  save();
  return result;
}

/* ------------------------------------------------------------------ *
 * Read helpers
 * ------------------------------------------------------------------ */

function item(db: Db, id: string | null): BracketItem | null {
  if (!id) return null;
  return db.items.find((i) => i.id === id) ?? null;
}

function toSummary(db: Db, matchup: MatchupRow): MatchupSummary {
  return {
    id: matchup.id,
    status: matchup.status,
    itemA: item(db, matchup.itemAId)!,
    itemB: item(db, matchup.itemBId),
  };
}

/** Maps a matchup row to its MatchupCell variant for the tree view (§9.6 of the spec). */
function toCell(db: Db, matchup: MatchupRow): MatchupCell {
  const itemA = item(db, matchup.itemAId)!;
  const itemB = item(db, matchup.itemBId);

  if (!matchup.itemBId) {
    return { kind: "bye", matchupId: matchup.id, advancingItem: itemA };
  }
  if (matchup.status === "COMPLETED") {
    const winnerId = matchup.winnerItemId!;
    const loserId = winnerId === matchup.itemAId ? matchup.itemBId : matchup.itemAId!;
    return {
      kind: "completed",
      matchupId: matchup.id,
      winner: item(db, winnerId)!,
      loser: item(db, loserId)!,
    };
  }
  if (matchup.status === "ACTIVE" || matchup.status === "TIE_BREAKER") {
    return {
      kind: "active",
      matchupId: matchup.id,
      itemA,
      itemB: itemB!,
      isTieBreaker: matchup.status === "TIE_BREAKER",
    };
  }
  return { kind: "pending", matchupId: matchup.id, itemA, itemB };
}

function ownedDraft(db: Db, bracketId: string, userId: string): Bracket {
  const bracket = db.brackets.find((b) => b.id === bracketId && b.creatorId === userId);
  if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
  if (bracket.status !== "DRAFT") {
    fail("BRACKET_LOCKED", "This bracket has already been published and can't be changed.", 409);
  }
  return bracket;
}

async function requireCaller(getCaller: CallerResolver) {
  const caller = await getCaller();
  if (!caller) fail("UNAUTHORIZED", "Sign in to continue.", 401);
  return caller;
}

function validateItemInput(input: UpsertItemInput) {
  if (!input.title.trim()) fail("VALIDATION_ERROR", "Title is required.", 400);
  const image = input.image;
  if (image && image.size > 0) {
    if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
      fail("VALIDATION_ERROR", "Image must be a PNG, JPEG, or WebP file.", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) {
      fail("VALIDATION_ERROR", "Image must be 5MB or smaller.", 400);
    }
  }
}

async function readImage(image: File | undefined): Promise<string | null> {
  if (!image || image.size === 0) return null;
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(image);
  });
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export function createMockTransport(getCaller: CallerResolver): ApiTransport {
  return {
    async listMyBrackets(): Promise<BracketWithRounds[]> {
      const caller = await requireCaller(getCaller);
      return withSweep((db) =>
        db.brackets
          .filter((b) => b.creatorId === caller.userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((b) => ({
            ...b,
            rounds: db.rounds
              .filter((r) => r.bracketId === b.id)
              .map((r) => ({ roundNumber: r.roundNumber })),
          })),
      );
    },

    async createBracket(input: CreateBracketRequest): Promise<Bracket> {
      const caller = await requireCaller(getCaller);
      if (!input.title.trim()) fail("VALIDATION_ERROR", "Title is required.", 400);
      if (!["PUBLIC", "PRIVATE"].includes(input.visibility)) {
        fail("VALIDATION_ERROR", "Choose a visibility: Public or Private.", 400);
      }
      if (!["ACCOUNT_REQUIRED", "ANONYMOUS_ALLOWED"].includes(input.votingRequirement)) {
        fail("VALIDATION_ERROR", "Choose whether voting requires an account.", 400);
      }
      return withSweep((db) => {
        db.profiles[caller.userId] = caller.displayName ?? caller.email;
        const bracket: Bracket = {
          id: uid(),
          creatorId: caller.userId,
          title: input.title.trim(),
          description: input.description?.trim() ? input.description.trim() : null,
          visibility: input.visibility,
          votingRequirement: input.votingRequirement,
          defaultRoundDurationMinutes: 60,
          roundDurationOverrides: {},
          scheduledStartAt: null,
          status: "DRAFT",
          createdAt: nowIso(),
          publishedAt: null,
        };
        db.brackets.push(bracket);
        return bracket;
      });
    },

    async getBracket(bracketId: string): Promise<BracketDetail> {
      const caller = await getCaller();
      return withSweep((db) => {
        const bracket = db.brackets.find((b) => b.id === bracketId);
        if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
        return {
          ...bracket,
          creator: { displayName: db.profiles[bracket.creatorId] ?? null },
          viewerIsOwner: Boolean(caller && caller.userId === bracket.creatorId),
        };
      });
    },

    async listItems(bracketId: string): Promise<BracketItem[]> {
      const caller = await requireCaller(getCaller);
      return withSweep((db) => {
        const bracket = db.brackets.find(
          (b) => b.id === bracketId && b.creatorId === caller.userId,
        );
        if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
        return itemsOf(db, bracketId);
      });
    },

    async addItem(bracketId: string, input: UpsertItemInput): Promise<BracketItem> {
      const caller = await requireCaller(getCaller);
      validateItemInput(input);
      const imageUrl = await readImage(input.image);
      return withSweep((db) => {
        ownedDraft(db, bracketId, caller.userId);
        const created: BracketItem = {
          id: uid(),
          bracketId,
          title: input.title.trim(),
          description: input.description?.trim() ? input.description.trim() : null,
          imageUrl,
          seed: itemsOf(db, bracketId).length + 1,
          createdAt: nowIso(),
        };
        db.items.push(created);
        return created;
      });
    },

    async updateItem(
      bracketId: string,
      itemId: string,
      input: UpsertItemInput,
    ): Promise<BracketItem> {
      const caller = await requireCaller(getCaller);
      validateItemInput(input);
      const imageUrl = await readImage(input.image);
      return withSweep((db) => {
        ownedDraft(db, bracketId, caller.userId);
        const existing = db.items.find((i) => i.id === itemId && i.bracketId === bracketId);
        if (!existing) fail("NOT_FOUND", "This item no longer exists.", 404);
        existing.title = input.title.trim();
        existing.description = input.description?.trim() ? input.description.trim() : null;
        if (imageUrl) existing.imageUrl = imageUrl;
        return existing;
      });
    },

    async removeItem(bracketId: string, itemId: string): Promise<void> {
      const caller = await requireCaller(getCaller);
      withSweep((db) => {
        ownedDraft(db, bracketId, caller.userId);
        db.items = db.items.filter((i) => !(i.id === itemId && i.bracketId === bracketId));
      });
    },

    async updateRoundDuration(
      bracketId: string,
      input: UpdateRoundDurationRequest,
    ): Promise<Bracket> {
      const caller = await requireCaller(getCaller);
      return withSweep((db) => {
        const bracket = ownedDraft(db, bracketId, caller.userId);
        const value = input.defaultRoundDurationMinutes;
        if (!value && value !== 0)
          fail("VALIDATION_ERROR", "Default round duration is required.", 400);
        if (!Number.isInteger(value) || value <= 0) {
          fail(
            "VALIDATION_ERROR",
            "Default round duration must be a positive number of minutes.",
            400,
          );
        }
        const rounds = totalRoundsFor(itemsOf(db, bracketId).length);
        const overrides: Record<string, number> = {};
        for (const [key, minutes] of Object.entries(input.overrides)) {
          const roundNumber = Number(key);
          if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > rounds) continue;
          if (!Number.isInteger(minutes)) {
            fail(
              "VALIDATION_ERROR",
              `Round ${roundNumber}'s duration must be a whole number of minutes.`,
              400,
            );
          }
          if (minutes <= 0) {
            fail(
              "VALIDATION_ERROR",
              `Round ${roundNumber}'s duration must be a positive number of minutes.`,
              400,
            );
          }
          overrides[key] = minutes;
        }
        bracket.defaultRoundDurationMinutes = value;
        bracket.roundDurationOverrides = overrides;
        return bracket;
      });
    },

    async updateSchedule(bracketId: string, input: UpdateScheduleRequest): Promise<Bracket> {
      const caller = await requireCaller(getCaller);
      return withSweep((db) => {
        const bracket = ownedDraft(db, bracketId, caller.userId);
        if (input.startMode === "immediate") {
          bracket.scheduledStartAt = null;
          return bracket;
        }
        const parsed = input.scheduledStartAt ? Date.parse(input.scheduledStartAt) : NaN;
        if (Number.isNaN(parsed)) {
          fail("VALIDATION_ERROR", "A scheduled start requires a valid date and time.", 400);
        }
        if (parsed <= Date.now()) {
          fail("VALIDATION_ERROR", "The scheduled start time must be in the future.", 400);
        }
        bracket.scheduledStartAt = new Date(parsed).toISOString();
        return bracket;
      });
    },

    async publish(bracketId: string): Promise<Bracket> {
      const caller = await requireCaller(getCaller);
      return withSweep((db) => {
        const bracket = ownedDraft(db, bracketId, caller.userId);
        const items = itemsOf(db, bracketId);
        if (items.length < 2) {
          fail("VALIDATION_ERROR", "Add at least 2 items before publishing.", 409);
        }
        const scheduled = bracket.scheduledStartAt
          ? Date.parse(bracket.scheduledStartAt) > Date.now()
          : false;
        bracket.status = scheduled ? "SCHEDULED" : "ACTIVE";
        bracket.publishedAt = nowIso();
        createRound(db, bracket, 1, items, {
          pending: scheduled,
          startsAt: scheduled ? null : new Date(),
        });
        return bracket;
      });
    },

    async getVotableMatchups(bracketId: string): Promise<VotableMatchupsResponse> {
      return withSweep((db) => {
        const bracket = db.brackets.find((b) => b.id === bracketId);
        if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
        if (bracket.status === "DRAFT") {
          return { kind: "message" as const, message: "This bracket hasn't started yet." };
        }
        if (bracket.status === "SCHEDULED") {
          const when = bracket.scheduledStartAt
            ? new Date(bracket.scheduledStartAt).toLocaleString()
            : null;
          return {
            kind: "message" as const,
            message: when
              ? `This bracket hasn't started yet. Voting opens ${when}.`
              : "This bracket hasn't started yet.",
          };
        }
        if (bracket.status === "COMPLETED") {
          return {
            kind: "message" as const,
            message: "This bracket has finished. Voting is closed.",
          };
        }
        const roundIds = db.rounds
          .filter((r) => r.bracketId === bracketId && r.status === "ACTIVE")
          .map((r) => r.id);
        const matchups = db.matchups
          .filter(
            (m) =>
              roundIds.includes(m.roundId) && (m.status === "ACTIVE" || m.status === "TIE_BREAKER"),
          )
          .sort((a, b) => a.position - b.position)
          .map((m) => toSummary(db, m));
        if (matchups.length === 0) {
          return {
            kind: "message" as const,
            message: "Voting isn't open right now - check back soon for the next round.",
          };
        }
        return { kind: "matchups" as const, matchups };
      });
    },

    async getMatchup(bracketId: string, matchupId: string): Promise<MatchupVotingView> {
      const caller = await getCaller();
      return withSweep((db) => {
        const bracket = db.brackets.find((b) => b.id === bracketId);
        if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
        const matchup = db.matchups.find((m) => m.id === matchupId);
        if (!matchup) fail("MATCHUP_NOT_FOUND", "This matchup no longer exists.", 404);
        const round = db.rounds.find((r) => r.id === matchup.roundId)!;

        const identity = caller ? caller.userId : anonymousId();
        const existing = db.votes.find(
          (v) =>
            v.matchupId === matchupId &&
            (caller ? v.userId === identity : v.anonymousVoterIdentifier === identity) &&
            v.phase === (matchup.status === "TIE_BREAKER" ? "TIE_BREAKER" : "ORIGINAL"),
        );

        const blocked = !caller && bracket.votingRequirement === "ACCOUNT_REQUIRED";
        const counts = tallies(db, matchupId);

        return {
          matchup: toSummary(db, matchup),
          bracketTitle: bracket.title,
          isTieBreaker: matchup.status === "TIE_BREAKER",
          countdownEndsAt:
            matchup.status === "TIE_BREAKER" ? matchup.tieBreakerEndsAt : round.endsAt,
          voter: blocked
            ? { kind: "blocked", message: "Sign in to vote on this bracket." }
            : {
                kind: "eligible",
                existingVoteItemId: existing ? existing.itemId : null,
                voteCounts: existing ? counts : null,
              },
        };
      });
    },

    async castVote(matchupId: string, input: CastVoteRequest): Promise<CastVoteResponse> {
      const caller = await getCaller();
      return withSweep((db) => {
        const matchup = db.matchups.find((m) => m.id === matchupId);
        if (!matchup) fail("MATCHUP_NOT_FOUND", "This matchup no longer exists.", 404);
        if (input.itemId !== matchup.itemAId && input.itemId !== matchup.itemBId) {
          fail("INVALID_ITEM", "That's not a valid choice for this matchup.", 400);
        }
        const round = db.rounds.find((r) => r.id === matchup.roundId)!;
        if (round.status !== "ACTIVE") {
          fail("ROUND_CLOSED", "Voting has closed for this round.", 409);
        }
        if (matchup.status !== "ACTIVE" && matchup.status !== "TIE_BREAKER") {
          fail("MATCHUP_NOT_VOTABLE", "Voting isn't open for this matchup.", 409);
        }
        const bracket = db.brackets.find((b) => b.id === round.bracketId)!;
        if (!caller && bracket.votingRequirement === "ACCOUNT_REQUIRED") {
          fail("SIGN_IN_REQUIRED", "Sign in to vote on this bracket.", 401);
        }

        const phase = matchup.status === "TIE_BREAKER" ? "TIE_BREAKER" : "ORIGINAL";
        const identity = caller ? caller.userId : anonymousId();
        const matches = (v: VoteRow) =>
          caller ? v.userId === identity : v.anonymousVoterIdentifier === identity;

        const existing = db.votes.find(
          (v) => v.matchupId === matchupId && v.phase === phase && matches(v),
        );
        if (existing) return { votedItemId: existing.itemId, alreadyVoted: true };

        const recent = db.votes.filter(
          (v) => matches(v) && Date.now() - Date.parse(v.createdAt) < VOTE_RATE_WINDOW_MS,
        );
        if (recent.length >= VOTE_RATE_LIMIT) {
          fail(
            "RATE_LIMITED",
            "You've cast a lot of votes very quickly - please wait a few minutes and try again.",
            429,
          );
        }

        const comment = input.comment?.trim() ?? "";
        if (comment.length > MAX_COMMENT_LENGTH) {
          fail("COMMENT_TOO_LONG", "Comments can be at most 500 characters.", 400);
        }

        db.votes.push({
          id: uid(),
          matchupId,
          itemId: input.itemId,
          userId: caller ? caller.userId : null,
          anonymousVoterIdentifier: caller ? null : identity,
          comment: comment.length > 0 ? comment : null,
          phase,
          createdAt: nowIso(),
        });
        return { votedItemId: input.itemId, alreadyVoted: false };
      });
    },

    async getMatchupResult(bracketId: string, matchupId: string): Promise<MatchupResult> {
      return withSweep((db) => {
        const matchup = db.matchups.find((m) => m.id === matchupId);
        if (!matchup) fail("MATCHUP_NOT_FOUND", "This matchup no longer exists.", 404);
        if (matchup.status !== "COMPLETED") return { kind: "not_completed" as const };
        if (!matchup.itemBId) {
          return { kind: "bye" as const, advancingItem: item(db, matchup.itemAId)! };
        }
        const counts = tallies(db, matchupId);
        const winnerId = matchup.winnerItemId!;
        const loserId = winnerId === matchup.itemAId ? matchup.itemBId : matchup.itemAId!;
        const hadTieBreakerVotes = db.votes.some(
          (v) => v.matchupId === matchupId && v.phase === "TIE_BREAKER",
        );
        const originalCounts = tallies(db, matchupId, "ORIGINAL");
        const decidedByTieBreaker =
          hadTieBreakerVotes ||
          (originalCounts[matchup.itemAId!] ?? 0) === (originalCounts[matchup.itemBId] ?? 0);
        return {
          kind: "decided" as const,
          winner: item(db, winnerId)!,
          winnerVoteCount: counts[winnerId] ?? 0,
          loser: item(db, loserId)!,
          loserVoteCount: counts[loserId] ?? 0,
          decidedByTieBreaker,
          comments: db.votes
            .filter((v) => v.matchupId === matchupId && v.comment)
            .map((v) => ({
              id: v.id,
              comment: v.comment!,
              itemId: v.itemId,
              createdAt: v.createdAt,
            })),
        };
      });
    },

    async getBracketTree(bracketId: string): Promise<BracketTree> {
      return withSweep((db) => {
        const bracket = db.brackets.find((b) => b.id === bracketId);
        if (!bracket) fail("NOT_FOUND", "This bracket no longer exists.", 404);
        const totalRounds = totalRoundsFor(itemsOf(db, bracketId).length);
        const rounds: BracketTreeRound[] = [];
        for (let n = 1; n <= Math.max(totalRounds, 1); n++) {
          const round = db.rounds.find((r) => r.bracketId === bracketId && r.roundNumber === n);
          const cells: MatchupCell[] = round
            ? db.matchups
                .filter((m) => m.roundId === round.id)
                .sort((a, b) => a.position - b.position)
                .map((m) => toCell(db, m))
            : [];
          rounds.push({
            roundNumber: n,
            label: roundLabel(n, totalRounds),
            status: round ? round.status : ("NOT_STARTED" as const),
            cells,
          });
        }

        let champion: BracketTree["champion"] = null;
        if (bracket.status === "COMPLETED") {
          const finalRound = db.rounds
            .filter((r) => r.bracketId === bracketId)
            .sort((a, b) => b.roundNumber - a.roundNumber)[0];
          const finalMatchup = finalRound
            ? db.matchups.find((m) => m.roundId === finalRound.id)
            : undefined;
          if (finalMatchup?.winnerItemId) {
            const counts = tallies(db, finalMatchup.id);
            champion = {
              item: item(db, finalMatchup.winnerItemId)!,
              finalTally: [finalMatchup.itemAId, finalMatchup.itemBId]
                .filter((id): id is string => Boolean(id))
                .map((id) => ({ item: item(db, id)!, votes: counts[id] ?? 0 })),
            };
          }
        }

        return {
          bracketTitle: bracket.title,
          bracketStatus: bracket.status,
          totalRounds,
          rounds,
          champion,
        };
      });
    },

    async listPublic(): Promise<DiscoverResponse> {
      return withSweep((db) => {
        const toRow = (b: Bracket): DiscoverRow => ({
          id: b.id,
          title: b.title,
          status: b.status,
          publishedAt: b.publishedAt,
          creatorName: db.profiles[b.creatorId] ?? "A creator",
        });
        const publicBrackets = db.brackets
          .filter((b) => b.visibility === "PUBLIC" && b.status !== "DRAFT")
          .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
        return {
          recent: publicBrackets.filter((b) => b.status === "SCHEDULED").map(toRow),
          active: publicBrackets.filter((b) => b.status === "ACTIVE").map(toRow),
          completed: publicBrackets.filter((b) => b.status === "COMPLETED").map(toRow),
        };
      });
    },
  };
}

export const MOCK_GENERIC_ERROR = GENERIC_ERROR_MESSAGE;
