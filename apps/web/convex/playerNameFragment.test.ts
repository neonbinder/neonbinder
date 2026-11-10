/**
 * NEO-463 — a one-word player name that is a fuller-named player's first or
 * last name ("Walker" beside "Larry Walker") is never written silently.
 *
 * Every insert path asks the same question (`players.nameFragmentMatches`):
 *   - `players.findOrCreate` / `players.createByAdmin` refuse with
 *     `data.code === "PLAYER_NAME_FRAGMENT"` unless `oneNamePlayer: true`;
 *   - `entityReviewQueue.recordDecision` refuses a plain create the same way;
 *   - the bulk "Add All Remaining as New" leaves the row undecided;
 *   - the commit prelude holds a create back (no row, the name unreviewed).
 *
 * An exact-name row still links, a mononym with no clash is written as
 * before, and a clash in another sport does not count.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { NAME_FRAGMENT_SCAN_LIMIT, normalizePlayerName } from "./players";
import { ENTITY_REVIEW_BULK_PAGE } from "./entityReviewQueue";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_name_fragment_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_name_fragment_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      sportConfig: { skuCode: value.slice(0, 2).toUpperCase(), league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function playersNamed(t: T, name: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("players").collect()).filter((p) => p.name === name),
  );
}

/** The refusal's payload, as the client reads it from `ConvexError.data`. */
async function refusalData(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  return (err as { data?: unknown } | null)?.data;
}

// ===========================================================================
// nameFragmentCheck
// ===========================================================================

describe("NEO-463: players.nameFragmentCheck", () => {
  test("first- and last-token clashes are both reported", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const larry = await insertPlayer(t, sportId, "Larry Walker");
    const buehler = await insertPlayer(t, sportId, "Walker Buehler");
    await insertPlayer(t, sportId, "Mike Trout");

    const result = await asAdmin.query(api.players.nameFragmentCheck, {
      name: "walker",
      sportId,
    });
    expect(result.isFragment).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.matches.map((m) => m._id).sort()).toEqual([larry, buehler].sort());
  });

  test("a read that fills the scan limit is truncated and withholds the list", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    // More Smiths than one search reads: the one the operator means may be
    // past the bound, so a partial list must not be offered as the answer.
    for (let i = 0; i < NAME_FRAGMENT_SCAN_LIMIT + 4; i++) {
      await insertPlayer(t, sportId, `Player${String.fromCharCode(97 + (i % 26))}${i} Smith`);
    }

    const result = await asAdmin.query(api.players.nameFragmentCheck, {
      name: "Smith",
      sportId,
    });
    expect(result).toEqual({ isFragment: true, matches: [], truncated: true });
  });

  test("'Walker Jr.' is one token once the suffix drops", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");

    const result = await asAdmin.query(api.players.nameFragmentCheck, {
      name: "Walker Jr.",
      sportId,
    });
    expect(result.isFragment).toBe(true);
    expect(result.matches.map((m) => m.name)).toEqual(["Larry Walker"]);
  });

  test("two tokens are never a fragment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Met Jones");

    expect(
      await asAdmin.query(api.players.nameFragmentCheck, { name: "Mr. Met", sportId }),
    ).toEqual({ isFragment: false, matches: [], truncated: false });
  });

  test("a mononym with no clash is not a fragment", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Mike Trout");

    expect(
      await asAdmin.query(api.players.nameFragmentCheck, { name: "Takuya", sportId }),
    ).toEqual({ isFragment: false, matches: [], truncated: false });
  });

  test("a clash in another sport does not count", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    await insertPlayer(t, football, "Doak Walker");

    expect(
      await asAdmin.query(api.players.nameFragmentCheck, { name: "Walker", sportId: baseball }),
    ).toEqual({ isFragment: false, matches: [], truncated: false });
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.query(api.players.nameFragmentCheck, { name: "Walker", sportId }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// findOrCreate / createByAdmin
// ===========================================================================

describe("NEO-463: findOrCreate and createByAdmin refuse a fragment without the flag", () => {
  test("findOrCreate refuses with PLAYER_NAME_FRAGMENT and the matches", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const larry = await insertPlayer(t, sportId, "Larry Walker");

    const data = await refusalData(
      asAdmin.mutation(api.players.findOrCreate, { name: "Walker", sportId }),
    );
    expect(data).toMatchObject({
      code: "PLAYER_NAME_FRAGMENT",
      matches: [{ _id: larry, name: "Larry Walker" }],
      truncated: false,
    });
    // The message reaches Sentry and the console: fixed text, never the name.
    expect((data as { message: string }).message).not.toMatch(/walker/i);
    expect(await playersNamed(t, "Walker")).toHaveLength(0);
  });

  test("a truncated read still refuses, withholding the list", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    for (let i = 0; i < NAME_FRAGMENT_SCAN_LIMIT + 4; i++) {
      await insertPlayer(t, sportId, `Player${String.fromCharCode(97 + (i % 26))}${i} Smith`);
    }

    const data = await refusalData(
      asAdmin.mutation(api.players.findOrCreate, { name: "Smith", sportId }),
    );
    expect(data).toMatchObject({ code: "PLAYER_NAME_FRAGMENT", matches: [], truncated: true });
    expect(await playersNamed(t, "Smith")).toHaveLength(0);
  });

  test("findOrCreate creates it with oneNamePlayer: true", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Walker",
      sportId,
      oneNamePlayer: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.name).toBe("Walker");
  });

  test("an existing exact 'Walker' row links rather than refusing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");
    const walker = await insertPlayer(t, sportId, "Walker");

    expect(
      await asAdmin.mutation(api.players.findOrCreate, { name: "WALKER", sportId }),
    ).toBe(walker);
    expect(
      await asAdmin.mutation(api.players.createByAdmin, { name: "Walker", sportId }),
    ).toEqual({ id: walker, created: false });
  });

  test("a clash in another sport does not refuse", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    await insertPlayer(t, football, "Doak Walker");

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Walker",
      sportId: baseball,
    });
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.sportId).toBe(baseball);
  });

  test("a mononym with no clash is written as before", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Mike Trout");

    await asAdmin.mutation(api.players.findOrCreate, { name: "Pelé", sportId });
    const made = await asAdmin.mutation(api.players.createByAdmin, { name: "Boomer", sportId });
    expect(made.created).toBe(true);
    expect(await playersNamed(t, "Pelé")).toHaveLength(1);
  });

  test("createByAdmin refuses without the flag and creates with it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Walker Buehler");

    const data = await refusalData(
      asAdmin.mutation(api.players.createByAdmin, { name: "Walker", sportId }),
    );
    expect(data).toMatchObject({ code: "PLAYER_NAME_FRAGMENT" });
    expect(await playersNamed(t, "Walker")).toHaveLength(0);

    const made = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Walker",
      sportId,
      oneNamePlayer: true,
    });
    expect(made.created).toBe(true);
    expect(await playersNamed(t, "Walker")).toHaveLength(1);
  });
});

