import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - the auth gate, the
// ownership-scoped lookup, the exact NOT_DRAFT/TOO_FEW_ITEMS business
// errors and their exact messages, the `buildRoundOnePlan`-driven
// transaction shape, and the response status/CORS headers - without a live
// database. End-to-end behaviour against real seeded data (the actual
// persisted Round/Matchup rows) is covered separately in
// `./route.integration.test.ts`, mirroring
// `../../../../dashboard/brackets/[id]/edit/publish-actions.test.ts` /
// `.integration.test.ts`, the Server Action this route wraps.
const getAuthenticatedUserId = vi.fn();
const bracketFindFirst = vi.fn();
const bracketUpdate = vi.fn();
const itemCount = vi.fn();
const itemFindMany = vi.fn();
const roundCreate = vi.fn();

// `$transaction` is exercised with an interactive-transaction callback, the
// same shape Prisma itself calls with a `tx` client - here `tx` is just the
// same mocked `bracket`/`round`, so assertions below can keep asserting
// against `bracketUpdate`/`roundCreate` directly.
const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    bracket: { update: bracketUpdate },
    round: { create: roundCreate },
  })
);

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst: bracketFindFirst, update: bracketUpdate },
    bracketItem: { count: itemCount, findMany: itemFindMany },
    round: { create: roundCreate },
    $transaction: transaction,
  },
}));

const { POST, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function publishRequest(bracketId: string, authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(`http://localhost/brackets/${bracketId}/publish`, {
    method: "POST",
    headers,
  });
}

function context(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

const DRAFT_BRACKET = {
  id: "bracket-1",
  creatorId: "creator-1",
  status: "DRAFT",
  scheduledStartAt: null,
  defaultRoundDurationMinutes: 60,
  roundDurationOverrides: null,
};

describe("POST /brackets/{bracketId}/publish", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    bracketFindFirst.mockReset();
    bracketUpdate.mockReset();
    itemCount.mockReset();
    itemFindMany.mockReset();
    roundCreate.mockReset();
    transaction.mockClear();

    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);
    bracketUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...DRAFT_BRACKET,
      ...(data as object),
    }));
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await POST(publishRequest("bracket-1"), context("bracket-1"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(bracketFindFirst).not.toHaveBeenCalled();
  });

  it("looks the bracket up scoped to the signed-in creator, not by id alone", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValue(2);

    await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(bracketFindFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("returns 404 NOT_FOUND when the bracket doesn't exist or isn't owned by the caller", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue(null);

    const response = await POST(
      publishRequest("someone-elses-bracket", "Bearer token"),
      context("someone-elses-bracket")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_DRAFT with the exact existing message when the bracket is already ACTIVE", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET, status: "ACTIVE" });

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message: "This bracket has already been published.",
    });
    expect(itemCount).not.toHaveBeenCalled();
    expect(bracketUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_DRAFT when the bracket is already SCHEDULED", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({
      ...DRAFT_BRACKET,
      status: "SCHEDULED",
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
    });

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message: "This bracket has already been published.",
    });
  });

  it("returns 409 NOT_DRAFT when the bracket is already COMPLETED", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET, status: "COMPLETED" });

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message: "This bracket has already been published.",
    });
  });

  it("returns 409 TOO_FEW_ITEMS with the exact existing message when there is only 1 item", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValue(1);

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "TOO_FEW_ITEMS",
      message: "Add at least 2 items before publishing this bracket.",
    });
    expect(bracketUpdate).not.toHaveBeenCalled();
    expect(itemFindMany).not.toHaveBeenCalled();
    expect(roundCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns 409 TOO_FEW_ITEMS when there are zero items", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValue(0);

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "TOO_FEW_ITEMS",
      message: "Add at least 2 items before publishing this bracket.",
    });
  });

  it("fetches items in the same order (createdAt ascending) the preview/publish Server Action uses", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValue(2);

    await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(itemFindMany).toHaveBeenCalledWith({
      where: { bracketId: "bracket-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("publishes to ACTIVE, creates an ACTIVE Round with ACTIVE Matchups, and returns the updated Bracket, for an immediate start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({
      ...DRAFT_BRACKET,
      defaultRoundDurationMinutes: 45,
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        status: "ACTIVE",
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(roundCreate).toHaveBeenCalledWith({
      data: {
        bracketId: "bracket-1",
        roundNumber: 1,
        durationMinutes: 45,
        status: "ACTIVE",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-01-01T00:45:00.000Z"),
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-2",
              winnerItemId: null,
              status: "ACTIVE",
            },
          ],
        },
      },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "bracket-1",
      status: "ACTIVE",
    });

    vi.useRealTimers();
  });

  it("publishes to SCHEDULED with a PENDING Round/Matchups and no starts/ends, when a future start time was chosen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({
      ...DRAFT_BRACKET,
      scheduledStartAt: new Date("2026-06-01T09:00:00.000Z"),
    });
    itemCount.mockResolvedValue(2);
    itemFindMany.mockResolvedValue([{ id: "item-1" }, { id: "item-2" }]);

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(bracketUpdate).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        status: "SCHEDULED",
        publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "PENDING",
        startsAt: null,
        endsAt: null,
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: "item-2",
              winnerItemId: null,
              status: "PENDING",
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);

    vi.useRealTimers();
  });

  it("creates a bye Matchup (itemBId null, winner already set, COMPLETED) regardless of immediate vs. scheduled start", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    // 3 items -> next power of two is 4 -> 1 bye + 1 real matchup.
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValue(3);
    itemFindMany.mockResolvedValue([
      { id: "item-1" },
      { id: "item-2" },
      { id: "item-3" },
    ]);

    await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchups: {
          create: [
            {
              itemAId: "item-1",
              itemBId: null,
              winnerItemId: "item-1",
              status: "COMPLETED",
            },
            {
              itemAId: "item-2",
              itemBId: "item-3",
              winnerItemId: null,
              status: "ACTIVE",
            },
          ],
        },
      }),
    });
  });

  it("uses Bracket.roundDurationOverrides['1'] for round 1's duration when present, over the default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({
      ...DRAFT_BRACKET,
      defaultRoundDurationMinutes: 60,
      roundDurationOverrides: { "1": 15 },
    });
    itemCount.mockResolvedValue(2);

    await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(roundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        durationMinutes: 15,
        endsAt: new Date("2026-01-01T00:15:00.000Z"),
      }),
    });

    vi.useRealTimers();
  });

  it("applies CORS headers on every response - unauthorized, not found, business error, and success", async () => {
    getAuthenticatedUserId.mockResolvedValueOnce(null);
    const unauthorized = await POST(publishRequest("bracket-1"), context("bracket-1"));
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValueOnce("creator-1");
    bracketFindFirst.mockResolvedValueOnce(null);
    const notFound = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValueOnce("creator-1");
    bracketFindFirst.mockResolvedValueOnce({ ...DRAFT_BRACKET, status: "ACTIVE" });
    const conflict = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));
    expect(conflict.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValueOnce("creator-1");
    bracketFindFirst.mockResolvedValueOnce({ ...DRAFT_BRACKET });
    itemCount.mockResolvedValueOnce(2);
    const success = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));
    expect(success.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });

  it("returns a generic 500 when publishing fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    bracketFindFirst.mockResolvedValue({ ...DRAFT_BRACKET });
    itemCount.mockRejectedValue(new Error("connection reset"));

    const response = await POST(publishRequest("bracket-1", "Bearer token"), context("bracket-1"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}/publish", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(publishRequest("bracket-1"));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
