import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BracketStatus,
  MatchupStatus,
  RoundStatus,
  Visibility,
  VotingRequirement,
} from "../src/generated/prisma/enums";

// Issue #3: "Add Prisma and define the core schema". These tests check the
// shape of the schema/migration rather than hitting the live database -
// no PrismaClient is instantiated here since Prisma 7's `prisma-client`
// generator requires a driver adapter (e.g. @prisma/adapter-pg) that isn't
// part of this issue's scope (no app code queries these tables yet).

const schemaSource = readFileSync(
  join(__dirname, "schema.prisma"),
  "utf-8",
);

describe("prisma/schema.prisma", () => {
  test("defines all six core models mapped to snake_case tables", () => {
    const expectedMappings: Record<string, string> = {
      Profile: "profiles",
      Bracket: "brackets",
      BracketItem: "bracket_items",
      Round: "rounds",
      Matchup: "matchups",
      Vote: "votes",
    };

    for (const [model, table] of Object.entries(expectedMappings)) {
      const modelBlockMatch = schemaSource.match(
        new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`),
      );
      expect(modelBlockMatch, `model ${model} should exist`).not.toBeNull();
      expect(modelBlockMatch?.[0]).toContain(`@@map("${table}")`);
    }
  });

  test("every model besides Profile defaults its id to uuid()", () => {
    const nonProfileModels = [
      "Bracket",
      "BracketItem",
      "Round",
      "Matchup",
      "Vote",
    ];
    for (const model of nonProfileModels) {
      const modelBlockMatch = schemaSource.match(
        new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`),
      );
      expect(modelBlockMatch?.[0]).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
    }

    // Profile's id has no default - it's set by the app to match Supabase's
    // auth user id.
    const profileBlock = schemaSource.match(/model Profile \{[\s\S]*?\n\}/);
    expect(profileBlock?.[0]).toMatch(/id\s+String\s+@id\s*\n/);
  });

  test("Vote has independent unique constraints for account and anonymous voters", () => {
    const voteBlock = schemaSource.match(/model Vote \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(voteBlock).toContain("@@unique([matchupId, userId])");
    expect(voteBlock).toContain(
      "@@unique([matchupId, anonymousVoterIdentifier])",
    );
  });

  test("BracketItem has a unique constraint on (bracketId, seed)", () => {
    const bracketItemBlock =
      schemaSource.match(/model BracketItem \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(bracketItemBlock).toContain("@@unique([bracketId, seed])");
  });

  test("every relation explicitly sets onDelete", () => {
    const relationLines = schemaSource
      .split("\n")
      .filter((line) => /@relation\(/.test(line) && /fields:/.test(line));

    expect(relationLines.length).toBeGreaterThan(0);
    for (const line of relationLines) {
      expect(line, `relation line should set onDelete: ${line}`).toMatch(
        /onDelete:\s*Restrict/,
      );
    }
  });

  test("does not require a Postgres extension for id generation", () => {
    expect(schemaSource).not.toContain("dbgenerated(\"gen_random_uuid()\")");
    expect(schemaSource).not.toContain("dbgenerated(\"uuid_generate_v4()\")");
  });
});

describe("generated Prisma Client enums", () => {
  test("Visibility matches PUBLIC/PRIVATE", () => {
    expect(Visibility).toEqual({ PUBLIC: "PUBLIC", PRIVATE: "PRIVATE" });
  });

  test("VotingRequirement matches ACCOUNT_REQUIRED/ANONYMOUS_ALLOWED", () => {
    expect(VotingRequirement).toEqual({
      ACCOUNT_REQUIRED: "ACCOUNT_REQUIRED",
      ANONYMOUS_ALLOWED: "ANONYMOUS_ALLOWED",
    });
  });

  test("BracketStatus matches DRAFT/SCHEDULED/ACTIVE/COMPLETED", () => {
    expect(BracketStatus).toEqual({
      DRAFT: "DRAFT",
      SCHEDULED: "SCHEDULED",
      ACTIVE: "ACTIVE",
      COMPLETED: "COMPLETED",
    });
  });

  test("RoundStatus has no TIE_BREAKER value (that state lives on Matchup only)", () => {
    expect(RoundStatus).toEqual({
      PENDING: "PENDING",
      ACTIVE: "ACTIVE",
      COMPLETED: "COMPLETED",
    });
  });

  test("MatchupStatus includes TIE_BREAKER", () => {
    expect(MatchupStatus).toEqual({
      PENDING: "PENDING",
      ACTIVE: "ACTIVE",
      TIE_BREAKER: "TIE_BREAKER",
      COMPLETED: "COMPLETED",
    });
  });
});

describe("prisma/migrations", () => {
  test("the init migration creates all six tables with no Postgres extensions", () => {
    const migrationSql = readFileSync(
      join(__dirname, "migrations", "20260919050741_init", "migration.sql"),
      "utf-8",
    );

    for (const table of [
      "profiles",
      "brackets",
      "bracket_items",
      "rounds",
      "matchups",
      "votes",
    ]) {
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    }

    expect(migrationSql).not.toContain("CREATE EXTENSION");
  });
});
