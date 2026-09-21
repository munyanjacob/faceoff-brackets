import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - the auth gate, that the
// bracket lookup is scoped to `id AND creatorId` together, the 409 not-draft
// check, that `validateRoundDurationForm`'s exact rules/error strings
// really do apply here unmodified (against the live item count, never a
// client-supplied total), and the response status/CORS headers - without a
// live database. End-to-end behaviour against real seeded data is covered
// separately in `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
const count = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bracket: { findFirst, update },
    bracketItem: { count },
  },
}));

const { PATCH, OPTIONS } = await import("./route");

const ALLOWED_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? "https://app.example.com";

function requestFor(
  bracketId: string,
  body: unknown,
  authorization?: string
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(`http://localhost/brackets/${bracketId}/round-duration`, {
    method: "PATCH",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawBodyRequest(bracketId: string, rawBody: string, authorization?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  headers.set("origin", ALLOWED_ORIGIN);
  return new Request(`http://localhost/brackets/${bracketId}/round-duration`, {
    method: "PATCH",
    headers,
    body: rawBody,
  });
}

function paramsFor(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

const DRAFT_BRACKET = { id: "bracket-1", creatorId: "creator-1", status: "DRAFT" };

describe("PATCH /brackets/{bracketId}/round-duration", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findFirst.mockReset();
    update.mockReset();
    count.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before ever looking the bracket up", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await PATCH(
      requestFor("bracket-1", { defaultRoundDurationMinutes: 60, overrides: {} }),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the bracket lookup to id AND creatorId together, never id alone", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);
    update.mockResolvedValue({});

    await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bracket-1", creatorId: "creator-1" },
    });
  });

  it("returns 404 NOT_FOUND (never 403) when the bracket doesn't exist or isn't owned by the caller", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);

    const response = await PATCH(
      requestFor(
        "missing",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("missing")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_DRAFT with the exact existing message when the bracket is no longer a draft", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue({ ...DRAFT_BRACKET, status: "ACTIVE" });

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message:
        "This bracket is no longer a draft, so its round durations can't be changed.",
    });
    expect(count).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string when defaultRoundDurationMinutes is missing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);

    const response = await PATCH(
      requestFor("bracket-1", { overrides: {} }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Default round duration is required.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string for a zero/negative default duration", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 0, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Default round duration must be a positive number of minutes.",
    });
  });

  it("returns 400 VALIDATION_ERROR with the exact per-round string for a non-whole override", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(8); // ceil(log2(8)) = 3 rounds

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: { "2": 12.5 } },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Round 2's duration must be a whole number of minutes.",
    });
  });

  it("returns 400 VALIDATION_ERROR with the exact per-round string for a zero/negative override", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(8);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: { "2": -5 } },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Round 2's duration must be a positive number of minutes.",
    });
  });

  it("recomputes totalRounds from the live item count server-side and silently ignores an override outside that range", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(3); // ceil(log2(3)) = 2 rounds - round 5 doesn't exist
    update.mockResolvedValue({ id: "bracket-1" });

    const response = await PATCH(
      requestFor(
        "bracket-1",
        {
          defaultRoundDurationMinutes: 60,
          overrides: { "1": 45, "5": 999 },
        },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        defaultRoundDurationMinutes: 60,
        roundDurationOverrides: { "1": 45 },
      },
    });
  });

  it("saves valid overrides keyed by absolute round number and returns the updated bracket", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(8);
    const updated = { id: "bracket-1", defaultRoundDurationMinutes: 90 };
    update.mockResolvedValue(updated);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        {
          defaultRoundDurationMinutes: 90,
          overrides: { "1": 120, "3": 30 },
        },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: {
        defaultRoundDurationMinutes: 90,
        roundDurationOverrides: { "1": 120, "3": 30 },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(updated);
  });

  it("treats a malformed JSON body the same as an empty one, rather than throwing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);

    const response = await PATCH(
      rawBodyRequest("bracket-1", "{not valid json", "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "Default round duration is required.",
    });
  });

  it("applies CORS headers on the 401, 404, 409, 400, and 200 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await PATCH(
      requestFor("bracket-1", { defaultRoundDurationMinutes: 60, overrides: {} }),
      paramsFor("bracket-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);
    const notFound = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({ ...DRAFT_BRACKET, status: "ACTIVE" });
    const notDraft = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );
    expect(notDraft.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);
    const invalid = await PATCH(
      requestFor("bracket-1", { overrides: {} }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    update.mockResolvedValue({});
    const ok = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("returns a generic 500 when the update fails unexpectedly, without leaking the error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    count.mockResolvedValue(4);
    update.mockRejectedValue(new Error("connection refused"));

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { defaultRoundDurationMinutes: 60, overrides: {} },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleError.mockRestore();
  });
});

describe("OPTIONS /brackets/{bracketId}/round-duration", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(
      requestFor("bracket-1", { defaultRoundDurationMinutes: 60, overrides: {} })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
