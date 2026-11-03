/**
 * NEO-424 — set history (rule A), the Hall of Fame tie-break (rule D) and the
 * gate that turns them into `startBatch` facts. A first pass by the builder to
 * keep the code honest; the unit-test pass extends it.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  NAMESAKE_ALIAS_ROWS_CAP,
  namesakesAcrossSports,
  normalizePlayerName,
} from "./players";
import { setHistoryVerdict } from "./setHistory";
import {
  PRIOR_PRODUCT_CHILD_CAP,
  findPriorYearSameProduct,
} from "./lib/selectorAncestry";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_set_history_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_set_history_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
const id = (s: string) => s as Id<"players">;

describe("setHistoryVerdict", () => {
  test("no history is today's path", () => {
    expect(setHistoryVerdict({ matchCount: 0 }, undefined)).toEqual({ kind: "none" });
    expect(setHistoryVerdict({ matchCount: 0 }, new Set())).toEqual({ kind: "none" });
  });

  test("history and the in-sport lookup naming the same player is silent (D3)", () => {
    expect(
      setHistoryVerdict({ matchCount: 1, playerId: id("a") }, new Set(["a"])),
    ).toEqual({ kind: "agrees" });
  });

  test("history wins over a different single in-sport match, rival listed second", () => {
    expect(
      setHistoryVerdict({ matchCount: 1, playerId: id("b") }, new Set(["a"])),
    ).toEqual({ kind: "autoLink", playerId: "a", candidatePlayerIds: ["a", "b"] });
  });

  test("history resolves an in-sport tie, the history player not repeated", () => {
    expect(
      setHistoryVerdict(
        { matchCount: 2, candidatePlayerIds: [id("a"), id("c")] },
        new Set(["a"]),
      ),
    ).toEqual({ kind: "autoLink", playerId: "a", candidatePlayerIds: ["a", "c"] });
  });

  test("two history players are a pick between exactly those", () => {
    expect(
      setHistoryVerdict({ matchCount: 1, playerId: id("c") }, new Set(["a", "b"])),
    ).toEqual({ kind: "pick", playerIds: ["a", "b"] });
  });
});

/** Baseball › 2024 › Topps › Series 1 › {Base, Insert}, plus a Football row. */
async function seedSet(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const node = (fields: {
      level: string;
      value: string;
      parentId?: Id<"selectorOptions">;
    }) =>
      ctx.db.insert("selectorOptions", {
        ...fields,
        platformData: {},
        children: [],
        lastUpdated: now,
      });
    const baseball = await node({ level: "sport", value: "Baseball" });
    const football = await node({ level: "sport", value: "Football" });
    const year = await node({ level: "year", value: "2024", parentId: baseball });
    const brand = await node({ level: "manufacturer", value: "Topps", parentId: year });
    const set = await node({ level: "setName", value: "Series 1", parentId: brand });
    const base = await node({ level: "variantType", value: "Base", parentId: set });
    const insert = await node({ level: "variantType", value: "Insert", parentId: set });
    await ctx.db.patch(set, { children: [base, insert] });
    await ctx.db.patch(brand, { children: [set] });
    await ctx.db.patch(year, { children: [brand] });
    await ctx.db.patch(baseball, { children: [year] });

    const bo = await ctx.db.insert("players", {
      name: "Bo Jackson",
      nameNormalized: normalizePlayerName("Bo Jackson"),
      sportId: football,
      lastUpdated: now,
    });
    // A baseball namesake the in-sport lookup would otherwise resolve to.
    const otherBo = await ctx.db.insert("players", {
      name: "Bo Jackson",
      nameNormalized: normalizePlayerName("Bo Jackson"),
      sportId: baseball,
      lastUpdated: now,
    });
    await ctx.db.insert("cardChecklist", {
      selectorOptionId: base,
      cardNumber: "1",
      cardName: "Bo Jackson",
      playerIds: [bo],
      playerLinks: [{ playerId: bo, nameOnCard: "Bo Jackson" }],
      listingTitle: "2024 Topps Series 1 #1 Bo Jackson",
      platformData: {},
      sportId: baseball,
      sortOrder: 0,
      lastUpdated: now,
    });
    return { baseball, football, base, insert, bo, otherBo };
  });
}