// ===========================================================================
// Entity review: recordDecision and the bulk create
// ===========================================================================

async function insertReviewRow(
  t: T,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    batchId: string;
    name: string;
    kind?: "player" | "team";
    decision?: { action: "create"; oneNamePlayer?: true };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: opts.kind ?? "player",
      name: opts.name,
      sportId: opts.sportId,
      status: "ready",
      ...(opts.decision ? { decision: opts.decision } : {}),
    }),
  );
}

describe("NEO-463: entity review refuses a plain create on a fragment", () => {
  test("recordDecision refuses a plain create and stores the confirmed one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");
    const rowId = await insertReviewRow(t, {
      selectorOptionId: sportId,
      sportId,
      batchId: "b1",
      name: "Walker",
    });

    const data = await refusalData(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
      }),
    );
    expect(data).toMatchObject({ code: "PLAYER_NAME_FRAGMENT" });
    expect((await t.run(async (ctx) => ctx.db.get(rowId)))!.decision).toBeUndefined();

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      oneNamePlayer: true,
    });
    expect((await t.run(async (ctx) => ctx.db.get(rowId)))!.decision).toEqual({
      action: "create",
      oneNamePlayer: true,
    });
  });

  test("recordDecision refuses the flag on a team row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const rowId = await insertReviewRow(t, {
      selectorOptionId: sportId,
      sportId,
      batchId: "b1",
      name: "Padres",
      kind: "team",
    });
    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        oneNamePlayer: true,
      }),
    ).rejects.toThrow(/one-name player/);
  });

  test("Add All Remaining as New skips a fragment and decides the rest", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");
    const fragment = await insertReviewRow(t, {
      selectorOptionId: sportId,
      sportId,
      batchId: "bulk",
      name: "Walker",
    });
    const fine = await insertReviewRow(t, {
      selectorOptionId: sportId,
      sportId,
      batchId: "bulk",
      name: "Daulton Varsho",
    });

    const result = await asAdmin.action(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: sportId,
      batchId: "bulk",
    });
    expect(result.decided).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(fragment)))!.decision).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(fine)))!.decision).toEqual({
      action: "create",
    });
  });

  test("a page of held fragments stops on its budget and the next page resumes", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Larry Walker");
    const { decide } = ENTITY_REVIEW_BULK_PAGE.create;
    const fragments: Array<Id<"entityReviewQueue">> = [];
    for (let i = 0; i < decide + 5; i++) {
      fragments.push(
        await insertReviewRow(t, { selectorOptionId: sportId, sportId, batchId: "held", name: "Walker" }),
      );
    }
    const fine = await insertReviewRow(t, {
      selectorOptionId: sportId,
      sportId,
      batchId: "held",
      name: "Daulton Varsho",
    });
    const rowTime = async (id: Id<"entityReviewQueue">) =>
      (await t.run(async (ctx) => ctx.db.get(id)))!._creationTime;
    const list = (cursor?: number) =>
      t.query(internal.entityReviewQueue.listBulkCandidates, {
        selectorOptionId: sportId,
        batchId: "held",
        ...(cursor !== undefined ? { cursor } : {}),
        action: "create",
        callerId: ADMIN_IDENTITY.subject,
      });

    // Every held fragment cost a search: the walk stops after `decide` of
    // them, though it scanned far fewer than `scan` rows and decided none.
    const first = await list();
    expect(first.ids).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(await rowTime(fragments[decide - 1]));

    const second = await list(first.cursor!);
    expect(second.ids).toEqual([fine]);
    expect(second.hasMore).toBe(false);
  });

  test("ten one-word names with no clash still bulk-create", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, "Mike Trout");
    const names = [
      "Pelé", "Takuya", "Boomer", "Ichiro", "Kaka", "Ronaldinho", "Hulk", "Neymar", "Garrincha", "Zico",
    ];
    for (const name of names) {
      await insertReviewRow(t, { selectorOptionId: sportId, sportId, batchId: "ten", name });
    }

    const result = await asAdmin.action(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: sportId,
      batchId: "ten",
    });
    expect(result.decided).toBe(10);
  });
});

