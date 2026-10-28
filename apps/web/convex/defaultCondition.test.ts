/**
 * NEO-380 — a raw copy always has a condition: the collector's default
 * (Profile → Settings, `userProfile.setDefaultCondition`), Excellent until
 * they pick one. Every write that sends none fills it in; a graded copy
 * stores none; quick counts count and write the default; the backfill gives
 * the copies stored before one.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_CONDITION } from "./collection";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { expectCountsExact } from "../lib/testing/collection-counts";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_380" };
const THEM = { subject: "collector_them_380" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const them = t.withIdentity(THEM);
  const sys = await me.mutation(api.collectionContainers.ensureSystem, {});
  const boxA = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  return { t, fx, me, them, sys, boxA };
}
type S = Awaited<ReturnType<typeof setup>>;

async function rowsOf(s: S, owner = ME.subject) {
  return s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === owner),
  );
}
const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown> = {}) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });
const setQty = (s: S, cardId: Id<"cardChecklist">, boxId: Id<"collectionContainers">, quantity: number) =>
  s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId, boxId, quantity });

/** A copy stored before NEO-380: raw, no condition. */
async function legacyCopy(s: S, cardId: Id<"cardChecklist">, homeId: Id<"collectionContainers">, quantity = 1) {
  const card = await s.t.run((ctx) => ctx.db.get(cardId));
  return s.t.run((ctx) =>
    ctx.db.insert("collectionCopies", {
      ownerId: ME.subject,
      cardId,
      variantId: card!.selectorOptionId,
      setId: (s.fx as unknown as { setId?: Id<"selectorOptions"> }).setId,
      homeId,
      quantity,
      lastUpdated: 1,
    }),
  );
}

describe("the setting", () => {
  test("never set reads Excellent; signed out reads null", async () => {
    const s = await setup();
    expect(DEFAULT_CONDITION).toBe("Excellent");
    expect(await s.me.query(api.userProfile.getDefaultCondition, {})).toBe("Excellent");
    expect(await s.t.query(api.userProfile.getDefaultCondition, {})).toBeNull();
  });

  test("a pick is saved per collector and keeps the theme", async () => {
    const s = await setup();
    await s.me.mutation(api.userProfile.setThemePreference, { theme: "dark" });
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Near Mint" });
    expect(await s.me.query(api.userProfile.getDefaultCondition, {})).toBe("Near Mint");
    expect(await s.me.query(api.userProfile.getThemePreference, {})).toBe("dark");
    expect(await s.them.query(api.userProfile.getDefaultCondition, {})).toBe("Excellent");
  });

  test("signed out cannot save one", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.userProfile.setDefaultCondition, { condition: "Mint" })).rejects.toThrow();
  });
});

describe("every write stores a condition on a raw copy", () => {
  test("an add with none takes the default; a named one is kept", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1);
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Very Good" });
    await add(s, s.fx.gooden1, { condition: "Mint" });
    await add(s, s.fx.gooden1, { acquiredOn: "2026-01-02" });
    const conditions = (await rowsOf(s)).map((r) => r.condition).sort();
    expect(conditions).toEqual(["Excellent", "Mint", "Very Good"]);
  });

  test("I have this one (addHave, addHaves) takes the default", async () => {
    const s = await setup();
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Good" });
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.gooden1], acquiredOn: "2026-01-02" });
    expect((await rowsOf(s)).every((r) => r.condition === "Good")).toBe(true);
  });

  test("a graded copy stores no condition", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { grading: { grader: "PSA", grade: "9" } });
    const [row] = await rowsOf(s);
    expect(row.grading).toMatchObject({ grader: "PSA", grade: "9" });
    expect(row.condition).toBeUndefined();
  });

  test("an edit that clears the condition gets the default back; an edit to graded drops it", async () => {
    const s = await setup();
    const { copyId } = await add(s, s.fx.gooden1, { condition: "Mint" });
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 1 } });
    expect((await s.t.run((ctx) => ctx.db.get(copyId)))!.condition).toBe("Excellent");
    await s.me.mutation(api.collection.updateCopy, {
      copyId,
      details: { quantity: 1, grading: { grader: "BGS", grade: "9.5" } },
    });
    expect((await s.t.run((ctx) => ctx.db.get(copyId)))!.condition).toBeUndefined();
  });

  test("a restore of a copy removed with none comes back in the default", async () => {
    const s = await setup();
    const id = await legacyCopy(s, s.fx.gooden1, s.boxA);
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: id });
    await s.me.mutation(api.collection.restoreCopy, removed);
    const [row] = await rowsOf(s);
    expect(row.condition).toBe("Excellent");
  });
});