describe("resolveChecklistEntities — set history (NEO-424)", () => {
  test("a name the set linked once is auto-linked, cross-sport, as a decided row", async () => {
    const t = convexTest(schema, modules);
    const { baseball, football, insert, bo } = await seedSet(t);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: insert,
        sportId: baseball,
        cards: [
          { cardNumber: "I-1", cardName: "Card", players: ["Bo Jackson"], platformData: {} },
        ],
      },
    );

    // Known to the banner, and still a batch so the operator can Change it.
    expect(result.unknownPlayers).toEqual([]);
    expect(result.batchId).toBeDefined();
    const rows = (
      await t.run((ctx) => ctx.db.query("entityReviewQueue").collect())
    ).filter((row) => row.batchId === result.batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "player",
      name: "Bo Jackson",
      sportId: football,
      decision: { action: "link", linkedPlayerId: bo, autoLinked: "setHistory" },
    });
  });

  test("re-sync: a name linked on the fetched variant's own card is auto-linked to that player", async () => {
    const t = convexTest(schema, modules);
    const { baseball, football, base, bo } = await seedSet(t);
    // Base's card #1 is the only card in the set that carries Bo (football).
    const carriers = (await t.run((ctx) => ctx.db.query("cardChecklist").collect())).filter(
      (card) => card.playerIds?.includes(bo),
    );
    expect(carriers.map((card) => card.selectorOptionId)).toEqual([base]);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: base,
        sportId: baseball,
        cards: [
          { cardNumber: "1", cardName: "Card", players: ["Bo Jackson"], platformData: {} },
        ],
      },
    );

    // Fetching Base again: its own committed card is the set's earlier
    // answer, so the name links to Bo over the baseball namesake.
    expect(result.unknownPlayers).toEqual([]);
    const rows = (
      await t.run((ctx) => ctx.db.query("entityReviewQueue").collect())
    ).filter((row) => row.batchId === result.batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "player",
      name: "Bo Jackson",
      sportId: football,
      decision: { action: "link", linkedPlayerId: bo, autoLinked: "setHistory" },
    });
  });
});

describe("narrowSameNamePlayersByCardYear — Hall of Fame (NEO-424 rule D)", () => {
  async function seedThomases(t: T, opts: { hofs: number }) {
    return t.run(async (ctx) => {
      const now = Date.now();
      const sport = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: now,
      });
      const team = (location: string, name: string) =>
        ctx.db.insert("teams", {
          location,
          name,
          nameNormalized: normalizePlayerName(`${location} ${name}`),
          sportId: sport,
          lastUpdated: now,
        });
      const whiteSox = await team("Chicago", "White Sox");
      const pirates = await team("Pittsburgh", "Pirates");
      const player = (teamId: Id<"teams">, from: number, to: number, hof: boolean) =>
        ctx.db.insert("players", {
          name: "Frank Thomas",
          nameNormalized: normalizePlayerName("Frank Thomas"),
          sportId: sport,
          teamYears: [{ teamId, fromYear: from, toYear: to }],
          ...(hof ? { isHallOfFame: true } : {}),
          lastUpdated: now,
        });
      const legend = await player(whiteSox, 1990, 2008, true);
      const other = await player(pirates, 1951, 1966, opts.hofs > 1);
      return { sport, legend, other };
    });
  }

  test("nobody active in the card year, one Hall of Famer → him, flagged", async () => {
    const t = convexTest(schema, modules);
    const { sport, legend } = await seedThomases(t, { hofs: 1 });
    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Frank Thomas",
      sportId: sport,
      cardYear: 2024,
    });
    expect(resolved).toMatchObject({
      matchCount: 2,
      playerId: legend,
      narrowedByCardYear: true,
      narrowedBy: "hallOfFame",
    });
  });

  test("a card naming his own team corroborates him", async () => {
    const t = convexTest(schema, modules);
    const { sport, legend } = await seedThomases(t, { hofs: 1 });
    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Frank Thomas",
      sportId: sport,
      cardYear: 2024,
      cardTeamNames: ["Chicago White Sox"],
    });
    expect(resolved.playerId).toBe(legend);
    expect(resolved.narrowedBy).toBe("hallOfFame");
  });

  test("a card naming the rival's team holds the guess back (rule 8)", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seedThomases(t, { hofs: 1 });
    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Frank Thomas",
      sportId: sport,
      cardYear: 2024,
      cardTeamNames: ["Pittsburgh Pirates"],
    });
    expect(resolved.playerId).toBeUndefined();
  });

  test("two Hall of Famers is review", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seedThomases(t, { hofs: 2 });
    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Frank Thomas",
      sportId: sport,
      cardYear: 2024,
    });
    expect(resolved.playerId).toBeUndefined();
    expect(resolved.candidatePlayerIds).toHaveLength(2);
  });
});

