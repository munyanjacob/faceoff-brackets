import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: `@/lib/api/auth` and `@/lib/prisma` are mocked so this suite
// can assert on the route's own orchestration - the auth gate, the 404/409
// checks, and (crucially, the issue #53 behavior change) that
// `scheduledStartAt` is parsed as a real timezone-aware ISO-8601 instant -
// never reinterpreted as this process's local time - without a live
// database. End-to-end behaviour against real seeded data is covered
// separately in `./route.integration.test.ts`.
const getAuthenticatedUserId = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>();
  return { ...actual, getAuthenticatedUserId };
});
vi.mock("@/lib/prisma", () => ({
  prisma: { bracket: { findFirst, update } },
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
  return new Request(`http://localhost/brackets/${bracketId}/schedule`, {
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
  return new Request(`http://localhost/brackets/${bracketId}/schedule`, {
    method: "PATCH",
    headers,
    body: rawBody,
  });
}

function paramsFor(bracketId: string) {
  return { params: Promise.resolve({ bracketId }) };
}

const DRAFT_BRACKET = { id: "bracket-1", creatorId: "creator-1", status: "DRAFT" };

// Comfortably in the future/past of whenever this suite actually runs, and
// far enough out that a UTC-vs-local mixup in the *test* itself (not just
// the code under test) wouldn't accidentally make an assertion pass.
const FAR_FUTURE_UTC = "2999-01-01T00:00:00.000Z";
const FAR_PAST_UTC = "2000-01-01T00:00:00.000Z";

describe("PATCH /brackets/{bracketId}/schedule", () => {
  beforeEach(() => {
    getAuthenticatedUserId.mockReset();
    findFirst.mockReset();
    update.mockReset();
  });

  it("returns 401 with the shared UNAUTHORIZED body when there's no bearer token, before ever looking the bracket up", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);

    const response = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }),
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
    update.mockResolvedValue({});

    await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
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
      requestFor("missing", { startMode: "immediate" }, "Bearer token"),
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
        { startMode: "scheduled", scheduledStartAt: FAR_FUTURE_UTC },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "NOT_DRAFT",
      message: "This bracket is no longer a draft, so its start time can't be changed.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("saves a null scheduledStartAt when startMode is immediate", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    const updated = { id: "bracket-1", scheduledStartAt: null };
    update.mockResolvedValue(updated);

    const response = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: null },
    });
    expect(response.status).toBe(200);
    // roundDurationOverrides is normalized to {} even though the mocked
    // update() result above doesn't include it at all - see
    // brackets/[bracketId]/route.ts's identical normalization.
    await expect(response.json()).resolves.toEqual({
      ...updated,
      roundDurationOverrides: {},
    });
  });

  it("ignores scheduledStartAt entirely when startMode is immediate, even if it's malformed", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    update.mockResolvedValue({});

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { startMode: "immediate", scheduledStartAt: "not a date" },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: null },
    });
  });

  it("returns 400 VALIDATION_ERROR with the exact string for a missing scheduledStartAt when scheduled is chosen", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);

    const response = await PATCH(
      requestFor("bracket-1", { startMode: "scheduled" }, "Bearer token"),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "A scheduled start requires a valid date and time.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR with the exact string for an unparseable scheduledStartAt", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { startMode: "scheduled", scheduledStartAt: "not a date" },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "A scheduled start requires a valid date and time.",
    });
  });

  it("returns 400 VALIDATION_ERROR with the exact string for a past scheduledStartAt", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { startMode: "scheduled", scheduledStartAt: FAR_PAST_UTC },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "The scheduled start time must be in the future.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the parsed future UTC instant and returns the updated bracket", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    const updated = { id: "bracket-1", scheduledStartAt: FAR_FUTURE_UTC };
    update.mockResolvedValue(updated);

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { startMode: "scheduled", scheduledStartAt: FAR_FUTURE_UTC },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: new Date(FAR_FUTURE_UTC) },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...updated,
      roundDurationOverrides: {},
    });
  });

  // *** The behavior-change proof (issue #53 / spec §9.4) ***
  // A real ISO-8601 string carrying a non-UTC offset must be resolved to
  // its correct UTC instant - not passed through a local-time
  // reinterpretation the way the old datetime-local Server Action did.
  it("correctly parses a real ISO-8601 string with a non-UTC offset to its exact UTC instant, proving the timezone-handling fix", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    update.mockResolvedValue({ id: "bracket-1" });

    // "2999-01-01T09:00:00-04:00" is exactly "2999-01-01T13:00:00.000Z" -
    // 4 hours later in UTC than the offset-local clock face reads.
    const offsetInput = "2999-01-01T09:00:00-04:00";
    const expectedUtcInstant = new Date("2999-01-01T13:00:00.000Z");

    const response = await PATCH(
      requestFor(
        "bracket-1",
        { startMode: "scheduled", scheduledStartAt: offsetInput },
        "Bearer token"
      ),
      paramsFor("bracket-1")
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: expectedUtcInstant },
    });
    const [[call]] = update.mock.calls;
    expect(call.data.scheduledStartAt.toISOString()).toBe(
      "2999-01-01T13:00:00.000Z"
    );
  });

  it("treats a malformed JSON body the same as a missing scheduledStartAt error, rather than throwing", async () => {
    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(DRAFT_BRACKET);
    update.mockResolvedValue({ id: "bracket-1", scheduledStartAt: null });

    const response = await PATCH(
      rawBodyRequest("bracket-1", "{not valid json", "Bearer token"),
      paramsFor("bracket-1")
    );

    // A malformed body parses to `{}`, so `startMode` is `undefined` -
    // anything other than the literal "scheduled" is treated as
    // "immediate" (see validateScheduleRequest), which is valid and clears
    // scheduledStartAt rather than erroring.
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "bracket-1" },
      data: { scheduledStartAt: null },
    });
  });

  it("applies CORS headers on the 401, 404, 409, 400, and 200 paths", async () => {
    getAuthenticatedUserId.mockResolvedValue(null);
    const unauthorized = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }),
      paramsFor("bracket-1")
    );
    expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    getAuthenticatedUserId.mockResolvedValue("creator-1");
    findFirst.mockResolvedValue(null);
    const notFound = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notFound.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue({ ...DRAFT_BRACKET, status: "ACTIVE" });
    const notDraft = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(notDraft.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    findFirst.mockResolvedValue(DRAFT_BRACKET);
    const invalid = await PATCH(
      requestFor("bracket-1", { startMode: "scheduled" }, "Bearer token"),
      paramsFor("bracket-1")
    );
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );

    update.mockResolvedValue({});
    const ok = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
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
    update.mockRejectedValue(new Error("connection refused"));

    const response = await PATCH(
      requestFor("bracket-1", { startMode: "immediate" }, "Bearer token"),
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

describe("OPTIONS /brackets/{bracketId}/schedule", () => {
  it("returns a 204 preflight response with CORS headers", () => {
    const response = OPTIONS(requestFor("bracket-1", { startMode: "immediate" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});
