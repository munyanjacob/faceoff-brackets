import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises issue #55's GET /api/brackets/[bracketId]/matchups/[matchupId]
// end-to-end against the real, disposable Supabase/Postgres project
// configured in `.env.local`: seeds real `Profile`/`Bracket`/`BracketItem`/
// `Round`/`Matchup`/`Vote` rows via `prisma`, calls the real (unmocked)
// route handler, and asserts on the resulting JSON. Same live-database
// pattern as `../../../../../brackets/[id]/vote-actions.integration.test.ts`
// - see that file for the fuller rationale.
//
// `@/lib/api/auth`'s `getAuthenticatedUserId` is mocked (a plain function
// swap, not a live Supabase token exchange) - its own token-verification
// logic is already proven for real against `@supabase/supabase-js` in
// `src/lib/api/auth.test.ts`; re-proving that here would need a real
// Supabase project/JWT and would test Supabase, not this route. This suite
// instead proves the real DB-backed parts: the matchup/round/bracket
// lookup, the real anonymous-voter cookie verification
// (`currentVoterLookupKey`/`verifyAnonymousVoterId`, unmocked), the real
// `Vote` row lookup/count, and the response shaping - the same split
// `vote-actions.integration.test.ts` already uses for `@/lib/supabase/
// server`.
let currentUserId: string | undefined;

vi.mock("@/lib/api/auth", () => ({
  getAuthenticatedUserId: vi.fn(async () => currentUserId ?? null),
}));

// Minimal in-memory cookie jar standing in for `next/headers`'s `cookies()`
// - same stand-in `vote-actions.integration.test.ts` uses.
let cookieJar: Map<string, string>;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  })),
}));

function fixDatabaseUrlFromEnvFile(): string | undefined {
  delete process.env.DATABASE_URL;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is gitignored and may not exist (e.g. CI) - fall through
    // with DATABASE_URL left unset, same as prisma7.config.ts.
  }
  return process.env.DATABASE_URL;
}

const hasLiveDatabase = Boolean(fixDatabaseUrlFromEnvFile());

