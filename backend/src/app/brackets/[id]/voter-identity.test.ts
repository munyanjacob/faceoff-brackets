import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const cookieGet = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: cookieGet,
  })),
}));

const {
  currentVoterLookupKey,
  signAnonymousVoterId,
  verifyAnonymousVoterId,
} = await import("./voter-identity");

describe("signAnonymousVoterId / verifyAnonymousVoterId (issue #35)", () => {
  const originalSecret = process.env.VOTE_COOKIE_SECRET;

  afterEach(() => {
    process.env.VOTE_COOKIE_SECRET = originalSecret;
  });

  it("round-trips: verifying a freshly signed id returns the original raw id", () => {
    const signed = signAnonymousVoterId("voter-abc-123");
    expect(verifyAnonymousVoterId(signed)).toBe("voter-abc-123");
  });

  it("produces a value distinct from the raw id (the id alone is not a valid signed cookie)", () => {
    const signed = signAnonymousVoterId("voter-abc-123");
    expect(signed).not.toBe("voter-abc-123");
    expect(signed.startsWith("voter-abc-123.")).toBe(true);
  });

  it("rejects a bare, unsigned value (e.g. a pre-#35 cookie, or no separator at all)", () => {
    expect(verifyAnonymousVoterId("voter-abc-123")).toBeNull();
  });

  it("rejects a signed cookie whose id portion has been hand-edited, even though the signature substring is untouched", () => {
    const signed = signAnonymousVoterId("voter-abc-123");
    const separatorIndex = signed.lastIndexOf(".");
    const signature = signed.slice(separatorIndex);
    const tampered = `voter-attacker-controlled-id${signature}`;

    expect(verifyAnonymousVoterId(tampered)).toBeNull();
  });

  it("rejects a signed cookie whose signature has been tampered with", () => {
    const signed = signAnonymousVoterId("voter-abc-123");
    const tampered = signed.slice(0, -1) + (signed.endsWith("0") ? "1" : "0");

    expect(verifyAnonymousVoterId(tampered)).toBeNull();
  });

  it("rejects a signature that isn't even the right length, without throwing", () => {
    expect(() => verifyAnonymousVoterId("voter-abc-123.ab")).not.toThrow();
    expect(verifyAnonymousVoterId("voter-abc-123.ab")).toBeNull();
  });

  it("a value signed under one VOTE_COOKIE_SECRET fails verification under a different one", () => {
    process.env.VOTE_COOKIE_SECRET = "secret-one";
    const signed = signAnonymousVoterId("voter-abc-123");

    process.env.VOTE_COOKIE_SECRET = "secret-two";
    expect(verifyAnonymousVoterId(signed)).toBeNull();
  });
});

describe("currentVoterLookupKey", () => {
  beforeEach(() => {
    cookieGet.mockReset();
  });

  it("returns the userId key when signed in, without consulting the cookie at all", async () => {
    const key = await currentVoterLookupKey("profile-1");
    expect(key).toEqual({ userId: "profile-1" });
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it("returns null when signed out and there is no anonymous cookie yet", async () => {
    cookieGet.mockReturnValue(undefined);
    const key = await currentVoterLookupKey(null);
    expect(key).toBeNull();
  });

  it("returns the verified anonymous identifier from a validly signed cookie", async () => {
    const signed = signAnonymousVoterId("voter-abc-123");
    cookieGet.mockReturnValue({ value: signed });

    const key = await currentVoterLookupKey(null);
    expect(key).toEqual({ anonymousVoterIdentifier: "voter-abc-123" });
  });

  it("returns null (not the tampered value) for a cookie with an invalid signature", async () => {
    cookieGet.mockReturnValue({ value: "attacker-chosen-id.not-a-real-signature" });

    const key = await currentVoterLookupKey(null);
    expect(key).toBeNull();
  });
});