// ===========================================================================
// The commit backstop
// ===========================================================================

async function seedSet(t: T) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
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
    return { sportId, variantTypeId };
  });
}

function card(cardNumber: string, players: string[]) {
  return {
    cardNumber,
    cardName: "Card",
    team: undefined,
    teams: [],
    players,
    attributes: [],
    isRookie: false,
    isRelic: false,
    printRun: undefined,
    autographType: undefined,
    cardVariation: undefined,
    platformData: {},
    unmatched: undefined,
  };
}

describe("NEO-463: the commit holds a fragment back instead of writing it", () => {
  test("a plain create on a fragment writes no player and lists the name as unreviewed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSet(t);
    await insertPlayer(t, sportId, "Larry Walker");
    // A decision recorded before the rule, or one a fuller name arrived behind.
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "c1",
      name: "Walker",
      decision: { action: "create" },
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [card("1", ["Walker"]), card("2", [])],
      batchId: "c1",
    });

    // The commit still lands.
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.unreviewedNameCount).toBe(1);
    expect(await playersNamed(t, "Walker")).toHaveLength(0);
    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    const one = cards.find((c) => c.cardNumber === "1")!;
    expect(one.pendingPlayerNames).toEqual(["Walker"]);
    expect(one.playerIds ?? []).toEqual([]);
  });

  test("a confirmed one-name create is written and linked", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSet(t);
    await insertPlayer(t, sportId, "Larry Walker");
    await insertReviewRow(t, {
      selectorOptionId: variantTypeId,
      sportId,
      batchId: "c2",
      name: "Walker",
      decision: { action: "create", oneNamePlayer: true },
    });

    const result = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [card("1", ["Walker"])],
      batchId: "c2",
    });

    expect(result.unreviewedNameCount).toBe(0);
    const [walker] = await playersNamed(t, "Walker");
    expect(walker).toBeDefined();
    const [one] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantTypeId))
        .collect(),
    );
    expect(one.playerIds).toEqual([walker._id]);
  });
});