describe.runIf(hasLiveDatabase)(
  "GET /api/brackets/[bracketId]/matchups/[matchupId], against the live database",
  () => {
    let prisma: Awaited<typeof import("@/lib/prisma")>["prisma"];
    let GET: typeof import("./route").GET;
    let signAnonymousVoterId: typeof import(
      "@/app/brackets/[id]/voter-identity"
    ).signAnonymousVoterId;

    const creatorId = randomUUID();
    const voterProfileId = randomUUID();
    const bracketIds: string[] = [];
    const profileIds: string[] = [];

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      ({ GET } = await import("./route"));
      ({ signAnonymousVoterId } = await import(
        "@/app/brackets/[id]/voter-identity"
      ));

      await prisma.profile.createMany({
        data: [
          {
            id: creatorId,
            email: `matchup-view-e2e-creator-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
          {
            id: voterProfileId,
            email: `matchup-view-e2e-voter-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}@example.test`,
          },
        ],
      });
      profileIds.push(creatorId, voterProfileId);
    });

    beforeEach(() => {
      currentUserId = undefined;
      cookieJar = new Map();
    });

    afterAll(async () => {
      await prisma.vote.deleteMany({
        where: { matchup: { round: { bracketId: { in: bracketIds } } } },
      });
      await prisma.matchup.deleteMany({
        where: { round: { bracketId: { in: bracketIds } } },
      });
      await prisma.round.deleteMany({ where: { bracketId: { in: bracketIds } } });
      await prisma.bracketItem.deleteMany({
        where: { bracketId: { in: bracketIds } },
      });
      await prisma.bracket.deleteMany({ where: { id: { in: bracketIds } } });
      await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
      await prisma.$disconnect();
    });

    async function makeBracket(
      title: string,
      votingRequirement: "ANONYMOUS_ALLOWED" | "ACCOUNT_REQUIRED" = "ANONYMOUS_ALLOWED"
    ) {
      const bracket = await prisma.bracket.create({
        data: {
          creatorId,
          title,
          visibility: "PUBLIC",
          votingRequirement,
          defaultRoundDurationMinutes: 60,
          status: "ACTIVE",
          publishedAt: new Date(),
        },
      });
      bracketIds.push(bracket.id);
      return bracket;
    }

    async function makeItems(bracketId: string, count: number) {
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push(
          await prisma.bracketItem.create({
            data: { bracketId, title: `Item ${i + 1}` },
          })
        );
      }
      return items;
    }

    function requestFor(bracketId: string, matchupId: string) {
      return new Request(
        `http://localhost/api/brackets/${bracketId}/matchups/${matchupId}`
      );
    }

    function ctx(bracketId: string, matchupId: string) {
      return { params: Promise.resolve({ bracketId, matchupId }) };
    }

    it("returns 404 when the matchup doesn't belong to the given bracket", async () => {
      const bracketA = await makeBracket("Detail E2E - bracket A");
      const bracketB = await makeBracket("Detail E2E - bracket B");
      const itemsB = await makeItems(bracketB.id, 2);
      const roundB = await prisma.round.create({
        data: {
          bracketId: bracketB.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const matchupB = await prisma.matchup.create({
        data: {
          roundId: roundB.id,
          itemAId: itemsB[0].id,
          itemBId: itemsB[1].id,
          status: "ACTIVE",
        },
      });

      const response = await GET(
        requestFor(bracketA.id, matchupB.id),
        ctx(bracketA.id, matchupB.id)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "NOT_FOUND",
        message: "This matchup no longer exists.",
      });
    });

    it("returns a real MatchupVotingView, blocks a signed-out caller on ACCOUNT_REQUIRED, and reflects an anonymous voter's existing vote plus real vote counts once they've voted", async () => {
      const bracket = await makeBracket(
        "Detail E2E - full flow",
        "ANONYMOUS_ALLOWED"
      );
      const items = await makeItems(bracket.id, 2);
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "ACTIVE",
        },
      });

      // Before voting: eligible, no existing vote, no voteCounts key.
      const beforeResponse = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const beforeBody = await beforeResponse.json();
      expect(beforeBody.bracketTitle).toBe("Detail E2E - full flow");
      expect(beforeBody.isTieBreaker).toBe(false);
      expect(beforeBody.countdownEndsAt).toBe(round.endsAt!.toISOString());
      expect(beforeBody.voter).toEqual({ kind: "eligible", existingVoteItemId: null });
      expect(Object.prototype.hasOwnProperty.call(beforeBody.voter, "voteCounts")).toBe(
        false
      );

      // Seed real Vote rows (3 for item A, 1 for item B) from an anonymous
      // identity, then request again as that same identity via a real
      // signed cookie.
      const anonymousVoterIdentifier = randomUUID();
      await prisma.vote.create({
        data: { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier },
      });
      await prisma.vote.createMany({
        data: [
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID() },
          { matchupId: matchup.id, itemId: items[0].id, anonymousVoterIdentifier: randomUUID() },
          { matchupId: matchup.id, itemId: items[1].id, anonymousVoterIdentifier: randomUUID() },
        ],
      });
      cookieJar.set("voter_id", signAnonymousVoterId(anonymousVoterIdentifier));

      const afterResponse = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const afterBody = await afterResponse.json();

      expect(afterBody.voter).toEqual({
        kind: "eligible",
        existingVoteItemId: items[0].id,
        voteCounts: { [items[0].id]: 3, [items[1].id]: 1 },
      });

      // A separate ACCOUNT_REQUIRED bracket, signed out (no cookie, no
      // userId) -> blocked, regardless of this suite's other identities.
      const blockedBracket = await makeBracket(
        "Detail E2E - account required",
        "ACCOUNT_REQUIRED"
      );
      const blockedItems = await makeItems(blockedBracket.id, 2);
      const blockedRound = await prisma.round.create({
        data: {
          bracketId: blockedBracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const blockedMatchup = await prisma.matchup.create({
        data: {
          roundId: blockedRound.id,
          itemAId: blockedItems[0].id,
          itemBId: blockedItems[1].id,
          status: "ACTIVE",
        },
      });
      cookieJar = new Map();

      const blockedResponse = await GET(
        requestFor(blockedBracket.id, blockedMatchup.id),
        ctx(blockedBracket.id, blockedMatchup.id)
      );
      const blockedBody = await blockedResponse.json();
      expect(blockedBody.voter).toEqual({
        kind: "blocked",
        message: "Sign in to vote on this bracket.",
      });
    });

    it("uses the matchup's own tieBreakerEndsAt (not the round's already-passed endsAt) and scopes the existing-vote lookup to the TIE_BREAKER phase", async () => {
      const bracket = await makeBracket("Detail E2E - tie-breaker");
      const items = await makeItems(bracket.id, 2);
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(Date.now() - 2 * 60 * 60_000),
          endsAt: new Date(Date.now() - 60 * 60_000),
        },
      });
      const tieBreakerEndsAt = new Date(Date.now() + 30 * 60_000);
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "TIE_BREAKER",
          tieBreakerEndsAt,
        },
      });

      currentUserId = voterProfileId;
      // The voter has an ORIGINAL-phase vote already, but none yet in the
      // TIE_BREAKER phase - the view must report no existing vote, not the
      // original-round one.
      await prisma.vote.create({
        data: {
          matchupId: matchup.id,
          itemId: items[0].id,
          userId: voterProfileId,
          phase: "ORIGINAL",
        },
      });

      const response = await GET(
        requestFor(bracket.id, matchup.id),
        ctx(bracket.id, matchup.id)
      );
      const body = await response.json();

      expect(body.isTieBreaker).toBe(true);
      expect(body.countdownEndsAt).toBe(tieBreakerEndsAt.toISOString());
      expect(body.voter).toEqual({ kind: "eligible", existingVoteItemId: null });
    });

    it("applies CORS headers to the response", async () => {
      const bracket = await makeBracket("Detail E2E - cors");
      const items = await makeItems(bracket.id, 2);
      const round = await prisma.round.create({
        data: {
          bracketId: bracket.id,
          roundNumber: 1,
          durationMinutes: 60,
          status: "ACTIVE",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const matchup = await prisma.matchup.create({
        data: {
          roundId: round.id,
          itemAId: items[0].id,
          itemBId: items[1].id,
          status: "ACTIVE",
        },
      });
      const request = new Request(
        `http://localhost/api/brackets/${bracket.id}/matchups/${matchup.id}`,
        { headers: { origin: process.env.FRONTEND_ORIGIN ?? "https://app.example.com" } }
      );

      const response = await GET(request, ctx(bracket.id, matchup.id));

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        process.env.FRONTEND_ORIGIN ?? "https://app.example.com"
      );
    });
  }
);

if (!hasLiveDatabase) {
  describe("GET /api/brackets/[bracketId]/matchups/[matchupId], against the live database", () => {
    console.warn(
      "[matchup detail route.integration.test] Skipping: no live DATABASE_URL is configured in .env.local."
    );

    it.skip("requires a live DATABASE_URL in .env.local to run this suite locally", () => {});
  });
}
