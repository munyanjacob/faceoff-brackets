import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `findExpiredRounds`/`evaluateRound` are mocked so this suite
// can assert on the route's own orchestration (auth gate, "call
// evaluateRound once per expired round", "one failure doesn't block the
// rest", "no expired rounds is a safe no-op") without a live database.
// End-to-end behaviour against real seeded data (round closes, matchups get
// winnerItemId, next round created, a tie leaves the round ACTIVE) is
// covered separately in route.integration.test.ts, the same split already
// used by find-expired-rounds/evaluate-round's own test suites.
const findExpiredRounds = vi.fn();
const evaluateRound = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/rounds/find-expired-rounds", () => ({ findExpiredRounds }));
vi.mock("@/lib/rounds/evaluate-round", () => ({ evaluateRound }));

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

  it("does not look up expired rounds when unauthorized", async () => {
    await GET(requestWithAuth());

    expect(findExpiredRounds).not.toHaveBeenCalled();
    expect(evaluateRound).not.toHaveBeenCalled();
  });

  it("is a safe no-op (still 200) when nothing has expired", async () => {
    findExpiredRounds.mockResolvedValue([]);

    const response = await GET(requestWithAuth("Bearer test-cron-secret"));

    expect(response.status).toBe(200);
    expect(evaluateRound).not.toHaveBeenCalled();
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
});
