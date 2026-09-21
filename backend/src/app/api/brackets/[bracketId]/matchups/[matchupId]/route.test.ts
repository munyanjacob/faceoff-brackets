import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/prisma` and `@/lib/api/auth` are mocked so this suite
// can assert on the route's own orchestration (matchup lookup scoped to
// the bracket, identity resolution, the countdown/isTieBreaker timestamp
// pick, the voteCounts gate) without a live database or a real Supabase
// call - same reasoning as ../route.test.ts and
// src/app/api/cron/advance-rounds/route.test.ts. `@/app/brackets/[id]/
// voting-view-model`'s `determineVoterContext` and `@/app/brackets/[id]/
// voter-identity`'s `currentVoterLookupKey` are *not* mocked - the first is
// pure and already covered by voting-view-model.test.ts; the second only
// needs `next/headers`'s `cookies()` mocked (see below) to run for real,
// which proves this route wires the cookie-reading path correctly, not
// just that it calls some mock. End-to-end behaviour against real seeded
// data (including the real Postgres vote-count/unique-constraint rows) is
// covered separately in route.integration.test.ts.
const matchupFindFirst = vi.fn();
const bracketFindUnique = vi.fn();
const voteFindFirst = vi.fn();
const voteCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    matchup: { findFirst: matchupFindFirst },
    bracket: { findUnique: bracketFindUnique },
    vote: { findFirst: voteFindFirst, count: voteCount },
  },
}));

const getAuthenticatedUserId = vi.fn();
vi.mock("@/lib/api/auth", () => ({ getAuthenticatedUserId }));

// A minimal in-memory cookie jar - same stand-in
// ../../../../brackets/[id]/vote-actions.integration.test.ts uses for
// `next/headers`'s `cookies()`, good enough to exercise the real
// `currentVoterLookupKey`/`verifyAnonymousVoterId` cookie-reading path.
let cookieJar: Map<string, string>;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  })),
}));

const { GET, OPTIONS } = await import("./route");
const { signAnonymousVoterId } = await import(
  "@/app/brackets/[id]/voter-identity"
);

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(
  bracketId: string,
  matchupId: string,
  { authorization, origin = ALLOWED_ORIGIN }: { authorization?: string; origin?: string } = {}
) {
  const headers = new Headers({ origin });
  if (authorization) headers.set("authorization", authorization);
  return new Request(
    `http://localhost/api/brackets/${bracketId}/matchups/${matchupId}`,
    { headers }
  );
}

function ctx(bracketId: string, matchupId: string) {
  return { params: Promise.resolve({ bracketId, matchupId }) };
}

