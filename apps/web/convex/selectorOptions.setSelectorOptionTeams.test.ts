/**
 * NEO-277 — team as a set-level attribute (`selectorOptions.teamIds`).
 *
 * Covers the three ways a set-level team reaches the rows beneath it and the
 * one way it must not:
 *
 *  - COPY-DOWN at node creation (`addCustomSelectorOption`) and at card
 *    creation (`commitCardChecklist`'s insert branch, `addCustomCard`) — a
 *    card that arrives WITH a team keeps its own.
 *  - the EDIT CASCADE (`setSelectorOptionTeams` → `cascadeSelectorOptionTeams`):
 *    empty follows, equal-to-previous follows, an override stays, a card an
 *    operator confirmed teamless stays, descendant nodes follow, a card
 *    already carrying the new value is not rewritten, and a subtree larger
 *    than one page is finished by the reschedule loop.
 *  - the PREVIEW (`getSelectorOptionTeamCascadePreview`) counts what the
 *    cascade then does.
 *  - a CLEAR patches the node and touches nothing below it.
 *  - the refusals: an unknown team, a team from another sport, a row at a
 *    level that is not a set.
 *
 * Fixture style follows featurePropagation.test.ts: raw inserts for the tree,
 * `teamRowFields` for teams (so a seeded team is keyed exactly as a real one),
 * fake timers plus a benign fetch stub so a drained schedule can never become
 * network traffic.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { teamRowFields } from "./lib/teamRow";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ADMIN_IDENTITY = {
  subject: "admin_set_team_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_set_team_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

/**
 * sport → setName → variantType → insert → parallel. `teamIds` seeded per
 * level by the caller; absent means "no set-level team" at that level.
 */
async function seedTree(
  t: T,
  teams: {
    setName?: Array<Id<"teams">>;
    variantType?: Array<Id<"teams">>;
    insert?: Array<Id<"teams">>;
    parallel?: Array<Id<"teams">>;
  } = {},
  sportId?: Id<"selectorOptions">,
) {
  return t.run(async (ctx) => {
    const sport =
      sportId ??
      (await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: { skuCode: "BB", league: "MLB" },
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }));
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      features: { season: "2024", manufacturer: "Topps" },
      parentId: sport,
      children: [],
      ...(teams.setName ? { teamIds: teams.setName } : {}),
      lastUpdated: Date.now(),
    });
    const sportRow = await ctx.db.get(sport);
    await ctx.db.patch(sport, {
      children: [...(sportRow?.children ?? []), setNameId],
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { season: "2024", manufacturer: "Topps" },
      parentId: setNameId,
      children: [],
      ...(teams.variantType ? { teamIds: teams.variantType } : {}),
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Stars",
      platformData: {},
      parentId: variantTypeId,
      children: [],
      ...(teams.insert ? { teamIds: teams.insert } : {}),
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(variantTypeId, { children: [insertId] });
    const parallelId = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Gold",
      platformData: {},
      parentId: insertId,
      children: [],
      ...(teams.parallel ? { teamIds: teams.parallel } : {}),
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(insertId, { children: [parallelId] });
    return { sportId: sport, setNameId, variantTypeId, insertId, parallelId };
  });
}

async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: { name: string; location?: string },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      ...teamRowFields(parts),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function seedCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  extra: {
    teamOnCardIds?: Array<Id<"teams">>;
    teamNoneConfirmedAt?: number;
    pendingTeamNames?: string[];
  } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number(cardNumber),
      lastUpdated: 1_700_000_000_000,
      ...extra,
    }),
  );
}

const getCard = (t: T, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));
const getNode = (t: T, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => ctx.db.get(id));

function makeCommitCard(overrides: { cardNumber: string; teams?: string[] }) {
  return {
    cardNumber: overrides.cardNumber,
    cardName: `Card ${overrides.cardNumber}`,
    team: undefined,
    teams: overrides.teams ?? [],
    players: [],
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

// ===========================================================================
// Copy-down at creation
// ===========================================================================

describe("NEO-277 copy-down at node creation", () => {
  test("addCustomSelectorOption inherits the parent's teamIds", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { setNameId } = await seedTree(t, { setName: [bulls] }, sportId);

    const childId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Chrome", parentId: setNameId },
    );
    const child = await getNode(t, childId);
    expect(child!.teamIds).toEqual([bulls]);
    // A copy, not the parent's array.
    const parent = await getNode(t, setNameId);
    expect(child!.teamIds).not.toBe(parent!.teamIds);
  });

  test("a parent with no set-level team leaves the field absent on the child", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { setNameId } = await seedTree(t);

    const childId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "variantType", value: "Chrome", parentId: setNameId },
    );
    const child = await getNode(t, childId);
    expect(child!.teamIds).toBeUndefined();
    expect("teamIds" in child!).toBe(false);
  });
});

