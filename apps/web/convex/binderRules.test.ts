/**
 * NEO-362 — smart binders (`convex/binderRules.ts`) and a binder's settings
 * (`collectionContainers.setSettings`, `setRule`, `relayPockets`): a rule
 * names NB ids only, Find cards never moves anything on its own, a decline
 * can be taken back, empty slots stand for the cards a binder still needs,
 * and a visitor sees them only when the owner shares them.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema, { collectionRuleValidator } from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";
import { binderNeeds } from "./binderRules";
import { CatalogReader } from "./lib/catalogView";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const ADMIN = { subject: "user_admin", role: "admin" };

/**
 * NEO-401: a smart binder's fits are computed by a SCHEDULED mutation
 * (`recomputeFits`), so every test runs on fake timers and `settle` drains
 * the scheduler before an empty-slots read.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

const settle = (s: S) => s.t.finishAllScheduledFunctions(vi.runAllTimers);

const fitsOf = (s: S, binderId: Id<"collectionContainers">) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("collectionBinderFits")
      .withIndex("by_binder_order", (q) => q.eq("binderId", binderId))
      .collect(),
  );
const fitsStateOf = (s: S, binderId: Id<"collectionContainers">) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("collectionBinderFitsState")
      .withIndex("by_binder", (q) => q.eq("binderId", binderId))
      .unique(),
  );

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
    // NEO-401: until the scheduled recompute lands there are no slots yet —
    // and no catalog walk inside the read.
    expect(await s.me.query(api.binderRules.needs, { containerId: id })).toEqual({
      needs: [],
      supported: true,
      truncated: false,
      pending: true,
    });
    await settle(s);
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
    await settle(s);
    const first = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(first.needs.map((n) => n.card._id)).not.toContain(s.fx.gold1);
    // The stored fits leave the parallel out too: nothing of it is kept
    // until the binder holds a card of it.
    expect((await fitsOf(s, id)).map((f) => f.cardId)).not.toContain(s.fx.gold1);
    // Holding a Gold Refractor opens the parallel's checklist: its gaps show.
    const gold = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(s.fx.gold1))!;
      const id = await ctx.db.insert("cardChecklist", { ...rest, cardNumber: "99" });
      await ctx.db.insert("cardPlayerLinks", { cardChecklistId: id, playerId: s.fx.goodenId, sportId: s.fx.sportId });
      return id;
    });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gold1, details: { homeId: id, quantity: 1 } });
    // The arrival of a parallel the binder did not hold is the one write
    // that schedules a recompute (`binderFits.noteArrivals`).
    expect((await fitsOf(s, id)).map((f) => f.cardId)).not.toContain(gold);
    await settle(s);
    const after = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(after.needs.map((n) => n.card._id)).toContain(gold);
    // ...and once the binder no longer holds any of it, its gaps hide again
    // live, without waiting for a recompute.
    const copies = await s.me.query(api.collection.copiesOf, { cardId: s.fx.gold1 });
    for (const copy of copies) await s.me.mutation(api.collection.removeCopy, { copyId: copy._id });
    const hidden = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(hidden.needs.map((n) => n.card._id)).not.toContain(gold);
  });

  test("a stored slot reads its card live: an edit shows at once and a deleted card is no slot (NEO-401)", async () => {
    const s = await setup();
    const admin = s.t.withIdentity(ADMIN);
    const id = await smartBinder(s);
    await settle(s);
    expect((await fitsOf(s, id)).map((f) => f.cardId)).toContain(s.fx.futureStar);
    // The slot shows the card as it is now, the same view the catalog shows.
    await s.t.run((ctx) => ctx.db.patch(s.fx.futureStar, { cardName: "Renamed in Set Builder" }));
    const need = (await s.me.query(api.binderRules.needs, { containerId: id })).needs.find(
      (n) => n.card._id === s.fx.futureStar,
    );
    const live = await s.t.run(async (ctx) => new CatalogReader(ctx).cardWithPath((await ctx.db.get(s.fx.futureStar))!));
    expect(need?.card).toEqual(live);
    expect(need?.card.cardName).toBe("Renamed in Set Builder");
    // Deleted before any recompute: the stored row is still there, the slot is not.
    await admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.futureStar });
    const after = await s.me.query(api.binderRules.needs, { containerId: id });
    expect(after.needs.map((n) => n.card._id)).not.toContain(s.fx.futureStar);
    expect(after.needs.length).toBeGreaterThan(0);
  });

  test("the held mark follows every copy write: add, move to a box and back, remove, and only on the other binder's rows (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    const twin = await smartBinder(s);
    await settle(s);
    const heldIn = async (binderId: Id<"collectionContainers">) =>
      (await fitsOf(s, binderId)).find((f) => f.cardId === s.fx.futureStar)?.held;
    const shownHeld = async (binderId: Id<"collectionContainers">) =>
      (await s.me.query(api.binderRules.needs, { containerId: binderId })).needs.find(
        (n) => n.card._id === s.fx.futureStar,
      )?.held;
    expect(await heldIn(id)).toBe(false);

    // A copy in a plain binder marks both smart binders' slots.
    const keepers = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Keepers" })).containerId;
    const box = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Box" })).containerId;
    const added = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.futureStar,
      details: { homeId: keepers, quantity: 1 },
    });
    expect(await heldIn(id)).toBe(true);
    expect(await heldIn(twin)).toBe(true);
    expect(await shownHeld(id)).toBe(true);

    // To a box: in no binder, so unmarked. Back to a binder: marked again.
    await s.me.mutation(api.collection.moveCopy, { copyId: added.copyId as Id<"collectionCopies">, toHomeId: box });
    expect(await heldIn(id)).toBe(false);
    expect(await shownHeld(id)).toBe(false);
    const inBox = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.futureStar))
        .first(),
    );
    await s.me.mutation(api.collection.moveCopy, { copyId: inBox!._id, toHomeId: keepers });
    expect(await heldIn(id)).toBe(true);

    // Into one smart binder: that binder has the card (no slot); the twin's
    // row is marked held, as the card is in a binder other than the twin.
    const inKeepers = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.futureStar))
        .first(),
    );
    await s.me.mutation(api.collection.moveCopy, { copyId: inKeepers!._id, toHomeId: id });
    expect(await heldIn(id)).toBe(false);
    expect(await heldIn(twin)).toBe(true);
    expect((await s.me.query(api.binderRules.needs, { containerId: id })).needs.map((n) => n.card._id)).not.toContain(
      s.fx.futureStar,
    );

    // Removed: unmarked everywhere.
    const inId = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.futureStar))
        .first(),
    );
    await s.me.mutation(api.collection.removeCopy, { copyId: inId!._id });
    expect(await heldIn(twin)).toBe(false);
  });

  test("a public read never learns the held mark, and a row stored before the mark existed reads it live (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const keepers = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "Keepers" })).containerId;
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.futureStar, details: { homeId: keepers, quantity: 1 } });
    expect((await fitsOf(s, id)).find((f) => f.cardId === s.fx.futureStar)?.held).toBe(true);
    const publicNeeds = await s.t.run(async (ctx) => binderNeeds(ctx, (await ctx.db.get(id))!, null));
    expect(publicNeeds.needs.find((n) => n.card._id === s.fx.futureStar)?.held).toBe(false);

    // An old row with no mark: the owner's read works it out live.
    const row = (await fitsOf(s, id)).find((f) => f.cardId === s.fx.futureStar)!;
    await s.t.run((ctx) => ctx.db.patch(row._id, { held: undefined }));
    expect(
      (await s.me.query(api.binderRules.needs, { containerId: id })).needs.find((n) => n.card._id === s.fx.futureStar)
        ?.held,
    ).toBe(true);
  });

  test("the stored fits follow the rule: saved, changed, taken off, and gone with the binder (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const stored = await fitsOf(s, id);
    expect(stored.map((f) => f.cardId)).toEqual(expect.arrayContaining([s.fx.gooden1, s.fx.futureStar]));
    expect(stored.map((f) => f.order)).toEqual(stored.map((_, i) => i));
    expect(await fitsStateOf(s, id)).toMatchObject({ supported: true, complete: true, count: stored.length });

    // A rule with no way into the catalog stores nothing and says so.
    await s.me.mutation(api.collectionContainers.setRule, {
      containerId: id,
      rule: { version: 1, match: "all", terms: [{ test: { kind: "hallOfFame" } }] },
    });
    // Until the recompute lands the old rule's rows stand, flagged pending:
    // the save itself wrote nothing heavy.
    expect((await fitsOf(s, id)).length).toBe(stored.length);
    expect(await s.me.query(api.binderRules.needs, { containerId: id })).toMatchObject({ pending: true });
    await settle(s);
    expect(await fitsOf(s, id)).toEqual([]);
    expect(await fitsStateOf(s, id)).toMatchObject({ supported: false, count: 0 });
    expect(await s.me.query(api.binderRules.needs, { containerId: id })).toMatchObject({
      supported: false,
      needs: [],
      pending: false,
    });

    // Back to a rule that fits: rows return. Taking the rule off removes them.
    await s.me.mutation(api.collectionContainers.setRule, { containerId: id, rule: goodenRule(s) });
    await settle(s);
    expect((await fitsOf(s, id)).length).toBe(stored.length);
    await s.me.mutation(api.collectionContainers.setRule, { containerId: id, rule: null });
    await settle(s);
    expect(await fitsOf(s, id)).toEqual([]);
    expect(await fitsStateOf(s, id)).toBeNull();

    // Deleting a smart binder takes its fits with it.
    const other = await smartBinder(s);
    await settle(s);
    expect((await fitsOf(s, other)).length).toBeGreaterThan(0);
    await s.me.mutation(api.collectionContainers.remove, { containerId: other });
    await settle(s);
    expect(await fitsOf(s, other)).toEqual([]);
    expect(await fitsStateOf(s, other)).toBeNull();
  });

  test("only a parallel the binder did not hold schedules a recompute; a base card or a private card never does (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const stamp = () => fitsStateOf(s, id).then((st) => st!.computedAt);
    const before = await stamp();
    vi.advanceTimersByTime(1000);

    // A base card arriving: nothing stored changes, so nothing is scheduled.
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { homeId: id, quantity: 1 } });
    await settle(s);
    expect(await stamp()).toBe(before);

    // A private card (NEO-361) is in no catalog set: the hook steps over it.
    const { privateCardId } = await s.me.mutation(api.collectionRequests.requestCard, {
      setId: s.fx.setId,
      variantId: s.fx.baseId,
      cardNumber: "#7",
      player: "Mike Piazza",
    });
    await s.me.mutation(api.collection.addLineItem, { cardId: privateCardId, details: { homeId: id, quantity: 1 } });
    await settle(s);
    expect(await stamp()).toBe(before);

    // The first card of a parallel the binder did not hold DOES recompute;
    // a second card of the same parallel does not.
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gold1, details: { homeId: id, quantity: 1 } });
    await settle(s);
    const afterGold = await stamp();
    expect(afterGold).toBeGreaterThan(before);
    vi.advanceTimersByTime(1000);
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gold1, details: { homeId: id, quantity: 1, condition: "Mint" } });
    await settle(s);
    expect(await stamp()).toBe(afterGold);
  });

  test("recomputing on an unchanged catalog rewrites nothing: same rows, same order (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const first = await fitsOf(s, id);
    expect(first.length).toBeGreaterThan(1);
    await s.t.action(internal.binderRules.recomputeFits, { binderId: id });
    const second = await fitsOf(s, id);
    expect(second.map((f) => [f._id, f.order, f.cardId])).toEqual(first.map((f) => [f._id, f.order, f.cardId]));
    expect((await fitsStateOf(s, id))?.count).toBe(first.length);
  });

  test("a nightly pass with more due than one batch hands on to another pass (NEO-401)", async () => {
    const s = await setup();
    // 101 aged state rows, each for a binder that has no rule any more: the
    // recompute of each simply removes its state, which is how we can see
    // that every one of them was reached.
    const aged = Date.now() - 25 * 60 * 60 * 1000;
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 101; i += 1) {
        const binderId = await ctx.db.insert("collectionContainers", {
          ownerId: ME.subject,
          kind: "binder",
          name: `Plain ${i}`,
          lastUpdated: aged,
        });
        await ctx.db.insert("collectionBinderFitsState", {
          ownerId: ME.subject,
          binderId,
          computedAt: aged,
          supported: true,
          complete: true,
          count: 0,
        });
      }
    });
    expect(await s.t.mutation(internal.binderRules.refreshStaleFits, {})).toEqual({ scheduled: 100, more: true });
    // The scheduled hundred are stamped, so the hand-on pass sees only the one left.
    const left = await s.t.run(async (ctx) =>
      ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_computed", (q) => q.lt("computedAt", Date.now() - 20 * 60 * 60 * 1000))
        .collect(),
    );
    expect(left.length).toBe(1);
    await settle(s);
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionBinderFitsState").collect())).toEqual([]);
  });

  test("the nightly refresh slots in a card added to the catalog after the rule was saved (NEO-401)", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const before = (await fitsOf(s, id)).length;
    // A new Gooden card appears in the catalog; the stored fits do not know it.
    const fresh = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(s.fx.gooden1))!;
      const cardId = await ctx.db.insert("cardChecklist", { ...rest, cardNumber: "777" });
      await ctx.db.insert("cardPlayerLinks", { cardChecklistId: cardId, playerId: s.fx.goodenId, sportId: s.fx.sportId });
      return cardId;
    });
    expect((await s.me.query(api.binderRules.needs, { containerId: id })).needs.map((n) => n.card._id)).not.toContain(fresh);

    // Fits computed less than a day ago are not due; aged ones are.
    expect(await s.t.mutation(internal.binderRules.refreshStaleFits, {})).toEqual({ scheduled: 0, more: false });
    await s.t.run(async (ctx) => {
      const state = (await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", id))
        .unique())!;
      await ctx.db.patch(state._id, { computedAt: Date.now() - 25 * 60 * 60 * 1000 });
    });
    expect(await s.t.mutation(internal.binderRules.refreshStaleFits, {})).toEqual({ scheduled: 1, more: false });
    await settle(s);
    const after = await fitsOf(s, id);
    expect(after.length).toBe(before + 1);
    expect(after.map((f) => f.cardId)).toContain(fresh);
    expect((await s.me.query(api.binderRules.needs, { containerId: id })).needs.map((n) => n.card._id)).toContain(fresh);
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

/**
 * NEO-410 — a smart binder is never left waiting for its empty slots. In CI
 * one `writeFitsPage` never finished ("too many system operations"), nothing
 * retried it, and the binder stayed pending forever. These fail the write on
 * purpose and check every road out ends in stored fits or a visible "failed".
 */
