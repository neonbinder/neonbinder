/**
 * NEO-214 — the Set Builder reset, after the AdminTools panel was deleted.
 *
 * The reset used to have two entry points: a public `action` behind the
 * "Reset Set Builder Data" button, and `resetSetBuilderDataFromCli` for
 * `npx convex run`. The button is gone, and with it the public action — the
 * CLI entry point is now the only way in, and per Jason (2026-09-04) it picks
 * up the `ALLOW_RESET_SET_BUILDER_DATA` gate the button used to carry.
 *
 * That reversal is the thing worth pinning. The previous docblock argued at
 * length that the CLI path must NOT check the flag (so prod could be reset
 * from a terminal without arming a prod-wiping button). With no button to arm,
 * the flag's only remaining job is "arm before you fire", and a future reader
 * finding that old reasoning in git history should find this test too.
 *
 * The third case is the one that would otherwise rot silently: the reset
 * drains SIX tables, and a table added to the schema but not to the loop
 * leaves rows behind that the next run reuses ids for. Each table is seeded
 * with a distinguishable number of rows so a mixed-up count is visible.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
const NON_ADMIN = { subject: "user", role: "user" };

const NOW = 1_700_000_000_000;

type Seeded = {
  sportId: Id<"selectorOptions">;
};

/**
 * Seed every table `runSetBuilderReset` drains, with a different row count per
 * table so the returned counts cannot be satisfied by the wrong table.
 *
 * Row shapes are minimal but schema-valid — this is about the delete loop, not
 * about the business meaning of any row.
 */
async function seedAllSixTables(
  t: ReturnType<typeof convexTest>,
): Promise<Seeded> {
  return t.run(async (ctx) => {
    // selectorOptions: 3 (a sport + two variant rows under it)
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: NOW,
    });
    const variantId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      parentId: sportId,
      platformData: {},
      children: [],
      lastUpdated: NOW,
    });
    await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: sportId,
      platformData: {},
      children: [],
      lastUpdated: NOW,
    });

    // leagues: 1
    const leagueId = await ctx.db.insert("leagues", {
      name: "Major League Baseball",
      nameNormalized: "baseball league major",
      sportId,
      lastUpdated: NOW,
    });

    // teams: 2
    const teamId = await ctx.db.insert("teams", {
      name: "New York Yankees",
      nameNormalized: "new york yankees",
      sportId,
      leagueId,
      lastUpdated: NOW,
    });
    await ctx.db.insert("teams", {
      name: "New York Mets",
      nameNormalized: "mets new york",
      sportId,
      leagueId,
      lastUpdated: NOW,
    });

    // players: 4
    for (const name of ["A One", "B Two", "C Three", "D Four"]) {
      await ctx.db.insert("players", {
        name,
        nameNormalized: name.toLowerCase(),
        sportId,
        lastUpdated: NOW,
      });
    }

    // cardChecklist: 5
    const cardIds: Id<"cardChecklist">[] = [];
    for (let i = 1; i <= 5; i += 1) {
      cardIds.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: variantId,
          cardNumber: String(i),
          cardName: `Card ${i}`,
          teamOnCardIds: [teamId],
          platformData: {},
          sortOrder: i,
          lastUpdated: NOW,
        }),
      );
    }

    // cardCrossListings: 6 — the junction table. Deliberately more rows than
    // the cards they hang off, because NEO-21's failure mode was leaving these
    // behind pointing at cardChecklist ids the next run reuses.
    for (const cardId of cardIds) {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: cardId,
        selectorOptionId: variantId,
        lastUpdated: NOW,
      });
    }
    await ctx.db.insert("cardCrossListings", {
      cardChecklistId: cardIds[0],
      selectorOptionId: sportId,
      lastUpdated: NOW,
    });

    return { sportId };
  });
}

const runReset = (t: ReturnType<typeof convexTest>, identity = ADMIN) =>
  t
    .withIdentity(identity)
    .action(internal.selectorOptions.resetSetBuilderDataFromCli, {
      confirm: "RESET" as const,
    });

async function tableCounts(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    selectorOptions: (await ctx.db.query("selectorOptions").collect()).length,
    cardChecklist: (await ctx.db.query("cardChecklist").collect()).length,
    cardCrossListings: (await ctx.db.query("cardCrossListings").collect())
      .length,
    players: (await ctx.db.query("players").collect()).length,
    teams: (await ctx.db.query("teams").collect()).length,
    leagues: (await ctx.db.query("leagues").collect()).length,
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NEO-214: resetSetBuilderDataFromCli", () => {
  test("refuses when ALLOW_RESET_SET_BUILDER_DATA is unset, and deletes nothing", async () => {
    // The NEO-214 reversal: the CLI path used to skip this check on purpose.
    const t = convexTest(schema, modules);
    await seedAllSixTables(t);

    await expect(runReset(t)).rejects.toThrow(/ALLOW_RESET_SET_BUILDER_DATA/);

    // A refusal that had already drained a table or two would be worse than no
    // guard at all, so assert the data is still there rather than just the throw.
    expect(await tableCounts(t)).toEqual({
      selectorOptions: 3,
      cardChecklist: 5,
      cardCrossListings: 6,
      players: 4,
      teams: 2,
      leagues: 1,
    });
  });

  test("refuses a non-admin identity even when armed, and deletes nothing", async () => {
    // `requireAdmin` lives on the batch mutations rather than here, so this
    // proves the arming flag did not become the only gate when the public
    // action was deleted.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedAllSixTables(t);

    await expect(runReset(t, NON_ADMIN)).rejects.toThrow(/Admin access required/);

    expect(await tableCounts(t)).toEqual({
      selectorOptions: 3,
      cardChecklist: 5,
      cardCrossListings: 6,
      players: 4,
      teams: 2,
      leagues: 1,
    });
  });

  test("refuses an anonymous caller even when armed", async () => {
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedAllSixTables(t);

    await expect(
      t.action(internal.selectorOptions.resetSetBuilderDataFromCli, {
        confirm: "RESET" as const,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("armed and admin: drains all six tables and returns the counts", async () => {
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedAllSixTables(t);

    const result = await runReset(t);

    expect(result).toEqual({
      selectorOptionsDeleted: 3,
      cardChecklistDeleted: 5,
      crossListingsDeleted: 6,
      playersDeleted: 4,
      teamsDeleted: 2,
      leaguesDeleted: 1,
    });

    expect(await tableCounts(t)).toEqual({
      selectorOptions: 0,
      cardChecklist: 0,
      cardCrossListings: 0,
      players: 0,
      teams: 0,
      leagues: 0,
    });
  });

  test("is a no-op on an already-empty deployment", async () => {
    // The runbook tells operators to re-run after a partial failure, so a
    // second run has to be safe rather than throwing on empty tables.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);

    expect(await runReset(t)).toEqual({
      selectorOptionsDeleted: 0,
      cardChecklistDeleted: 0,
      crossListingsDeleted: 0,
      playersDeleted: 0,
      teamsDeleted: 0,
      leaguesDeleted: 0,
    });
  });
});