function item(id: string) {
  return {
    id,
    bracketId: "bracket-1",
    title: `Item ${id}`,
    description: null,
    imageUrl: null,
    seed: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function baseMatchup(overrides: Record<string, unknown> = {}) {
  return {
    id: "matchup-1",
    status: "ACTIVE",
    tieBreakerEndsAt: null,
    itemA: item("item-a"),
    itemB: item("item-b"),
    round: {
      endsAt: new Date("2026-02-01T00:00:00.000Z"),
      bracket: {
        title: "Best Snacks",
        votingRequirement: "ANONYMOUS_ALLOWED",
      },
    },
    ...overrides,
  };
}

describe("GET /api/brackets/[bracketId]/matchups/[matchupId]", () => {
  beforeEach(() => {
    matchupFindFirst.mockReset();
    bracketFindUnique.mockReset();
    voteFindFirst.mockReset().mockResolvedValue(null);
    voteCount.mockReset().mockResolvedValue(0);
    getAuthenticatedUserId.mockReset().mockResolvedValue(null);
    cookieJar = new Map();
  });

  it("scopes the matchup lookup to the given bracketId via its round", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    await GET(requestFor("bracket-1", "matchup-1"), ctx("bracket-1", "matchup-1"));

    expect(matchupFindFirst).toHaveBeenCalledWith({
      where: { id: "matchup-1", round: { bracketId: "bracket-1" } },
      include: {
        itemA: true,
        itemB: true,
        round: { include: { bracket: true } },
      },
    });
  });

  it("returns 404 'This matchup no longer exists.' when the bracket exists but the matchup id doesn't match it", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue({ id: "bracket-1" });

    const response = await GET(
      requestFor("bracket-1", "missing-matchup"),
      ctx("bracket-1", "missing-matchup")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This matchup no longer exists.",
    });
  });

  it("returns 404 'This bracket no longer exists.' when the bracket itself doesn't exist", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(
      requestFor("missing-bracket", "matchup-1"),
      ctx("missing-bracket", "matchup-1")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  it("returns a full MatchupVotingView for an ACTIVE matchup with no existing vote", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bracketTitle).toBe("Best Snacks");
    expect(body.isTieBreaker).toBe(false);
    expect(body.countdownEndsAt).toBe("2026-02-01T00:00:00.000Z");
    expect(body.matchup).toEqual({
      id: "matchup-1",
      status: "ACTIVE",
      itemA: { ...item("item-a"), createdAt: item("item-a").createdAt.toISOString() },
      itemB: { ...item("item-b"), createdAt: item("item-b").createdAt.toISOString() },
    });
    expect(body.voter).toEqual({ kind: "eligible", existingVoteItemId: null });
    expect(body.voter.voteCounts).toBeUndefined();
  });

  it("uses the round's endsAt for countdownEndsAt on a normal ACTIVE matchup", async () => {
    matchupFindFirst.mockResolvedValue(
      baseMatchup({
        round: {
          endsAt: new Date("2026-05-05T05:00:00.000Z"),
          bracket: { title: "T", votingRequirement: "ANONYMOUS_ALLOWED" },
        },
      })
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.countdownEndsAt).toBe("2026-05-05T05:00:00.000Z");
    expect(body.isTieBreaker).toBe(false);
  });

  it("uses the matchup's own tieBreakerEndsAt, not the round's endsAt, once status is TIE_BREAKER", async () => {
    matchupFindFirst.mockResolvedValue(
      baseMatchup({
        status: "TIE_BREAKER",
        tieBreakerEndsAt: new Date("2026-06-06T06:00:00.000Z"),
        round: {
          // Already-passed round endsAt - must NOT be what's returned.
          endsAt: new Date("2020-01-01T00:00:00.000Z"),
          bracket: { title: "T", votingRequirement: "ANONYMOUS_ALLOWED" },
        },
      })
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.isTieBreaker).toBe(true);
    expect(body.countdownEndsAt).toBe("2026-06-06T06:00:00.000Z");
  });

  it("returns countdownEndsAt: null for a PENDING matchup whose round has no endsAt yet", async () => {
    matchupFindFirst.mockResolvedValue(
      baseMatchup({
        status: "PENDING",
        round: {
          endsAt: null,
          bracket: { title: "T", votingRequirement: "ANONYMOUS_ALLOWED" },
        },
      })
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.countdownEndsAt).toBeNull();
  });

  it("blocks a signed-out caller on an ACCOUNT_REQUIRED bracket, regardless of any voter_id cookie", async () => {
    cookieJar.set("voter_id", signAnonymousVoterId("some-anonymous-id"));
    matchupFindFirst.mockResolvedValue(
      baseMatchup({
        round: {
          endsAt: new Date(),
          bracket: { title: "T", votingRequirement: "ACCOUNT_REQUIRED" },
        },
      })
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.voter).toEqual({
      kind: "blocked",
      message: "Sign in to vote on this bracket.",
    });
  });

  it("resolves identity from the bearer token first when present", async () => {
    getAuthenticatedUserId.mockResolvedValue("user-123");
    matchupFindFirst.mockResolvedValue(baseMatchup());
    voteFindFirst.mockResolvedValue({ itemId: "item-a" });

    const response = await GET(
      requestFor("bracket-1", "matchup-1", { authorization: "Bearer good-token" }),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(voteFindFirst).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", phase: "ORIGINAL", userId: "user-123" },
    });
    expect(body.voter.existingVoteItemId).toBe("item-a");
  });

  it("falls back to the anonymous voter_id cookie when there's no bearer token", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    cookieJar.set("voter_id", signAnonymousVoterId("anon-abc"));
    matchupFindFirst.mockResolvedValue(baseMatchup());
    voteFindFirst.mockResolvedValue({ itemId: "item-b" });

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(voteFindFirst).toHaveBeenCalledWith({
      where: {
        matchupId: "matchup-1",
        phase: "ORIGINAL",
        anonymousVoterIdentifier: "anon-abc",
      },
    });
    expect(body.voter.existingVoteItemId).toBe("item-b");
  });

  it("treats a caller with neither a bearer token nor a cookie as a first-time voter - eligible, no lookup performed", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(voteFindFirst).not.toHaveBeenCalled();
    expect(body.voter).toEqual({ kind: "eligible", existingVoteItemId: null });
  });

  it("scopes the existing-vote lookup to the TIE_BREAKER phase while isTieBreaker, not the voter's ORIGINAL-phase vote", async () => {
    getAuthenticatedUserId.mockResolvedValue("user-123");
    matchupFindFirst.mockResolvedValue(
      baseMatchup({ status: "TIE_BREAKER", tieBreakerEndsAt: new Date() })
    );
    voteFindFirst.mockResolvedValue(null);

    await GET(requestFor("bracket-1", "matchup-1", { authorization: "Bearer t" }), ctx("bracket-1", "matchup-1"));

    expect(voteFindFirst).toHaveBeenCalledWith({
      where: { matchupId: "matchup-1", phase: "TIE_BREAKER", userId: "user-123" },
    });
  });

  it("includes voteCounts for both items only once the caller has an existing vote", async () => {
    getAuthenticatedUserId.mockResolvedValue("user-123");
    matchupFindFirst.mockResolvedValue(baseMatchup());
    voteFindFirst.mockResolvedValue({ itemId: "item-a" });
    voteCount.mockImplementation(async ({ where }: { where: { itemId: string } }) =>
      where.itemId === "item-a" ? 7 : 3
    );

    const response = await GET(
      requestFor("bracket-1", "matchup-1", { authorization: "Bearer t" }),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(body.voter).toEqual({
      kind: "eligible",
      existingVoteItemId: "item-a",
      voteCounts: { "item-a": 7, "item-b": 3 },
    });
    expect(voteCount).toHaveBeenCalledTimes(2);
  });

  it("never computes voteCounts (and omits the key entirely) for a voter who hasn't voted", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );
    const body = await response.json();

    expect(voteCount).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(body.voter, "voteCounts")).toBe(false);
  });

  it("applies CORS headers to a success response", async () => {
    matchupFindFirst.mockResolvedValue(baseMatchup());

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("applies CORS headers to a 404 error response", async () => {
    matchupFindFirst.mockResolvedValue(null);
    bracketFindUnique.mockResolvedValue(null);

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns the generic UNEXPECTED 500, with CORS headers, when the lookup throws", async () => {
    matchupFindFirst.mockRejectedValue(new Error("db exploded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      requestFor("bracket-1", "matchup-1"),
      ctx("bracket-1", "matchup-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    consoleError.mockRestore();
  });
});

describe("OPTIONS /api/brackets/[bracketId]/matchups/[matchupId]", () => {
  it("returns a 204 CORS preflight response", async () => {
    const response = OPTIONS(requestFor("bracket-1", "matchup-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(await response.text()).toBe("");
  });
});