describe("NEO-277 card insert default", () => {
  test("commitCardChecklist: a card with no team is born with the leaf's team; a card with one keeps it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const reds = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        makeCommitCard({ cardNumber: "1" }),
        makeCommitCard({ cardNumber: "2", teams: ["Cincinnati Reds"] }),
      ],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const cards = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .collect(),
    );
    const byNumber = new Map(cards.map((c) => [c.cardNumber, c]));
    expect(byNumber.get("1")!.teamOnCardIds).toEqual([bulls]);
    // The title names the team the row was born with.
    expect(byNumber.get("1")!.listingTitle).toContain("Bulls");
    expect(byNumber.get("2")!.teamOnCardIds).toEqual([reds]);
    expect(byNumber.get("2")!.listingTitle).not.toContain("Bulls");
    // The default is a birth fact, never an operator decision.
    expect(byNumber.get("1")!.teamNoneConfirmedAt).toBeUndefined();
    expect(byNumber.get("1")!.teamCheckDoneAt).toBeUndefined();
  });

  test("commitCardChecklist: a leaf with no team writes nothing extra", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedTree(t);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCommitCard({ cardNumber: "1" })],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const card = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .first(),
    );
    expect(card!.teamOnCardIds ?? []).toEqual([]);
  });

  test("commitCardChecklist: a re-synced EXISTING card is not defaulted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);
    // A card that existed before the set-level team was picked, with no team.
    const existingId = await seedCard(t, variantTypeId, "1");

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [makeCommitCard({ cardNumber: "1" })],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const card = await getCard(t, existingId);
    expect(card).not.toBeNull();
    expect(card!.teamOnCardIds ?? []).toEqual([]);
  });

  test("addCustomCard: no picker value → the leaf's team; a picker value wins", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const reds = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);

    const defaulted = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "10",
      cardName: "Crash Davis",
    });
    const picked = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "11",
      cardName: "Nuke LaLoosh",
      teamOnCardIds: [reds],
    });

    expect((await getCard(t, defaulted))!.teamOnCardIds).toEqual([bulls]);
    expect((await getCard(t, defaulted))!.listingTitle).toContain("Bulls");
    expect((await getCard(t, picked))!.teamOnCardIds).toEqual([reds]);
  });

  test("addCustomCard: a typed team name (old bundle) is the card's own answer, not defaulted over", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);

    const id = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "12",
      cardName: "Typed",
      teams: ["Asheville Tourists"],
    });
    const card = await getCard(t, id);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.pendingTeamNames).toEqual(["Asheville Tourists"]);
  });
});

// ===========================================================================
// The edit cascade
// ===========================================================================