describe("quick counts use the default", () => {
  test("a raise writes the default, and changing it starts a new plain line", async () => {
    const s = await setup();
    await setQty(s, s.fx.gooden1, s.boxA, 2);
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Near Mint" });
    // The Excellent line is no longer plain: the count of plain lines is 0 now.
    const r = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(r).toMatchObject({ before: 0, after: 1 });
    const conditions = (await rowsOf(s)).map((row) => `${row.quantity}:${row.condition}`).sort();
    expect(conditions).toEqual(["1:Near Mint", "2:Excellent"]);
    await expectCountsExact(s.t, ME.subject, expect as never);
  });

  test("a line stored with no condition still counts as plain, and lowering takes it", async () => {
    const s = await setup();
    await legacyCopy(s, s.fx.gooden1, s.boxA, 2);
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const r = await setQty(s, s.fx.gooden1, s.boxA, 0);
    expect(r).toMatchObject({ before: 2, after: 0 });
    expect(await rowsOf(s)).toHaveLength(0);
  });

  test("a line in another condition is never touched", async () => {
    const s = await setup();
    await add(s, s.fx.gooden1, { condition: "Mint", homeId: s.boxA });
    const r = await setQty(s, s.fx.gooden1, s.boxA, 1);
    expect(r).toMatchObject({ before: 0, after: 1 });
    const conditions = (await rowsOf(s)).map((row) => row.condition).sort();
    expect(conditions).toEqual(["Excellent", "Mint"]);
  });
});

describe("the backfill", () => {
  test("a dry run counts and writes nothing; armed sets each owner's default, graded and set copies untouched", async () => {
    const s = await setup();
    await s.them.mutation(api.collectionContainers.ensureSystem, {});
    await s.them.mutation(api.userProfile.setDefaultCondition, { condition: "Poor" });
    const mine = await legacyCopy(s, s.fx.gooden1, s.sys.mainId as Id<"collectionContainers">);
    const theirMain = await s.t.run(async (ctx) =>
      (await ctx.db.query("collectionContainers").collect()).find(
        (c) => c.ownerId === THEM.subject && c.system === "main",
      ),
    );
    const card = await s.t.run((ctx) => ctx.db.get(s.fx.gooden1));
    const theirs = await s.t.run((ctx) =>
      ctx.db.insert("collectionCopies", {
        ownerId: THEM.subject,
        cardId: s.fx.gooden1,
        variantId: card!.selectorOptionId,
        homeId: theirMain!._id,
        quantity: 1,
        lastUpdated: 1,
      }),
    );
    const { copyId: graded } = await add(s, s.fx.gooden1, { grading: { grader: "PSA", grade: "10" } });
    const { copyId: named } = await add(s, s.fx.gooden1, { condition: "Mint", acquiredOn: "2026-01-02" });

    const dry = await s.t.mutation(internal.backfillCopyCondition.run, {});
    expect(dry).toMatchObject({ armed: false, set: 2, isDone: true });
    expect((await s.t.run((ctx) => ctx.db.get(mine)))!.condition).toBeUndefined();

    const armed = await s.t.mutation(internal.backfillCopyCondition.run, { arm: true });
    expect(armed).toMatchObject({ armed: true, set: 2, isDone: true });
    const get = (id: Id<"collectionCopies">) => s.t.run((ctx) => ctx.db.get(id));
    expect((await get(mine))!.condition).toBe("Excellent");
    expect((await get(mine))!.lastUpdated).toBe(1);
    expect((await get(theirs))!.condition).toBe("Poor");
    expect((await get(graded))!.condition).toBeUndefined();
    expect((await get(named))!.condition).toBe("Mint");

    expect(await s.t.mutation(internal.backfillCopyCondition.run, {})).toMatchObject({ set: 0 });
  });
});