describe("a recompute that fails (NEO-410)", () => {
  const TIMEOUT = "Your request timed out performing too many system operations.";
  const failWrites = async (times: number) => {
    const mod = await import("./binderRules");
    // convex-test runs a nested mutation through its `_handler`.
    const write = mod.writeFitsPage as unknown as { _handler: (...args: unknown[]) => Promise<unknown> };
    const spy = vi.spyOn(write, "_handler");
    for (let i = 0; i < times; i++) spy.mockRejectedValueOnce(new Error(TIMEOUT));
    return spy;
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const slots = (s: S, containerId: Id<"collectionContainers">) =>
    s.me.query(api.binderRules.needs, { containerId });

  test("tries again on its own and ends with every fit stored, nothing pending", async () => {
    const s = await setup();
    const reference = await smartBinder(s);
    await settle(s);
    const expected = (await fitsOf(s, reference)).map((f) => f.cardId);
    expect(expected.length).toBeGreaterThan(1);

    const spy = await failWrites(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await smartBinder(s);
    await settle(s);
    expect(spy.mock.calls.length).toBeGreaterThan(1); // it ran again after the failure
    expect((await fitsOf(s, id)).map((f) => f.cardId)).toEqual(expected);
    const state = await fitsStateOf(s, id);
    expect(state?.pending).toBeUndefined();
    expect(state?.failed).toBeUndefined();
    expect(state?.pendingSince).toBeUndefined();
    const read = await slots(s, id);
    expect(read.pending).toBe(false);
    expect(read.failed).toBeUndefined();
  });

  test("gives up visibly after its last retry, and Try again fills the slots", async () => {
    const s = await setup();
    await failWrites(5);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await smartBinder(s);
    await settle(s);
    expect(errors).toHaveBeenCalledTimes(5);
    const state = await fitsStateOf(s, id);
    expect(state?.pending).toBeUndefined();
    expect(state?.failed).toBe(true);
    const read = await slots(s, id);
    expect(read.pending).toBe(false);
    expect(read.failed).toBe(true);

    // "Try again" (the write works now): pending at once, then filled. A
    // second tap while it is pending schedules nothing more.
    const writes = await failWrites(0);
    writes.mockClear();
    await s.me.mutation(api.binderRules.retryFits, { containerId: id });
    expect((await slots(s, id)).pending).toBe(true);
    await s.me.mutation(api.binderRules.retryFits, { containerId: id });
    await settle(s);
    expect(writes).toHaveBeenCalledTimes(1); // one recompute, one page
    expect((await fitsOf(s, id)).length).toBeGreaterThan(1);
    const after = await fitsStateOf(s, id);
    // On a binder that is fine, Try again does nothing at all.
    await s.me.mutation(api.binderRules.retryFits, { containerId: id });
    expect((await fitsStateOf(s, id))?.pending).toBeUndefined();
    expect(after?.failed).toBeUndefined();
    expect(after?.pending).toBeUndefined();
    expect((await slots(s, id)).failed).toBeUndefined();
  });

  test("Try again is the owner's alone", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    await expect(s.them.mutation(api.binderRules.retryFits, { containerId: id })).rejects.toThrow();
  });

  test("a binder left pending (a recompute Convex never finished) is re-queued by the sweep", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const fresh = await smartBinder(s, {
      version: 1,
      match: "all",
      terms: [{ test: { kind: "player", playerIds: [s.fx.goodenId] } }],
    });
    await settle(s);
    // A third binder that is fine (no pendingSince at all): never swept.
    const settled = await smartBinder(s);
    await settle(s);
    // Simulate a dropped recompute: pending, long ago, rows gone; and a
    // second binder that only just went pending, which the sweep leaves be.
    const now = Date.now();
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("collectionBinderFits")
        .withIndex("by_binder_order", (q) => q.eq("binderId", id))
        .collect())
        await ctx.db.delete(row._id);
      const stuck = await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", id))
        .unique();
      await ctx.db.patch(stuck!._id, { pending: true, pendingSince: now - 21 * 60 * 1000 });
      const recent = await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", fresh))
        .unique();
      await ctx.db.patch(recent!._id, { pending: true, pendingSince: now });
    });
    expect(await s.t.mutation(internal.binderRules.requeueStuckFits, {})).toEqual({ requeued: 1 });
    await settle(s);
    expect((await fitsOf(s, id)).length).toBeGreaterThan(1);
    expect((await fitsStateOf(s, id))?.pending).toBeUndefined();
    expect((await fitsStateOf(s, fresh))?.pending).toBe(true);
    expect((await fitsStateOf(s, settled))?.pending).toBeUndefined();
  });

  test("overlapping recomputes: an older run landing late changes nothing a newer one stored", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const before = await fitsOf(s, id);
    // Run A claims a generation, then stalls; run C claims after it and finishes.
    const older = await s.t.mutation(internal.binderRules.claimFitsGeneration, { binderId: id });
    await s.t.action(internal.binderRules.recomputeFits, { binderId: id });
    const done = await fitsStateOf(s, id);
    expect(done!.generation).toBeGreaterThan(older);
    const rows = await fitsOf(s, id);
    // A wakes up: writes one page (a subset) and finishes. Nothing moves.
    await s.t.mutation(internal.binderRules.writeFitsPage, {
      binderId: id,
      ownerId: ME.subject,
      generation: older,
      startOrder: 0,
      rows: [{ cardId: rows[0].cardId, variantId: rows[0].variantId }],
    });
    await s.t.mutation(internal.binderRules.finishFits, {
      binderId: id,
      ownerId: ME.subject,
      generation: older,
      supported: true,
      complete: true,
      count: 1,
    });
    const after = await fitsOf(s, id);
    expect(after.map((f) => [f._id, f.order, f.generation])).toEqual(rows.map((f) => [f._id, f.order, f.generation]));
    expect(after.map((f) => f.cardId)).toEqual(before.map((f) => f.cardId));
    expect(await fitsStateOf(s, id)).toMatchObject({ generation: done!.generation, count: done!.count });
  });

  test("a stale chain never marks failed: not over a newer save, not over good fits", async () => {
    const s = await setup();
    const id = await smartBinder(s);
    await settle(s);
    const good = await fitsStateOf(s, id);
    // A nightly-style recompute (no pending spell) that fails every time
    // leaves the binder's good fits alone: no `failed`, no "Try again".
    await failWrites(5);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await s.t.action(internal.binderRules.recomputeFits, { binderId: id });
    await settle(s);
    expect((await fitsStateOf(s, id))?.failed).toBeUndefined();
    expect((await fitsOf(s, id)).length).toBe(good!.count);
    // An old spell's give-up after a newer save started another spell.
    await s.t.run(async (ctx) => {
      const st = await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", id))
        .unique();
      await ctx.db.patch(st!._id, { pending: true, pendingSince: 2_000 });
    });
    await s.t.mutation(internal.binderRules.markFitsFailed, { binderId: id, since: 1_000 });
    expect(await fitsStateOf(s, id)).toMatchObject({ pending: true, pendingSince: 2_000 });
    expect((await fitsStateOf(s, id))?.failed).toBeUndefined();
  });
});