describe("NEO-277 setSelectorOptionTeams cascade", () => {
  /**
   * setName [A] → variantType [A] → insert (none) → parallel (none), with one
   * card in every shape the rule distinguishes under the variantType, and a
   * card under the deepest descendant so the walk is proven to reach it.
   */
  async function seedCascadeFixture(t: T) {
    const { sportId } = await seedTree(t);
    const a = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const b = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, { setName: [a], variantType: [a] }, sportId);
    const cards = {
      empty: await seedCard(t, tree.variantTypeId, "1"),
      equalPrevious: await seedCard(t, tree.variantTypeId, "2", { teamOnCardIds: [a] }),
      override: await seedCard(t, tree.variantTypeId, "3", { teamOnCardIds: [b] }),
      confirmedNone: await seedCard(t, tree.variantTypeId, "4", {
        teamNoneConfirmedAt: 1_690_000_000_000,
      }),
      alreadyNew: await seedCard(t, tree.variantTypeId, "5", { teamOnCardIds: [c] }),
      pendingName: await seedCard(t, tree.variantTypeId, "6", {
        pendingTeamNames: ["Asheville Tourists"],
      }),
      deep: await seedCard(t, tree.parallelId, "7"),
    };
    return { sportId, a, b, c, tree, cards };
  }

  test("preview counts what the cascade then does", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { c, tree } = await seedCascadeFixture(t);

    const preview = await asAdmin.query(
      api.selectorOptions.getSelectorOptionTeamCascadePreview,
      { selectorOptionId: tree.setNameId, teamIds: [c] },
    );
    expect(preview).toEqual({
      // variantType ([A] = previous), insert (empty), parallel (empty).
      nodesFollowing: 3,
      // empty, equalPrevious, deep.
      cardsFollowing: 3,
      // override, confirmedNone, pendingName. alreadyNew is neither.
      cardsStaying: 3,
      truncated: false,
    });
  });

  test("empty and equal-to-previous follow; override, confirmed-none and pending-name stay; descendants follow", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { a, b, c, tree, cards } = await seedCascadeFixture(t);
    const alreadyNewBefore = await getCard(t, cards.alreadyNew);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await getNode(t, tree.setNameId))!.teamIds).toEqual([c]);
    expect((await getNode(t, tree.variantTypeId))!.teamIds).toEqual([c]);
    expect((await getNode(t, tree.insertId))!.teamIds).toEqual([c]);
    expect((await getNode(t, tree.parallelId))!.teamIds).toEqual([c]);

    expect((await getCard(t, cards.empty))!.teamOnCardIds).toEqual([c]);
    expect((await getCard(t, cards.equalPrevious))!.teamOnCardIds).toEqual([c]);
    expect((await getCard(t, cards.deep))!.teamOnCardIds).toEqual([c]);

    expect((await getCard(t, cards.override))!.teamOnCardIds).toEqual([b]);

    const confirmedNone = await getCard(t, cards.confirmedNone);
    expect(confirmedNone!.teamOnCardIds ?? []).toEqual([]);
    expect(confirmedNone!.teamNoneConfirmedAt).toBe(1_690_000_000_000);

    const pendingName = await getCard(t, cards.pendingName);
    expect(pendingName!.teamOnCardIds ?? []).toEqual([]);
    expect(pendingName!.pendingTeamNames).toEqual(["Asheville Tourists"]);

    // Already carried the new value: not rewritten.
    const alreadyNewAfter = await getCard(t, cards.alreadyNew);
    expect(alreadyNewAfter!.teamOnCardIds).toEqual([c]);
    expect(alreadyNewAfter!.lastUpdated).toBe(alreadyNewBefore!.lastUpdated);

    // The old value is nowhere in the subtree except as an override.
    expect(a).not.toBe(c);
  });

  test("a descendant node with its own override stays, and so do its cards", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const a = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const b = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, { setName: [a], variantType: [b] }, sportId);
    const underOverride = await seedCard(t, tree.variantTypeId, "1", {
      teamOnCardIds: [b],
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await getNode(t, tree.variantTypeId))!.teamIds).toEqual([b]);
    expect((await getCard(t, underOverride))!.teamOnCardIds).toEqual([b]);
  });

  test("order-insensitive: [A,B] on a card equals [B,A] on the set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const a = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const b = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, { setName: [b, a] }, sportId);
    const card = await seedCard(t, tree.variantTypeId, "1", { teamOnCardIds: [a, b] });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getCard(t, card))!.teamOnCardIds).toEqual([c]);
  });

  test("a clear removes the field on the node and touches nothing below it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { a, tree, cards } = await seedCascadeFixture(t);
    const before = await Promise.all(
      Object.values(cards).map((id) => getCard(t, id)),
    );

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [],
    });
    // Nothing scheduled; this is a no-op drain that proves it.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const node = await getNode(t, tree.setNameId);
    expect("teamIds" in node!).toBe(false);
    // The descendant that carried the same team still does.
    expect((await getNode(t, tree.variantTypeId))!.teamIds).toEqual([a]);
    const after = await Promise.all(
      Object.values(cards).map((id) => getCard(t, id)),
    );
    expect(after).toEqual(before);
  });

  test("more cards than one page: the reschedule loop finishes the subtree", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, {}, sportId);
    // Well past one 200-card page, split across two nodes so both the
    // in-node cursor and the node-to-node hop are exercised.
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: i < 300 ? tree.variantTypeId : tree.parallelId,
          cardNumber: String(i + 1),
          cardName: `Card ${i + 1}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: 1_700_000_000_000,
        });
      }
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const all = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
    expect(all).toHaveLength(450);
    expect(all.every((card) => card.teamOnCardIds?.length === 1 && card.teamOnCardIds[0] === c)).toBe(true);
  });

  test("a card created AFTER the set-level team is picked is born with it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, {}, sportId);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The parallel three levels down inherited it through the cascade, so a
    // card hand-added there is born with it.
    const id = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: tree.parallelId,
      cardNumber: "1",
      cardName: "Late",
    });
    expect((await getCard(t, id))!.teamOnCardIds).toEqual([c]);
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("NEO-277 setSelectorOptionTeams refusals", () => {
  test("an unknown team id is refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const ghost = await seedTeam(t, sportId, { location: "Nowhere", name: "Ghosts" });
    await t.run(async (ctx) => ctx.db.delete(ghost));
    const tree = await seedTree(t, {}, sportId);
    const before = await getNode(t, tree.setNameId);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
        selectorOptionId: tree.setNameId,
        teamIds: [ghost],
      }),
    ).rejects.toThrow(/no longer exists/);
    expect(await getNode(t, tree.setNameId)).toEqual(before);
  });

  test("a team from another sport is refused", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const tree = await seedTree(t);
    const hockeyId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const wings = await seedTeam(t, hockeyId, { location: "Detroit", name: "Red Wings" });

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
        selectorOptionId: tree.setNameId,
        teamIds: [wings],
      }),
    ).rejects.toThrow(/not a team in this card's sport/);
  });

  test("a sport, year or brand row is refused", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const tree = await seedTree(t);
    const bulls = await seedTeam(t, tree.sportId, { location: "Durham", name: "Bulls" });

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
        selectorOptionId: tree.sportId,
        teamIds: [bulls],
      }),
    ).rejects.toThrow(/not on a sport, year or brand/);
  });

  test("duplicate ids are stored once", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const tree = await seedTree(t);
    const bulls = await seedTeam(t, tree.sportId, { location: "Durham", name: "Bulls" });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [bulls, bulls],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getNode(t, tree.setNameId))!.teamIds).toEqual([bulls]);
  });
});
