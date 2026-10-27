/**
 * NEO-362 — smart binders (`convex/binderRules.ts`) and a binder's settings
 * (`collectionContainers.setSettings`, `setRule`, `relayPockets`): a rule
 * names NB ids only, Find cards never moves anything on its own, a decline
 * can be taken back, empty slots stand for the cards a binder still needs,
 * and a visitor sees them only when the owner shares them.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema, { collectionRuleValidator } from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

const goodenRule = (s: S) => ({
  version: 1 as const,
  match: "all" as const,
  terms: [{ test: { kind: "player" as const, playerIds: [s.fx.goodenId] } }],
});

const smartBinder = async (s: S, rule: typeof collectionRuleValidator.type = goodenRule(s)) =>
  (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Doc", rule })).containerId;

const findAll = (s: S, containerId: Id<"collectionContainers">) =>
  s.me.query(api.binderRules.findCards, { containerId, paginationOpts: { numItems: 100, cursor: null } });

describe("a smart binder's rule", () => {
  test("is stored as ids and named for the cover; a binder with one is still a binder you file in", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    const listed = (await s.me.query(api.collectionContainers.list, {})).find((c) => c._id === id)!;
    expect(listed.rule).toEqual(goodenRule(s));
    expect(listed.ruleNames).toContainEqual({ id: s.fx.goodenId, name: "Dwight Gooden" });
    // It keeps pockets like any binder: a card added to it gets one.
    const { copyId } = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.strawberry2,
      details: { homeId: id, quantity: 1 },
    });
    const row = await s.t.run(async (ctx) => ctx.db.get(copyId as Id<"collectionCopies">));
    expect(row?.slot).toBe(0);
  });

  test("refuses a rule with nothing to include, a wrong kind of id, and Main", async () => {
    const s = await setup();
    await expect(
      s.me.mutation(api.collectionContainers.create, {
        kind: "binder",
        name: "Not",
        rule: { version: 1, match: "all", terms: [{ negate: true, test: { kind: "hallOfFame" } }] },
      }),
    ).rejects.toThrow(/what to include/);
    await expect(
      s.me.mutation(api.collectionContainers.create, {
        kind: "binder",
        name: "Wrong",
        rule: { version: 1, match: "all", terms: [{ test: { kind: "set", setIds: [s.fx.sportId] } }] },
      }),
    ).rejects.toThrow();
    const { mainId } = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await expect(
      s.me.mutation(api.collectionContainers.setRule, { containerId: mainId, rule: goodenRule(s) }),
    ).rejects.toThrow();
  });

  test("matchingCards says which cards fit, for the Checklists filter and outside-the-rule marks", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    const fits = await s.me.query(api.binderRules.matchingCards, {
      containerId: id,
      cardIds: [s.fx.gooden1, s.fx.strawberry2, s.fx.futureStar],
    });
    expect(fits.sort()).toEqual([s.fx.gooden1, s.fx.futureStar].sort());
  });

  test("not, numbered and rookie lines", async () => {
    const s = await setup();
    const id = await smartBinder(s, {
      version: 1,
      match: "all",
      terms: [
        { test: { kind: "player", playerIds: [s.fx.goodenId] } },
        { negate: true, test: { kind: "printRun", max: 99 } },
        { test: { kind: "feature", feature: "RC" } },
      ],
    });
    const fits = await s.me.query(api.binderRules.matchingCards, {
      containerId: id,
      cardIds: [s.fx.gooden1, s.fx.gold1, s.fx.futureStar],
    });
    // gold1 is /50 (left out); only #1 is a rookie card.
    expect(fits).toEqual([s.fx.gooden1]);
  });
});

describe("Find cards", () => {
  test("lists copies that fit anywhere else, never moves them, and a decline can be taken back", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 3 } });
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2 });
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.futureStar });
    const id = await smartBinder(s);

    const first = await findAll(s, id);
    expect(first.page.map((c) => c.cardId).sort()).toEqual([s.fx.gooden1, s.fx.futureStar].sort());
    const here = await s.me.query(api.collection.copiesInContainer, {
      containerId: id,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(here.page).toHaveLength(0);

    // Add one of the three: the rest stay where they were.
    const stack = first.page.find((c) => c.cardId === s.fx.gooden1)!;
    await s.me.mutation(api.collection.moveCopy, { copyId: stack._id, toHomeId: id, quantity: 1 });
    const after = await findAll(s, id);
    expect(after.page.find((c) => c.cardId === s.fx.gooden1)?.quantity).toBe(2);

    await s.me.mutation(api.binderRules.decline, { containerId: id, cardId: s.fx.futureStar });
    expect((await findAll(s, id)).page.map((c) => c.cardId)).not.toContain(s.fx.futureStar);
    const declined = await s.me.query(api.binderRules.declined, { containerId: id });
    expect(declined.map((d) => d.cardId)).toEqual([s.fx.futureStar]);

    await s.me.mutation(api.binderRules.undecline, { containerId: id, cardId: s.fx.futureStar });
    expect((await findAll(s, id)).page.map((c) => c.cardId)).toContain(s.fx.futureStar);
  });

  test("taking the rule off forgets its declines; another collector sees nothing", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.futureStar });
    const id = await smartBinder(s);
    await s.me.mutation(api.binderRules.decline, { containerId: id, cardId: s.fx.futureStar });
    expect(await s.them.query(api.binderRules.declined, { containerId: id })).toEqual([]);
    expect((await s.them.query(api.binderRules.findCards, { containerId: id, paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
    await expect(
      s.them.mutation(api.binderRules.decline, { containerId: id, cardId: s.fx.gooden1 }),
    ).rejects.toThrow();

    const { previous } = await s.me.mutation(api.collectionContainers.setRule, { containerId: id, rule: null });
    expect(previous).toEqual(goodenRule(s));
    const rows = await s.t.run(async (ctx) => ctx.db.query("collectionBinderDeclines").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("played for (NEO-362)", () => {
  test("a card that shows the player on the team fits, even with no stints on file", async () => {
    const s = await setup();
    const id = await smartBinder(s, {
      version: 1,
      match: "all",
      terms: [{ test: { kind: "playedFor", teamIds: [s.fx.metsId] } }],
    });
    const fits = await s.me.query(api.binderRules.matchingCards, {
      containerId: id,
      cardIds: [s.fx.gooden1, s.fx.strawberry2],
    });
    expect(fits).toEqual([s.fx.gooden1, s.fx.strawberry2]);
    const other = await smartBinder(s, {
      version: 1,
      match: "all",
      terms: [{ test: { kind: "playedFor", teamIds: [s.fx.exposId] } }],
    });
    expect(await s.me.query(api.binderRules.matchingCards, { containerId: other, cardIds: [s.fx.gooden1] })).toEqual([]);
  });
});

describe("empty slots", () => {
  test("a smart binder's needs are the rule's cards it lacks, marked when held in another binder", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { homeId: id, quantity: 1 } });
    const before = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(before.supported).toBe(true);
    const ids = before.needs.map((n) => n.card._id);
    expect(ids).not.toContain(s.fx.gooden1);
    expect(ids).toContain(s.fx.futureStar);
    expect(before.needs.find((n) => n.card._id === s.fx.futureStar)?.held).toBe(false);
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.futureStar });
    const after = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(after.needs.find((n) => n.card._id === s.fx.futureStar)?.held).toBe(true);
  });

  test("a parallel shows no empty slots until the smart binder holds a card of it", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    const first = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(first.needs.map((n) => n.card._id)).not.toContain(s.fx.gold1);
    // Holding a Gold Refractor opens the parallel's checklist: its gaps show.
    const gold = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(s.fx.gold1))!;
      const id = await ctx.db.insert("cardChecklist", { ...rest, cardNumber: "99" });
      await ctx.db.insert("cardPlayerLinks", { cardChecklistId: id, playerId: s.fx.goodenId, sportId: s.fx.sportId });
      return id;
    });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gold1, details: { homeId: id, quantity: 1 } });
    const after = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(after.needs.map((n) => n.card._id)).toContain(gold);
  });

  test("a plain binder's needs are the regular cards of the checklists it holds", async () => {
    const s = await setup();
    const id = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Chrome" })).containerId;
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { homeId: id, quantity: 1 } });
    const { needs } = await s.me.query(api.binderRules.needs, { containerId: id });
    // Base's other regular card; never the Sliding variation.
    expect(needs.map((n) => n.card._id)).toEqual([s.fx.strawberry2]);
  });
});

describe("binder settings", () => {
  test("save, put back with null, and refuse a box", async () => {
    const s = await setup();
    const id = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Sorted" })).containerId;
    const first = await s.me.mutation(api.collectionContainers.setSettings, { containerId: id, sort: "player", emptySlots: true });
    expect(first.previous).toEqual({});
    const listed = (await s.me.query(api.collectionContainers.list, {})).find((c) => c._id === id)!;
    expect(listed.settings).toEqual({ sort: "player", emptySlots: true });
    const back = await s.me.mutation(api.collectionContainers.setSettings, { containerId: id, sort: null });
    expect(back.previous).toEqual({ sort: "player", emptySlots: true });
    const box = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Box" })).containerId;
    await expect(
      s.me.mutation(api.collectionContainers.setSettings, { containerId: box, sort: "team" }),
    ).rejects.toThrow();
    await expect(
      s.them.mutation(api.collectionContainers.setSettings, { containerId: id, sort: "team" }),
    ).rejects.toThrow();
  });

  test("relayPockets writes every line's pocket once, and refuses a layout that misses one", async () => {
    const s = await setup();
    const id = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Lay" })).containerId;
    const a = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { homeId: id, quantity: 1 } });
    const b = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.strawberry2, details: { homeId: id, quantity: 1 } });
    const aId = a.copyId as Id<"collectionCopies">;
    const bId = b.copyId as Id<"collectionCopies">;
    await expect(
      s.me.mutation(api.collectionContainers.relayPockets, { containerId: id, slots: [{ copyId: aId, slot: 4 }] }),
    ).rejects.toThrow();
    await expect(
      s.me.mutation(api.collectionContainers.relayPockets, {
        containerId: id,
        slots: [
          { copyId: aId, slot: 4 },
          { copyId: bId, slot: 4 },
        ],
      }),
    ).rejects.toThrow();
    const { previous } = await s.me.mutation(api.collectionContainers.relayPockets, {
      containerId: id,
      slots: [
        { copyId: aId, slot: 10 },
        { copyId: bId, slot: 2 },
      ],
    });
    expect(previous.sort((x, y) => x.slot - y.slot)).toEqual([
      { copyId: aId, slot: 0 },
      { copyId: bId, slot: 1 },
    ]);
    const rows = await s.t.run(async (ctx) => Promise.all([ctx.db.get(aId), ctx.db.get(bId)]));
    expect(rows.map((r) => r?.slot)).toEqual([10, 2]);
  });
});

describe("brandsOfSport", () => {
  test("groups a brand's rows across years under its NB name", async () => {
    const s = await setup();
    const brands = await s.me.query(api.binderRules.brandsOfSport, { sportId: s.fx.sportId });
    expect(brands).toHaveLength(1);
    expect(brands[0].name).toBe("Topps");
    expect([...brands[0].ids].sort()).toEqual([s.fx.toppsId, s.fx.topps86Id].sort());
  });
});
