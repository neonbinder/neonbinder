/**
 * NEO-490 (2b) — the review gate's team side of the career-team rule, driven
 * through the real action (`selectorOptions.resolveChecklistEntities`) and the
 * real `teams.resolveTeamByCardPlayers` query.
 *
 * A printed team name with several closed eras that neither the set year nor
 * the set's history separates is settled by the players on the cards that
 * print it. The answer is a visible decided row (`autoLinked: "careerTeam"`);
 * anything short of one agreed era is asked as before.
 *
 * Fixture: "St. Louis Browns" in two closed eras (1902-1953, 1961-1965) under
 * a 2024 set. Both eras are before the set year, so `resolveTeamForSetYear`
 * answers null with two candidates.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { CARD_PLAYER_TEAM_MAX_CARDS } from "./lib/teamRow";
import { cancelScheduled } from "../lib/testing/drain-scheduled";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_career_team_gate_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_career_team_gate_001",
  name: "Admin User",
  role: "admin",
};

const TEAM_NAME = "St. Louis Browns";

type T = ReturnType<typeof convexTest>;
type Sel = Id<"selectorOptions">;

const live: T[] = [];
function newT(): T {
  const t = convexTest(schema, modules);
  live.push(t);
  return t;
}
afterEach(async () => {
  for (const t of live.splice(0)) await cancelScheduled(t);
});

async function node(
  t: T,
  fields: { level: string; value: string; parentId?: Sel },
): Promise<Sel> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      ...fields,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

/** sport › year 2024 › manufacturer › set › Base + Insert variant types. */
async function setup(t: T) {
  const sportId = await node(t, { level: "sport", value: "Baseball" });
  const year = await node(t, { level: "year", value: "2024", parentId: sportId });
  const brand = await node(t, { level: "manufacturer", value: "Topps", parentId: year });
  const set = await node(t, { level: "setName", value: "Series 1", parentId: brand });
  const base = await node(t, { level: "variantType", value: "Base", parentId: set });
  const insert = await node(t, { level: "variantType", value: "Insert", parentId: set });
  const era = (from: number, to: number) =>
    t.run((ctx) =>
      ctx.db.insert("teams", {
        location: "St. Louis",
        name: "Browns",
        nameNormalized: normalizeTeamName(TEAM_NAME),
        sportId,
        yearsActive: { from, to },
        lastUpdated: Date.now(),
      }),
    );
  const early = await era(1902, 1953);
  const late = await era(1961, 1965);
  return { sportId, base, insert, early, late };
}

function player(t: T, sportId: Sel, name: string, teams: Id<"teams">[]): Promise<Id<"players">> {
  return t.run((ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      teamYears: teams.map((teamId, i) => ({ teamId, fromYear: 1930 + i, toYear: 1931 + i })),
      lastUpdated: Date.now(),
    }),
  );
}

function card(players: string[], n: number) {
  return {
    cardNumber: `I-${n}`,
    cardName: "Card",
    players,
    teams: [TEAM_NAME],
    platformData: {},
  };
}

async function gate(
  t: T,
  s: { sportId: Sel; insert: Sel },
  cards: ReturnType<typeof card>[],
) {
  return t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.resolveChecklistEntities, {
    selectorOptionId: s.insert,
    sportId: s.sportId,
    cards,
  });
}

async function teamRows(t: T, batchId: string | undefined) {
  if (!batchId) return [];
  return (await t.run((ctx) => ctx.db.query("entityReviewQueue").collect())).filter(
    (r) => r.batchId === batchId && r.kind === "team",
  );
}

describe("the gate: a team name with several eras, settled by the card's players (NEO-490)", () => {
  test("one resolved player with a stint on one era makes a decided careerTeam team row", async () => {
    const t = newT();
    const s = await setup(t);
    await player(t, s.sportId, "Satchel Paige", [s.early]);

    const result = await gate(t, s, [card(["Satchel Paige"], 1)]);

    expect(result.unknownTeams).toEqual([]);
    const rows = await teamRows(t, result.batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toMatchObject({
      action: "link",
      linkedTeamId: s.early,
      autoLinked: "careerTeam",
    });
  });

  test("a second card for the team whose player is unresolved leaves the team undecided and asked", async () => {
    const t = newT();
    const s = await setup(t);
    await player(t, s.sportId, "Satchel Paige", [s.early]);

    const result = await gate(t, s, [
      card(["Satchel Paige"], 1),
      card(["Nobody Onfile"], 2),
    ]);

    expect(result.unknownTeams).toEqual([TEAM_NAME]);
    const rows = await teamRows(t, result.batchId);
    expect(rows.every((r) => r.decision?.autoLinked !== "careerTeam")).toBe(true);
  });

  test("two cards whose players point at different eras leave the team undecided", async () => {
    const t = newT();
    const s = await setup(t);
    await player(t, s.sportId, "Satchel Paige", [s.early]);
    await player(t, s.sportId, "Ken Boyer", [s.late]);

    const result = await gate(t, s, [card(["Satchel Paige"], 1), card(["Ken Boyer"], 2)]);

    expect(result.unknownTeams).toEqual([TEAM_NAME]);
    const rows = await teamRows(t, result.batchId);
    expect(rows.some((r) => r.decision?.autoLinked === "careerTeam")).toBe(false);
  });

  test("an era the set's history already settles stays a setHistory row, not careerTeam", async () => {
    const t = newT();
    const s = await setup(t);
    // The player's stint points at the OTHER era: if the career rule ran it
    // would pick `late`, so `early` proves history answered first.
    await player(t, s.sportId, "Satchel Paige", [s.late]);
    await t.run((ctx) =>
      insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "1",
        cardName: "Card",
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
        teamOnCardIds: [s.early],
      }),
    );

    const result = await gate(t, s, [card(["Satchel Paige"], 1)]);

    expect(result.unknownTeams).toEqual([]);
    const rows = await teamRows(t, result.batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toMatchObject({
      linkedTeamId: s.early,
      autoLinked: "setHistory",
    });
  });

  test("a team name printed on exactly the card bound is still settled by players", async () => {
    const t = newT();
    const s = await setup(t);
    await player(t, s.sportId, "Satchel Paige", [s.early]);

    const result = await gate(
      t,
      s,
      Array.from({ length: CARD_PLAYER_TEAM_MAX_CARDS }, (_, i) => card(["Satchel Paige"], i + 1)),
    );

    expect(result.unknownTeams).toEqual([]);
    expect((await teamRows(t, result.batchId))[0]?.decision?.autoLinked).toBe("careerTeam");
  });

  test("a team name printed on more than the card bound is never sent to the query", async () => {
    const t = newT();
    const s = await setup(t);
    await player(t, s.sportId, "Satchel Paige", [s.early]);

    const result = await gate(
      t,
      s,
      Array.from({ length: CARD_PLAYER_TEAM_MAX_CARDS + 1 }, (_, i) =>
        card(["Satchel Paige"], i + 1),
      ),
    );

    expect(result.unknownTeams).toEqual([TEAM_NAME]);
    const rows = await teamRows(t, result.batchId);
    expect(rows.some((r) => r.decision?.autoLinked === "careerTeam")).toBe(false);
  });
});
