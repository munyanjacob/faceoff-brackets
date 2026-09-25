/**
 * Local persistence layer for the mock transport (see mockTransport.ts):
 * the in-browser schema (mirroring the backend's tables) plus load/save
 * against localStorage.
 */

import type { Bracket, BracketItem, MatchupStatus, RoundStatus } from "../types";
import { seed } from "./mockSeed";

export interface RoundRow {
  id: string;
  bracketId: string;
  roundNumber: number;
  durationMinutes: number;
  startsAt: string | null;
  endsAt: string | null;
  status: RoundStatus;
}

export interface MatchupRow {
  id: string;
  roundId: string;
  position: number;
  itemAId: string | null;
  itemBId: string | null;
  winnerItemId: string | null;
  status: MatchupStatus;
  tieBreakerEndsAt: string | null;
}

export interface VoteRow {
  id: string;
  matchupId: string;
  itemId: string;
  userId: string | null;
  anonymousVoterIdentifier: string | null;
  comment: string | null;
  phase: "ORIGINAL" | "TIE_BREAKER";
  createdAt: string;
}

export interface Db {
  brackets: Bracket[];
  items: BracketItem[];
  rounds: RoundRow[];
  matchups: MatchupRow[];
  votes: VoteRow[];
  profiles: Record<string, string | null>;
}

const DB_KEY = "bracket-arena-db-v1";
const ANON_KEY = "bracket-arena-voter-id";

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export const nowIso = () => new Date().toISOString();
export const plusMinutes = (from: Date, minutes: number) =>
  new Date(from.getTime() + minutes * 60_000).toISOString();

export function emptyDb(): Db {
  return { brackets: [], items: [], rounds: [], matchups: [], votes: [], profiles: {} };
}

/** All items belonging to a bracket, in seed/creation order. */
export function itemsOf(db: Db, bracketId: string): BracketItem[] {
  return db.items
    .filter((i) => i.bracketId === bracketId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

let cache: Db | null = null;

export function load(): Db {
  if (cache) return cache;
  if (typeof window === "undefined") {
    cache = emptyDb();
    return cache;
  }
  const raw = window.localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      cache = JSON.parse(raw) as Db;
      return cache;
    } catch {
      /* fall through to a fresh seed */
    }
  }
  cache = seed();
  save();
  return cache;
}

export function save() {
  if (typeof window === "undefined" || !cache) return;
  window.localStorage.setItem(DB_KEY, JSON.stringify(cache));
}

export function anonymousId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = window.localStorage.getItem(ANON_KEY);
  if (!id) {
    id = uid();
    window.localStorage.setItem(ANON_KEY, id);
  }
  return id;
}