describe("backfillFitsState (NEO-410)", () => {
  test("schedules only smart binders the sweep cannot see: no state row, or pending with no pendingSince", async () => {
    const s = await setup();
    const fine = await smartBinder(s);
    const noRow = await smartBinder(s);
    const unstamped = await smartBinder(s);
    await settle(s);
    await s.t.run(async (ctx) => {
      const row = (id: Id<"collectionContainers">) =>
        ctx.db
          .query("collectionBinderFitsState")
          .withIndex("by_binder", (q) => q.eq("binderId", id))
          .unique();
      await ctx.db.delete((await row(noRow))!._id);
      await ctx.db.patch((await row(unstamped))!._id, { pending: true });
    });
    // Dry run: counts, writes nothing.
    const dry = await s.t.mutation(internal.backfillFitsState.run, {});
    expect(dry).toMatchObject({ armed: false, missing: 1, unstamped: 1, isDone: true });
    expect(await fitsStateOf(s, noRow)).toBeNull();
    // Armed: both computed; the settled binder untouched.
    const fineBefore = await fitsStateOf(s, fine);
    await s.t.mutation(internal.backfillFitsState.run, { arm: true });
    await settle(s);
    expect((await fitsStateOf(s, noRow))?.pending).toBeUndefined();
    expect((await fitsOf(s, noRow)).length).toBeGreaterThan(1);
    expect((await fitsStateOf(s, unstamped))?.pending).toBeUndefined();
    expect((await fitsStateOf(s, fine))?.computedAt).toBe(fineBefore?.computedAt);
  });
});
