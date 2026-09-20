import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `findExpiredRounds`/`evaluateRound` (#27, step 1) and
// `findExpiredTieBreakers`/`resolveTieBreaker` (#29, step 2) are all mocked
// so this suite can assert on the route's own orchestration (auth gate,
// "call evaluateRound once per expired round", "call resolveTieBreaker once
// per expired tie-breaker", "one failure doesn't block the rest of either
// step", "nothing expired in either step is a safe no-op") without a live
// database. End-to-end behaviour against real seeded data (round closes,
// matchups get winnerItemId, next round created, a tie leaves the round
// ACTIVE, an expired tie-breaker resolves and closes its round) is covered
// separately in route.integration.test.ts, the same split already used by
// find-expired-rounds/evaluate-round's own test suites.
const findExpiredRounds = vi.fn();
const evaluateRound = vi.fn();
const findExpiredTieBreakers = vi.fn();
const resolveTieBreaker = vi.fn();
const findDueScheduledBrackets = vi.fn();
const startScheduledBracket = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/rounds/find-expired-rounds", () => ({ findExpiredRounds }));
vi.mock("@/lib/rounds/evaluate-round", () => ({ evaluateRound }));
vi.mock("@/lib/rounds/find-expired-tie-breakers", () => ({
  findExpiredTieBreakers,
}));
vi.mock("@/lib/rounds/resolve-tie-breaker", () => ({ resolveTieBreaker }));
vi.mock("@/lib/rounds/find-due-scheduled-brackets", () => ({
  findDueScheduledBrackets,
}));
vi.mock("@/lib/rounds/start-scheduled-bracket", () => ({ startScheduledBracket }));

const { GET } = await import("./route");

function requestWithAuth(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/cron/advance-rounds", { headers });
}

describe("GET /api/cron/advance-rounds", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    findExpiredRounds.mockReset().mockResolvedValue([]);
    evaluateRound.mockReset().mockResolvedValue(undefined);
    findExpiredTieBreakers.mockReset().mockResolvedValue([]);
    resolveTieBreaker.mockReset().mockResolvedValue(undefined);
    findDueScheduledBrackets.mockReset().mockResolvedValue([]);
    startScheduledBracket.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("returns 200 when called with a valid bearer token", async () => {
    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const response = await GET(requestWithAuth());

    expect(response.status).toBe(401);
  });

  it("returns 401 when the bearer token is incorrect", async () => {
    const response = await GET(requestWithAuth("Bearer wrong-secret"));

    expect(response.status).toBe(401);
  });

  it("returns 401 when the Authorization header has no Bearer prefix", async () => {
    const response = await GET(requestWithAuth("test-cron-secret"));

    expect(response.status).toBe(401);
  });

  it("reads the secret from the environment, not a hardcoded value", async () => {
    process.env.CRON_SECRET = "a-different-secret";

    const staleResponse = await GET(requestWithAuth("Bearer test-cron-secret"));
    expect(staleResponse.status).toBe(401);

    const freshResponse = await GET(requestWithAuth("Bearer a-different-secret"));
    expect(freshResponse.status).toBe(200);
  });

  it("returns 401 (rather than throwing/matching) when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(requestWithAuth("Bearer undefined"));

    expect(response.status).toBe(401);
  });

  it("does not look up expired rounds, tie-breakers, or due scheduled brackets when unauthorized", async () => {
    await GET(requestWithAuth());

    expect(findExpiredRounds).not.toHaveBeenCalled();
    expect(evaluateRound).not.toHaveBeenCalled();
    expect(findExpiredTieBreakers).not.toHaveBeenCalled();
    expect(resolveTieBreaker).not.toHaveBeenCalled();
    expect(findDueScheduledBrackets).not.toHaveBeenCalled();
    expect(startScheduledBracket).not.toHaveBeenCalled();
  });

  it("is a safe no-op (still 200) when nothing has expired/is due in any step", async () => {
    findExpiredRounds.mockResolvedValue([]);
    findExpiredTieBreakers.mockResolvedValue([]);
    findDueScheduledBrackets.mockResolvedValue([]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).not.toHaveBeenCalled();
    expect(resolveTieBreaker).not.toHaveBeenCalled();
    expect(startScheduledBracket).not.toHaveBeenCalled();
  });

  it("calls evaluateRound once per expired round returned by findExpiredRounds", async () => {
    findExpiredRounds.mockResolvedValue([
      { id: "round-1" },
      { id: "round-2" },
      { id: "round-3" },
    ]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).toHaveBeenCalledTimes(3);
    expect(evaluateRound).toHaveBeenNthCalledWith(1, "round-1");
    expect(evaluateRound).toHaveBeenNthCalledWith(2, "round-2");
    expect(evaluateRound).toHaveBeenNthCalledWith(3, "round-3");
  });

  it("logs and continues when one round's evaluateRound rejects, still evaluating the rest and returning 200", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    findExpiredRounds.mockResolvedValue([
      { id: "bad-round" },
      { id: "good-round" },
    ]);
    evaluateRound.mockImplementation(async (roundId: string) => {
      if (roundId === "bad-round") {
        throw new Error("boom");
      }
    });

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).toHaveBeenCalledTimes(2);
    expect(evaluateRound).toHaveBeenCalledWith("bad-round");
    expect(evaluateRound).toHaveBeenCalledWith("good-round");
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("calls resolveTieBreaker once per expired tie-breaker returned by findExpiredTieBreakers, after step 1", async () => {
    findExpiredRounds.mockResolvedValue([{ id: "round-1" }]);
    findExpiredTieBreakers.mockResolvedValue([
      { id: "matchup-1" },
      { id: "matchup-2" },
    ]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).toHaveBeenCalledTimes(1);
    expect(resolveTieBreaker).toHaveBeenCalledTimes(2);
    expect(resolveTieBreaker).toHaveBeenNthCalledWith(1, "matchup-1");
    expect(resolveTieBreaker).toHaveBeenNthCalledWith(2, "matchup-2");
  });

  it("runs step 2 (tie-breakers) even when step 1 (rounds) found nothing expired", async () => {
    findExpiredRounds.mockResolvedValue([]);
    findExpiredTieBreakers.mockResolvedValue([{ id: "matchup-1" }]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).not.toHaveBeenCalled();
    expect(resolveTieBreaker).toHaveBeenCalledTimes(1);
    expect(resolveTieBreaker).toHaveBeenCalledWith("matchup-1");
  });

  it("logs and continues when one matchup's resolveTieBreaker rejects, still resolving the rest and returning 200", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    findExpiredTieBreakers.mockResolvedValue([
      { id: "bad-matchup" },
      { id: "good-matchup" },
    ]);
    resolveTieBreaker.mockImplementation(async (matchupId: string) => {
      if (matchupId === "bad-matchup") {
        throw new Error("boom");
      }
    });

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(resolveTieBreaker).toHaveBeenCalledTimes(2);
    expect(resolveTieBreaker).toHaveBeenCalledWith("bad-matchup");
    expect(resolveTieBreaker).toHaveBeenCalledWith("good-matchup");
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("calls startScheduledBracket once per due bracket returned by findDueScheduledBrackets", async () => {
    findDueScheduledBrackets.mockResolvedValue([
      { id: "bracket-1" },
      { id: "bracket-2" },
    ]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(startScheduledBracket).toHaveBeenCalledTimes(2);
    expect(startScheduledBracket).toHaveBeenNthCalledWith(1, "bracket-1");
    expect(startScheduledBracket).toHaveBeenNthCalledWith(2, "bracket-2");
  });

  it("runs step 3 (scheduled brackets) even when steps 1 and 2 found nothing", async () => {
    findExpiredRounds.mockResolvedValue([]);
    findExpiredTieBreakers.mockResolvedValue([]);
    findDueScheduledBrackets.mockResolvedValue([{ id: "bracket-1" }]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).not.toHaveBeenCalled();
    expect(resolveTieBreaker).not.toHaveBeenCalled();
    expect(startScheduledBracket).toHaveBeenCalledTimes(1);
    expect(startScheduledBracket).toHaveBeenCalledWith("bracket-1");
  });

  it("logs and continues when one bracket's startScheduledBracket rejects, still starting the rest and returning 200", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    findDueScheduledBrackets.mockResolvedValue([
      { id: "bad-bracket" },
      { id: "good-bracket" },
    ]);
    startScheduledBracket.mockImplementation(async (bracketId: string) => {
      if (bracketId === "bad-bracket") {
        throw new Error("boom");
      }
    });

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(startScheduledBracket).toHaveBeenCalledTimes(2);
    expect(startScheduledBracket).toHaveBeenCalledWith("bad-bracket");
    expect(startScheduledBracket).toHaveBeenCalledWith("good-bracket");
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("reports counts for all three steps in the JSON response", async () => {
    findExpiredRounds.mockResolvedValue([{ id: "round-1" }]);
    findExpiredTieBreakers.mockResolvedValue([{ id: "matchup-1" }]);
    findDueScheduledBrackets.mockResolvedValue([{ id: "bracket-1" }]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));
    const body = await response.json();

    expect(body).toEqual({
      ok: true,
      expired: 1,
      evaluated: 1,
      failed: 0,
      expiredTieBreakers: 1,
      tieBreakersResolved: 1,
      tieBreakersFailed: 0,
      dueScheduledBrackets: 1,
      bracketsStarted: 1,
      bracketsStartFailed: 0,
    });
  });
});
