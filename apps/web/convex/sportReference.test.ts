/**
 * NEO-96: the assertions whose ABSENCE let a real production defect ship.
 *
 * `sport` used to be free text on `teams`/`players`/`entityReviewQueue`, and
 * three writers disagreed about its casing:
 *
 *   commitCardChecklist  → fetchCardChecklist's `ancestor.value.toLowerCase()`
 *                          i.e. "baseball" — a BSC WIRE FORMAT that had leaked
 *                          out of the adapter layer into the domain model
 *   cardChecklist.ts     → findSportForSelectorOption's raw `node.value`
 *   TeamPicker/PlayerPicker → the raw ancestor `.value`
 *
 * Every read was an exact match, so an entity created by one path was invisible
 * to the others, and "+ Create" happily minted a second, differently-cased
 * duplicate. It also split marketplace-facing SKUs (NB-BA- vs NB-BB- for the
 * same set) because `SPORT_SKU_CODE` was keyed on the display name.
 *
 * Both test suites covered each path in isolation and neither ever asserted the
 * ROUND TRIP between them, which is exactly where the bug lived. These tests
 * are that round trip, plus the rename capability the reference model unlocks.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_sport_ref_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_sport_ref_001",
  role: "admin",
};

const BASEBALL_CONFIG = {
  skuCode: "BB",
  league: "MLB",
  espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
  wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
};

/** sport → setName → variantType, mirroring the real hierarchy shape. */
async function seedTree(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: "baseball", sportlots: "BB" },
      children: [],
      sportConfig: BASEBALL_CONFIG,
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, setNameId, variantTypeId };
  });
}

/**
 * commitCardChecklist only materializes players/teams from DECIDED
 * entityReviewQueue rows (the wizard's output) — names on a card alone are not
 * enough. Mirrors what the real fetch → wizard → commit flow produces.
 */
async function decideCreate(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    batchId: string;
    kind: "player" | "team";
    name: string;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: "user_sport_ref_001",
      kind: opts.kind,
      name: opts.name,
      sportId: opts.sportId,
      status: "ready",
      decision: { action: "create" },
    }),
  );
}

function card(cardNumber: string, players: string[] = [], teams: string[] = []) {
  return {
    cardNumber,
    cardName: `Card ${cardNumber}`,
    players,
    teams,
    platformData: {},
  };
}

// ===========================================================================
// THE ROUND TRIP — the missing assertion
// ===========================================================================

describe("NEO-96 round trip: commit-created entities are visible to the pickers", () => {
  test("a player created by commitCardChecklist is returned by players.list for the same sport node", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    await decideCreate(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b1",
      cards: [card("1", ["Mike Trout"])],
    });

    // This is precisely what PlayerPicker queries. Before NEO-96 the commit
    // stored "baseball" while the picker asked for "Baseball", so this
    // returned nothing and the user was offered "+ Create" for a player that
    // already existed — then creating minted a capitalized duplicate.
    const visible = await asAdmin.query(api.players.list, { sportId, limit: 500 });
    expect(visible.map((p) => p.name)).toContain("Mike Trout");
  });

  test("a team created by commitCardChecklist is returned by teams.list for the same sport node", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    await decideCreate(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b2",
      kind: "team",
      name: "Los Angeles Angels",
    });
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b2",
      cards: [card("2", [], ["Los Angeles Angels"])],
    });

    const visible = await asAdmin.query(api.teams.list, { sportId, limit: 500 });
    expect(visible.map((tm) => tm.name)).toContain("Los Angeles Angels");
  });

  test("and the reverse: a picker-created entity is found by the commit path, not duplicated", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    // TeamPicker "+ Create".
    const pickerTeamId = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Los Angeles Angels",
      sportId,
    });

    // Now the commit path resolves the SAME name. No review row is needed —
    // the name already resolves to an existing entity, which is the behaviour
    // under test: it must find the picker's row rather than mint a second one.
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [card("3", [], ["Los Angeles Angels"])],
    });

    const all = await t.run(async (ctx) => ctx.db.query("teams").collect());
    const angels = all.filter((tm) => tm.nameNormalized.includes("angels"));
    expect(angels).toHaveLength(1);
    expect(angels[0]._id).toBe(pickerTeamId);
  });

  test("entities under a DIFFERENT sport row stay invisible — the reference still scopes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await decideCreate(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b4",
      kind: "player",
      name: "Mike Trout",
    });
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "b4",
      cards: [card("4", ["Mike Trout"])],
    });

    const otherSport = await asAdmin.query(api.players.list, {
      sportId: otherSportId,
      limit: 500,
    });
    expect(otherSport).toHaveLength(0);
  });
});

