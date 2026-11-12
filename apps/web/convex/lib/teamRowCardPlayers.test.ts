/**
 * NEO-490 (2b) — a team name with several eras, settled by the card's own
 * players.
 *
 * `narrowTeamRowsByCardPlayers` is the pure-ish rule (reads player documents
 * only); `teams.resolveTeamByCardPlayers` is the internal query the review
 * gate calls for names `resolveTeamForSetYear` could not settle. Fixtures are
 * raw `t.run` inserts: a sport, one team name with two eras (and a third,
 * modern one for the future-era cases), and players whose `teamYears` point at
 * the eras.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeTeamName } from "../teams";
import {
  CARD_PLAYER_TEAM_MAX_CARDS,
  CARD_PLAYER_TEAM_MAX_PLAYERS_PER_CARD,
  narrowTeamRowsByCardPlayers,
} from "./teamRow";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.*s");

type T = ReturnType<typeof convexTest>;

async function seed(t: T) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const era = (from: number, to?: number) =>
      ctx.db.insert("teams", {
        location: "St. Louis",
        name: "Browns",
        nameNormalized: normalizeTeamName("St. Louis Browns"),
        sportId,
        yearsActive: { from, ...(to !== undefined ? { to } : {}) },
        lastUpdated: Date.now(),
      });
    const early = await era(1902, 1953);
    const late = await era(1961, 1965);
    const modern = await era(2010);
    return { sportId, early, late, modern };
  });
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teams: Id<"teams">[],
): Promise<Id<"players">> {
  return t.run((ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: name.toLowerCase().split(" ").reverse().join(" "),
      sportId,
      ...(teams.length > 0
        ? { teamYears: teams.map((teamId, i) => ({ teamId, fromYear: 1930 + i, toYear: 1931 + i })) }
        : {}),
      lastUpdated: Date.now(),
    }),
  );
}

function narrow(
  t: T,
  teamIds: Id<"teams">[],
  cardPlayerIds: Id<"players">[][],
  setYear: number | undefined,
): Promise<Id<"teams"> | null> {
  return t.run(async (ctx) => {
    const rows = (await Promise.all(teamIds.map((id) => ctx.db.get(id)))).filter(
      (row): row is Doc<"teams"> => row !== null,
    );
    return narrowTeamRowsByCardPlayers(ctx, rows, cardPlayerIds, setYear);
  });
}

describe("NEO-490: narrowTeamRowsByCardPlayers", () => {
  test("one card, one player, one era: that era", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(await narrow(t, [w.early, w.late], [[paige]], undefined)).toBe(w.early);
  });

  test("two cards whose players point at the same era agree", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const a = await insertPlayer(t, w.sportId, "Satchel Paige", [w.late]);
    const b = await insertPlayer(t, w.sportId, "Other Player", [w.late]);

    expect(await narrow(t, [w.early, w.late], [[a], [b]], undefined)).toBe(w.late);
  });

  test("two cards pointing at different eras: no decision", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const a = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);
    const b = await insertPlayer(t, w.sportId, "Other Player", [w.late]);

    expect(await narrow(t, [w.early, w.late], [[a], [b]], undefined)).toBeNull();
  });

  test("a card whose player played for two of the eras: no decision", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const both = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early, w.late]);

    expect(await narrow(t, [w.early, w.late], [[both]], undefined)).toBeNull();
  });

  test("a card with no resolved player: no decision, even when another card has one", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(await narrow(t, [w.early, w.late], [[]], undefined)).toBeNull();
    expect(await narrow(t, [w.early, w.late], [[paige], []], undefined)).toBeNull();
  });

  test("a player with no career on file: no decision", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const blank = await insertPlayer(t, w.sportId, "Satchel Paige", []);

    expect(await narrow(t, [w.early, w.late], [[blank]], undefined)).toBeNull();
  });

  test("a player deleted since: no decision", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const gone = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);
    await t.run((ctx) => ctx.db.delete(gone));

    expect(await narrow(t, [w.early, w.late], [[gone]], undefined)).toBeNull();
  });

  test("a stint on a team that is not a candidate does not count", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const elsewhere = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Elsewhere",
        nameNormalized: "elsewhere",
        sportId: w.sportId,
        lastUpdated: Date.now(),
      }),
    );
    const p = await insertPlayer(t, w.sportId, "Satchel Paige", [elsewhere, w.late]);

    expect(await narrow(t, [w.early, w.late], [[p]], undefined)).toBe(w.late);
  });

  test("a row whose era begins after the set year is never the answer", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const both = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early, w.modern]);
    const onlyModern = await insertPlayer(t, w.sportId, "Other Player", [w.modern]);

    // The 2010 era is in the future of a 1950 card, so the stint on it is not
    // evidence and the player points at one era...
    expect(await narrow(t, [w.early, w.modern], [[both]], 1950)).toBe(w.early);
    // ...with no year, nothing is excluded and the same player is ambiguous.
    expect(await narrow(t, [w.early, w.modern], [[both]], undefined)).toBeNull();
    // A player whose only stint is on the future era gives nothing.
    expect(await narrow(t, [w.early, w.modern], [[onlyModern]], 1950)).toBeNull();
  });

  test("fewer than two candidates is resolveTeamForSetYear's to answer", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(await narrow(t, [w.early], [[paige]], undefined)).toBeNull();
    expect(await narrow(t, [], [[paige]], undefined)).toBeNull();
  });

  test("no cards at all: no decision", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    expect(await narrow(t, [w.early, w.late], [], undefined)).toBeNull();
  });

  test("the bounds are 16 cards and 4 players a card", () => {
    expect(CARD_PLAYER_TEAM_MAX_CARDS).toBe(16);
    expect(CARD_PLAYER_TEAM_MAX_PLAYERS_PER_CARD).toBe(4);
  });

  test("exactly the card bound still decides; one card more does not", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    const atBound = Array.from({ length: CARD_PLAYER_TEAM_MAX_CARDS }, () => [paige]);
    const pastBound = Array.from({ length: CARD_PLAYER_TEAM_MAX_CARDS + 1 }, () => [paige]);
    expect(await narrow(t, [w.early, w.late], atBound, undefined)).toBe(w.early);
    expect(await narrow(t, [w.early, w.late], pastBound, undefined)).toBeNull();
  });

  test("exactly the players-per-card bound still decides; one player more does not", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);
    const blanks: Id<"players">[] = [];
    for (let i = 0; i < CARD_PLAYER_TEAM_MAX_PLAYERS_PER_CARD; i++) {
      blanks.push(await insertPlayer(t, w.sportId, `Blank${i} Player`, []));
    }
    const atBound = [paige, ...blanks.slice(1)];
    expect(atBound).toHaveLength(CARD_PLAYER_TEAM_MAX_PLAYERS_PER_CARD);
    const pastBound = [paige, ...blanks];

    expect(await narrow(t, [w.early, w.late], [atBound], undefined)).toBe(w.early);
    expect(await narrow(t, [w.early, w.late], [pastBound], undefined)).toBeNull();
  });
});

describe("NEO-490: teams.resolveTeamByCardPlayers", () => {
  const resolve = (
    t: T,
    args: {
      sportId: Id<"selectorOptions">;
      name?: string;
      setYear?: number;
      cardPlayerIds: Id<"players">[][];
    },
  ) =>
    t.query(internal.teams.resolveTeamByCardPlayers, {
      sportId: args.sportId,
      name: args.name ?? "St. Louis Browns",
      ...(args.setYear !== undefined ? { setYear: args.setYear } : {}),
      cardPlayerIds: args.cardPlayerIds,
    });

  test("returns the era the card's player played for when the name has several and no year", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(await resolve(t, { sportId: w.sportId, cardPlayerIds: [[paige]] })).toBe(w.early);
  });

  test("returns null when the set year already settles the name", async () => {
    // 1930 sits only inside the 1902-1953 era, so resolveTeamForSetYear
    // decides. The player points at that SAME era, so without the early return
    // this rule would hand it back too, labelled as a career-team link the
    // players never made.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(
      await resolve(t, { sportId: w.sportId, setYear: 1930, cardPlayerIds: [[paige]] }),
    ).toBeNull();
  });

  test("returns null when the players disagree", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const a = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);
    const b = await insertPlayer(t, w.sportId, "Other Player", [w.late]);

    expect(await resolve(t, { sportId: w.sportId, cardPlayerIds: [[a], [b]] })).toBeNull();
  });

  test("returns null for a name the sport does not hold", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);

    expect(
      await resolve(t, { sportId: w.sportId, name: "Nowhere Nobodies", cardPlayerIds: [[paige]] }),
    ).toBeNull();
  });

  test("never inserts a team", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const paige = await insertPlayer(t, w.sportId, "Satchel Paige", [w.early]);
    const before = await t.run((ctx) => ctx.db.query("teams").collect());

    await resolve(t, { sportId: w.sportId, cardPlayerIds: [[paige]] });

    expect(await t.run((ctx) => ctx.db.query("teams").collect())).toHaveLength(before.length);
  });
});
