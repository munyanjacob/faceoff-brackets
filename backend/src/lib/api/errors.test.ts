import { describe, expect, test, vi } from "vitest";
import {
  errorResponse,
  unexpectedErrorResponse,
  withErrorHandling,
} from "./errors";

describe("errorResponse", () => {
  test("builds the exact {code, message} JSON shape at the given status", async () => {
    const response = errorResponse(404, "NOT_FOUND", "This bracket no longer exists.");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "This bracket no longer exists.",
    });
  });

  test("supports an arbitrary (status, code, message) combination", async () => {
    const response = errorResponse(
      429,
      "RATE_LIMITED",
      "You've cast a lot of votes very quickly - please wait a few minutes and try again."
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      code: "RATE_LIMITED",
      message:
        "You've cast a lot of votes very quickly - please wait a few minutes and try again.",
    });
  });

  test("another combination - 409 business error", async () => {
    const response = errorResponse(
      409,
      "MATCHUP_NOT_VOTABLE",
      "Voting isn't open for this matchup."
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "MATCHUP_NOT_VOTABLE",
      message: "Voting isn't open for this matchup.",
    });
  });

  test("sets a JSON content-type header", () => {
    const response = errorResponse(400, "VALIDATION_ERROR", "Title is required.");

    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });
});

describe("unexpectedErrorResponse", () => {
  test("is the generic UNEXPECTED 500", async () => {
    const response = unexpectedErrorResponse();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
  });
});

describe("withErrorHandling", () => {
  test("passes through a handler's successful response untouched", async () => {
    const handler = withErrorHandling(async () => {
      return Response.json({ ok: true }, { status: 201 });
    });

    const response = await handler();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("catches a thrown error and returns the generic 500 without leaking its message", async () => {
    const secretDetail = "duplicate key value violates unique constraint";
    const handler = withErrorHandling(async () => {
      throw new Error(secretDetail);
    });

    // Silence the expected console.error from the handler's own logging.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handler();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secretDetail);
    expect(serialized).not.toContain("Error");

    consoleSpy.mockRestore();
  });

  test("catches a thrown non-Error value the same way", async () => {
    const handler = withErrorHandling(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "a plain string, not an Error instance";
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handler();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "UNEXPECTED",
      message: "Something went wrong. Please try again.",
    });

    consoleSpy.mockRestore();
  });

  test("forwards the handler's arguments (e.g. request, route context)", async () => {
    const handler = withErrorHandling(
      async (request: Request, id: string) => {
        return Response.json({ url: request.url, id });
      }
    );

    const request = new Request("https://api.example.com/brackets/abc");
    const response = await handler(request, "abc");

    expect(await response.json()).toEqual({
      url: "https://api.example.com/brackets/abc",
      id: "abc",
    });
  });
});