describe("findPriorYearSameProduct — bounded reads (NEO-424 security audit)", () => {
  /** Baseball › {2023, 2024} › Topps › Series 1, plus `extraYears` filler years. */
  async function seedYears(t: T, extraYears: number) {
    return t.run(async (ctx) => {
      const now = Date.now();
      const node = (fields: { level: "sport" | "year" | "manufacturer" | "setName"; value: string; parentId?: Id<"selectorOptions"> }) =>
        ctx.db.insert("selectorOptions", { ...fields, platformData: {}, children: [], lastUpdated: now });
      const sport = await node({ level: "sport", value: "Baseball" });
      for (let i = 0; i < extraYears; i++) {
        await node({ level: "year", value: String(1000 + i), parentId: sport });
      }
      const ids: Record<string, Id<"selectorOptions">> = {};
      for (const y of ["2023", "2024"]) {
        const year = await node({ level: "year", value: y, parentId: sport });
        const brand = await node({ level: "manufacturer", value: "Topps", parentId: year });
        ids[y] = await node({ level: "setName", value: "Series 1", parentId: brand });
      }
      return ids;
    });
  }

  test("exactly at the cap the prior product is found", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedYears(t, PRIOR_PRODUCT_CHILD_CAP - 2);
    const found = await t.run((ctx) => findPriorYearSameProduct(ctx, ids["2024"]));
    expect(found).toBe(ids["2023"]);
  });

  test("one past the cap is undefined: an overflowing range is never read in part", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedYears(t, PRIOR_PRODUCT_CHILD_CAP - 1);
    const found = await t.run((ctx) => findPriorYearSameProduct(ctx, ids["2024"]));
    // `t.run` hands an undefined back as null.
    expect(found).toBeNull();
  });

  test("the test seam can only shrink the cap", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedYears(t, 1);
    expect(
      await t.run((ctx) => findPriorYearSameProduct(ctx, ids["2024"], { cap: 2 })),
    ).toBeNull();
    expect(
      await t.run((ctx) => findPriorYearSameProduct(ctx, ids["2024"], { cap: 10_000 })),
    ).toBe(ids["2023"]);
  });
});

describe("namesakesAcrossSports — alias cap (NEO-424 security audit)", () => {
  /** Player A answers to "Bo Jackson" in `aRows` sports; B, optionally, in one more. */
  async function seedAliases(t: T, aRows: number, withB: boolean) {
    return t.run(async (ctx) => {
      const now = Date.now();
      const sports: Array<Id<"selectorOptions">> = [];
      for (let i = 0; i <= aRows; i++) {
        sports.push(
          await ctx.db.insert("selectorOptions", {
            level: "sport",
            value: `Sport ${i}`,
            platformData: {},
            children: [],
            lastUpdated: now,
          }),
        );
      }
      const key = normalizePlayerName("Bo Jackson");
      const a = await ctx.db.insert("players", {
        name: "Vincent Jackson",
        nameNormalized: normalizePlayerName("Vincent Jackson"),
        sportId: sports[0],
        lastUpdated: now,
      });
      for (let i = 0; i < aRows; i++) {
        await ctx.db.insert("playerAliases", { playerId: a, sportId: sports[i], aliasNormalized: key });
      }
      if (withB) {
        const b = await ctx.db.insert("players", {
          name: "Robert Jackson",
          nameNormalized: normalizePlayerName("Robert Jackson"),
          sportId: sports[aRows],
          lastUpdated: now,
        });
        await ctx.db.insert("playerAliases", { playerId: b, sportId: sports[aRows], aliasNormalized: key });
      }
      return { a, key };
    });
  }

  test("one player's alias rows filling the cap make the answer incomplete, not 'exactly one'", async () => {
    const t = convexTest(schema, modules);
    const { key } = await seedAliases(t, NAMESAKE_ALIAS_ROWS_CAP + 1, true);
    const result = await t.run((ctx) => namesakesAcrossSports(ctx, key, 2));
    // Either the cap hid B (incomplete) or B was seen (two): never one.
    expect(result.complete && result.players.length === 1).toBe(false);
    expect(await t.query(internal.setHistory.findOnlyNamesakes, { names: [key] })).toEqual([]);
  });

  test("an overflowing range with no second player is still incomplete", async () => {
    const t = convexTest(schema, modules);
    const { key } = await seedAliases(t, NAMESAKE_ALIAS_ROWS_CAP + 1, false);
    const result = await t.run((ctx) => namesakesAcrossSports(ctx, key, 2));
    expect(result).toMatchObject({ complete: false });
    expect(result.players).toHaveLength(1);
  });

  test("a range within the cap is complete and one player is one namesake", async () => {
    const t = convexTest(schema, modules);
    const { a, key } = await seedAliases(t, NAMESAKE_ALIAS_ROWS_CAP, false);
    const result = await t.run((ctx) => namesakesAcrossSports(ctx, key, 2));
    expect(result.complete).toBe(true);
    expect(result.players.map((p) => p._id)).toEqual([a]);
    const [only] = await t.query(internal.setHistory.findOnlyNamesakes, { names: [key] });
    expect(only?.playerId).toBe(a);
  });
});
