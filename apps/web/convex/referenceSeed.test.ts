/**
 * NEO-408 — the reference-seed loader's read-side helpers. convex-test ids
 * are not real Convex ids, so the table-NUMBER discovery is pinned in
 * `lib/convexIdCodec.test.ts` against the loader's codec; here: emptiness,
 * paging, counts and the sport-id check.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { STATS_PAGE } from "./referenceSeed";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

async function seedSportAndTeams(t: ReturnType<typeof convexTest>, teams: number, strays: number) {
  return t.run(async (ctx) => {
    const base = { platformData: {}, children: [], lastUpdated: 1 };
    const sportId = await ctx.db.insert("selectorOptions", { ...base, level: "sport", value: "Baseball" } as never);
    const otherId = await ctx.db.insert("selectorOptions", { ...base, level: "year", value: "2024", parentId: sportId } as never);
    const team = (name: string, sport: typeof sportId) => ({ name, nameNormalized: name.toLowerCase(), sportId: sport, lastUpdated: 1 });
    for (let i = 0; i < teams; i++) await ctx.db.insert("teams", team(`Team ${i}`, sportId));
    for (let i = 0; i < strays; i++) await ctx.db.insert("teams", team(`Stray ${i}`, otherId));
    return { sportId, otherId };
  });
}

describe("referenceSeed", () => {
  test("preflight reports which tables hold rows and tolerates a table the schema lacks", async () => {
    const t = convexTest(schema, modules);
    await seedSportAndTeams(t, 2, 0);
    const out = await t.action(internal.referenceSeed.preflight, { tables: ["selectorOptions", "teams", "players", "noSuchTable"] });
    expect(out.nonEmpty).toEqual({ selectorOptions: true, teams: true, players: false, noSuchTable: false });
    // convex-test ids carry no table number, so none is found here; the real
    // lookup is pinned in lib/convexIdCodec.test.ts and exercised by CI's seed.
    expect(out.tableNumbers).toEqual({});
  });

  test("countPage checks an array field of sport ids too", async () => {
    const t = convexTest(schema, modules);
    const { sportId, otherId } = await seedSportAndTeams(t, 0, 0);
    await t.run(async (ctx) => {
      const player = (name: string, also: unknown[]) => ({ name, nameNormalized: name.toLowerCase(), sportId, lastUpdated: 1, alsoSportIds: also });
      await ctx.db.insert("players", player("Two Sports", [sportId]) as never);
      await ctx.db.insert("players", player("Stray Also", [sportId, otherId]) as never);
    });
    const page = await t.query(internal.referenceSeed.countPage, {
      table: "players",
      cursor: null,
      numItems: 10,
      sportIds: [sportId],
      sportIdFields: ["sportId", "alsoSportIds"],
    });
    expect(page).toMatchObject({ count: 2, badSport: 1, isDone: true });
  });

  test("countPage counts a page and flags sport ids that are not sport rows", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportAndTeams(t, 3, 2);
    const page = await t.query(internal.referenceSeed.countPage, {
      table: "teams",
      cursor: null,
      numItems: 10,
      sportIds: [sportId],
      sportIdFields: ["sportId"],
    });
    expect(page).toMatchObject({ count: 5, badSport: 2, isDone: true });
  });

  test("tableStats walks every page and checks dependants against the sport rows", async () => {
    const t = convexTest(schema, modules);
    await seedSportAndTeams(t, STATS_PAGE + 5, 1);
    const stats = await t.action(internal.referenceSeed.tableStats, {
      tables: ["selectorOptions", "teams", "players"],
      checkSports: true,
      sportIdFields: ["sportId"],
    });
    expect(stats.complete).toBe(true);
    expect(stats.sportRows).toBe(1);
    expect(stats.rows).toEqual({ selectorOptions: 2, teams: STATS_PAGE + 6, players: 0 });
    // The sport table's own rows are never checked against themselves.
    expect(stats.badSport).toEqual({ selectorOptions: 0, teams: 1, players: 0 });
  });

  test("tableStats without the sport check counts only; with the check it needs the field names", async () => {
    const t = convexTest(schema, modules);
    await seedSportAndTeams(t, 2, 1);
    const stats = await t.action(internal.referenceSeed.tableStats, { tables: ["teams"], checkSports: false, sportIdFields: ["sportId"] });
    expect(stats).toMatchObject({ complete: true, sportRows: 0, rows: { teams: 3 }, badSport: { teams: 0 } });
    await expect(
      t.action(internal.referenceSeed.tableStats, { tables: ["teams"], checkSports: true }),
    ).rejects.toThrow(/needs sportIdFields/);
  });

  test("tableStats hands back a resume token when its budget is spent, and finishes from it", async () => {
    const t = convexTest(schema, modules);
    await seedSportAndTeams(t, STATS_PAGE + 3, 0);
    const args = { tables: ["selectorOptions", "teams", "players"], checkSports: false, budgetMs: -1 };
    let out = await t.action(internal.referenceSeed.tableStats, args);
    let passes = 1;
    while (!out.complete) {
      expect(out.resume).not.toBeNull();
      out = await t.action(internal.referenceSeed.tableStats, { ...args, resume: out.resume! });
      passes++;
    }
    // One page per pass: 1 (selectorOptions) + 2 (teams) + 1 (players).
    expect(passes).toBe(4);
    expect(out.rows).toEqual({ selectorOptions: 2, teams: STATS_PAGE + 3, players: 0 });
  });
});