// ===========================================================================
// SKU PARITY — the marketplace-facing half of the same bug
// ===========================================================================

describe("NEO-96 SKU parity between the two card-creation paths", () => {
  test("commitCardChecklist and addCustomCard produce the same sport prefix for one set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [card("50")],
    });
    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "9001",
      cardName: "Custom One",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .collect(),
    );
    const prefixes = rows.map((r) => r.sku?.split("-").slice(0, 2).join("-"));
    expect(new Set(prefixes).size).toBe(1);
    // "BB" comes from the sport row's sportConfig.skuCode. Previously the
    // commit path passed a lowercased "baseball" into a capitalized-keyed map,
    // missed, and slugified to "BA" while addCustomCard produced "BB".
    expect(prefixes[0]).toBe("NB-BB");
  });

  test("a sport with no config degrades to a slugified prefix rather than failing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const ids = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Kabaddi",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [variantTypeId] });
      return { sportId, variantTypeId };
    });

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: ids.variantTypeId,
      cardNumber: "1",
      cardName: "Custom",
    });

    const rows = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
    expect(rows[0].sku?.startsWith("NB-KA-")).toBe(true);
  });
});

// ===========================================================================
// sportConfig seeding
// ===========================================================================

describe("NEO-96 sportConfig is seeded at sport-row creation", () => {
  test("storeSelectorOptions stamps the defaults onto a new sport row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Baseball", platformData: { bsc: "baseball", sportlots: "BB" } }],
    });

    const row = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).find((o) => o.level === "sport"),
    );
    expect(row?.sportConfig?.skuCode).toBe("BB");
    expect(row?.sportConfig?.wikidata?.sportQid).toBe("Q5369");
    // The marketplace wire formats stay where they belong — NOT in sportConfig.
    expect(row?.platformData.bsc).toBe("baseball");
    expect(row?.platformData.sportlots).toBe("BB");
  });

  test("an unmapped sport gets no config, and that is not an error", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Kabaddi", platformData: { bsc: "kabaddi" } }],
    });

    const row = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).find((o) => o.level === "sport"),
    );
    expect(row).toBeTruthy();
    expect(row?.sportConfig).toBeUndefined();
  });
});

// ===========================================================================
// renameSelectorOption — only safe because entities hold a reference
// ===========================================================================

describe("NEO-96 renameSelectorOption", () => {
  test("renaming a sport leaves its teams and players attached and re-labelled", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    await decideCreate(t, {
      selectorOptionId: variantTypeId, sportId, batchId: "r1",
      kind: "player", name: "Mike Trout",
    });
    await decideCreate(t, {
      selectorOptionId: variantTypeId, sportId, batchId: "r1",
      kind: "team", name: "Los Angeles Angels",
    });
    await asAdmin.mutation(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "r1",
      cards: [card("1", ["Mike Trout"], ["Los Angeles Angels"])],
    });

    const res = await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: sportId,
      value: "MLB Baseball",
    });
    expect(res.success).toBe(true);

    // The whole point of the reference model: the label moved, nothing else did.
    const players = await asAdmin.query(api.players.list, { sportId, limit: 500 });
    const teams = await asAdmin.query(api.teams.list, { sportId, limit: 500 });
    expect(players.map((p) => p.name)).toContain("Mike Trout");
    expect(teams.map((tm) => tm.name)).toContain("Los Angeles Angels");

    const row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(row?.value).toBe("MLB Baseball");
  });

  test("a rename never touches platformData — the marketplace mapping is independent", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);

    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: sportId,
      value: "MLB Baseball",
    });

    const row = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(row?.platformData.bsc).toBe("baseball");
    expect(row?.platformData.sportlots).toBe("BB");
    // Config is likewise preserved, so SKUs and enrichment survive the rename.
    expect(row?.sportConfig?.skuCode).toBe("BB");
  });

  test("rejects a name that collides with a sibling, case-insensitively", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const otherId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: otherId,
        value: "  baseball ",
      }),
    ).rejects.toThrow(/already called/);

    const row = await t.run(async (ctx) => ctx.db.get(otherId));
    expect(row?.value).toBe("Football");
  });

  test("rejects an empty name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: sportId,
        value: "   ",
      }),
    ).rejects.toThrow(/cannot be empty/i);
  });

  test("works at a non-sport level too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { setNameId } = await seedTree(t);

    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: setNameId,
      value: "Topps Chrome",
    });

    const row = await t.run(async (ctx) => ctx.db.get(setNameId));
    expect(row?.value).toBe("Topps Chrome");
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);

    await expect(
      t.mutation(api.selectorOptions.renameSelectorOption, {
        id: sportId,
        value: "Nope",
      }),
    ).rejects.toThrow();
  });
});
