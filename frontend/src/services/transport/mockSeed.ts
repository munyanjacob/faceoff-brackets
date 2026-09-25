/**
 * Demo/seed data: a handful of public brackets, some with simulated voting
 * history, so the mock-transport app is never empty on first load.
 */

import type { Bracket } from "../types";
import { emptyDb, itemsOf, nowIso, uid, type Db } from "./mockDb";
import { createRound, sweep } from "./mockEngine";

function seedBracket(
  db: Db,
  creatorId: string,
  title: string,
  description: string,
  itemTitles: string[],
  durationMinutes: number,
): Bracket {
  const created = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3);
  const bracket: Bracket = {
    id: uid(),
    creatorId,
    title,
    description,
    visibility: "PUBLIC",
    votingRequirement: "ANONYMOUS_ALLOWED",
    defaultRoundDurationMinutes: durationMinutes,
    roundDurationOverrides: {},
    scheduledStartAt: null,
    status: "ACTIVE",
    createdAt: created.toISOString(),
    publishedAt: created.toISOString(),
  };
  db.brackets.push(bracket);
  itemTitles.forEach((t, index) => {
    db.items.push({
      id: uid(),
      bracketId: bracket.id,
      title: t,
      description: null,
      imageUrl: null,
      seed: index + 1,
      createdAt: new Date(created.getTime() + index * 1000).toISOString(),
    });
  });
  createRound(db, bracket, 1, itemsOf(db, bracket.id), { pending: false, startsAt: new Date() });
  return bracket;
}

/** Fake out real voting so seeded brackets have history. */
function simulateRounds(db: Db, bracket: Bracket, roundsToPlay: number) {
  for (let played = 0; played < roundsToPlay; played++) {
    const round = db.rounds
      .filter((r) => r.bracketId === bracket.id && r.status === "ACTIVE")
      .sort((a, b) => b.roundNumber - a.roundNumber)[0];
    if (!round) return;
    for (const matchup of db.matchups.filter((m) => m.roundId === round.id)) {
      if (matchup.status !== "ACTIVE" || !matchup.itemBId) continue;
      const aVotes = 3 + Math.floor(Math.random() * 20);
      const bVotes = 3 + Math.floor(Math.random() * 20);
      const push = (itemId: string, count: number) => {
        for (let i = 0; i < count; i++) {
          db.votes.push({
            id: uid(),
            matchupId: matchup.id,
            itemId,
            userId: null,
            anonymousVoterIdentifier: uid(),
            comment: i === 0 ? "Easy call for me." : null,
            phase: "ORIGINAL",
            createdAt: nowIso(),
          });
        }
      };
      push(matchup.itemAId!, aVotes);
      push(matchup.itemBId, bVotes === aVotes ? bVotes + 1 : bVotes);
    }
    round.endsAt = new Date(Date.now() - 60_000).toISOString();
    sweep(db);
  }
}

export function seed(): Db {
  const db = emptyDb();
  const creatorId = "seed-creator";
  db.profiles[creatorId] = "Arena Staff";

  const snacks = seedBracket(
    db,
    creatorId,
    "Greatest Road-Trip Snack",
    "Sixteen gas-station legends. One champion. Vote in every round.",
    [
      "Beef Jerky",
      "Sour Gummy Worms",
      "Salted Peanuts",
      "Kettle Chips",
      "Trail Mix",
      "Cheese Crackers",
      "Chocolate Bar",
      "Pretzel Bites",
      "Corn Nuts",
      "Fruit Snacks",
      "Sunflower Seeds",
      "Powdered Donuts",
      "Energy Drink",
      "String Cheese",
      "Popcorn",
      "Slim Jim",
    ],
    720,
  );
  simulateRounds(db, snacks, 2);

  const movies = seedBracket(
    db,
    creatorId,
    "Best Sports Movie Ever",
    "Eight contenders, single elimination, no mercy.",
    [
      "Hoosiers",
      "Rocky",
      "Remember the Titans",
      "Miracle",
      "The Sandlot",
      "Rudy",
      "Moneyball",
      "Cool Runnings",
    ],
    480,
  );
  simulateRounds(db, movies, 3);

  seedBracket(
    db,
    creatorId,
    "Ultimate Pizza Topping",
    "Voting is live right now — pick a side.",
    ["Pepperoni", "Mushroom", "Pineapple", "Sausage", "Basil", "Olives"],
    360,
  );

  return db;
}
