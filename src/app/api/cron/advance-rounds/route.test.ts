import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "./route";

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
});
