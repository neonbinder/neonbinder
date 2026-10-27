/**
 * NEO-359 — the shelf (`convex/collectionContainers.ts`): system rows, create,
 * update, empty, remove, the 200 cap, and caller isolation.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { expectCountsExact, tallyTruth } from "../lib/testing/collection-counts";
import { SPINE_FONTS } from "../lib/print/spine-fonts";
import { insertTestCard } from "../lib/testing/card-row";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const FONT = SPINE_FONTS[0].id;
const LABEL = { background: "#00D558", text: "#101010", fontId: FONT };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

const mk = (s: S, kind: "binder" | "box", name: string) =>
  s.me.mutation(api.collectionContainers.create, { kind, name }).then((r) => r.containerId);
const rowOf = (s: S, id: Id<"collectionContainers">) => s.t.run(async (ctx) => ctx.db.get(id));
const copyRows = (s: S) =>
  s.t.run(async (ctx) => (await ctx.db.query("collectionCopies").collect()).filter((r) => r.ownerId === ME.subject));

describe("auth", () => {
  test("every shelf function refuses a signed-out caller", async () => {
    const { t } = await setup();
    const id = "x" as Id<"collectionContainers">;
    const calls = [
      () => t.query(api.collectionContainers.list, {}),
      () => t.mutation(api.collectionContainers.ensureSystem, {}),
      () => t.mutation(api.collectionContainers.create, { kind: "box", name: "B" }),
      () => t.mutation(api.collectionContainers.update, { containerId: id }),
      () => t.mutation(api.collectionContainers.empty, { containerId: id }),
      () => t.mutation(api.collectionContainers.remove, { containerId: id }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(/Not authenticated|Validator|Invalid/);
  });
});

describe("ensureSystem and list", () => {
  test("makes Main, the Want List, Up for Trade and Unsorted once; twice changes nothing", async () => {
    const s = await setup();
    const a = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const b = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    expect(b).toEqual(a);
    const rows = await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect());
    expect(rows.map((r) => r.system).sort()).toEqual(["main", "trade", "unsorted", "want"]);
    expect(rows.find((r) => r.system === "unsorted")).toMatchObject({ kind: "box", name: "Unsorted" });
    expect(rows.every((r) => r.count?.copies === 0 && r.count?.lines === 0)).toBe(true);
  });

  test("keeps the Main a first add made lazily, and its count", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const mainBefore = (await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect()))[0];
    const ids = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    expect(ids.mainId).toBe(mainBefore._id);
    expect((await rowOf(s, ids.mainId))!.count).toEqual({ copies: 1, lines: 1 });
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect())).toHaveLength(4);
  });

  test("Up for Trade and the Want List are counted at birth from flagged copies and wants that predate them", async () => {
    const s = await setup();
    const { copyId } = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 3 } });
    await s.me.mutation(api.collection.setTrade, { copyId, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true });
    const ids = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    expect((await rowOf(s, ids.tradeId))!.count).toEqual({ copies: 3, lines: 1 });
    expect((await rowOf(s, ids.wantId))!.count).toEqual({ copies: 1, lines: 1 });
  });

  test("list order: Main, Up for Trade, Want List, Unsorted, then their own by creation", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "Zed");
    const b = await mk(s, "box", "Alpha");
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const c = await mk(s, "binder", "Mid");
    const list = await s.me.query(api.collectionContainers.list, {});
    expect(list.slice(0, 4).map((r) => r.system)).toEqual(["main", "trade", "want", "unsorted"]);
    expect(list.slice(4).map((r) => r._id)).toEqual([a, b, c]);
    expect(list.slice(4).map((r) => r.name)).toEqual(["Zed", "Alpha", "Mid"]);
  });

  test("list carries NB fields only and a count on every row", async () => {
    const s = await setup();
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await mk(s, "binder", "A");
    const allowed = ["_id", "kind", "system", "name", "count", "lastUpdated", "description", "label", "rule",
      // NEO-360 — the owner's own link parts and switch.
      "slug", "visibility"];
    for (const row of await s.me.query(api.collectionContainers.list, {})) {
      expect(Object.keys(row).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(row.count).not.toBeNull();
    }
  });

  test("list reads only my rows", async () => {
    const s = await setup();
    await mk(s, "binder", "Mine");
    await s.them.mutation(api.collectionContainers.create, { kind: "binder", name: "Theirs" });
    expect((await s.me.query(api.collectionContainers.list, {})).map((r) => r.name)).toEqual(["Mine"]);
  });

  test("racing ensureSystem calls leave one of each", async () => {
    const s = await setup();
    await Promise.allSettled([
      s.me.mutation(api.collectionContainers.ensureSystem, {}),
      s.me.mutation(api.collectionContainers.ensureSystem, {}),
    ]);
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const rows = await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect());
    expect(rows).toHaveLength(4);
  });
});

describe("create", () => {
  test("refuses a rule (smart binders wait for NEO-362) and stores nothing", async () => {
    const s = await setup();
    await expect(
      // `create` takes no `rule` until NEO-362: the argument validator refuses it.
      s.me.mutation(api.collectionContainers.create, {
        kind: "binder", name: "Smart",
        rule: { version: 1, match: "all", terms: [{ test: { kind: "hallOfFame" } }] },
      } as never),
    ).rejects.toThrow();
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect())).toEqual([]);
  });

  test("trims the name, drops a blank description, lower-cases and stores a valid label", async () => {
    const s = await setup();
    const { containerId } = await s.me.mutation(api.collectionContainers.create, {
      kind: "box", name: "  Dime Box  ", description: "   ", label: { ...LABEL, background: " #ABCDEF " },
    });
    const row = (await rowOf(s, containerId))!;
    expect(row).toMatchObject({ name: "Dime Box", kind: "box", count: { copies: 0, lines: 0 } });
    expect(row.description).toBeUndefined();
    expect(row.label).toEqual({ background: "#abcdef", text: "#101010", fontId: FONT });
  });

  test("refuses a blank or too-long name and description", async () => {
    const s = await setup();
    await expect(s.me.mutation(api.collectionContainers.create, { kind: "box", name: "  " })).rejects.toThrow(/name/i);
    await expect(s.me.mutation(api.collectionContainers.create, { kind: "box", name: "x".repeat(61) })).rejects.toThrow(/too long/);
    await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "x".repeat(60) });
    await expect(
      s.me.mutation(api.collectionContainers.create, { kind: "box", name: "ok", description: "d".repeat(281) }),
    ).rejects.toThrow(/too long/);
  });

  test("label colours must be #rrggbb hex and the font one of the spine fonts", async () => {
    const s = await setup();
    const bad = [
      { ...LABEL, background: "red" }, { ...LABEL, background: "#12345" }, { ...LABEL, background: "#1234567" },
      { ...LABEL, text: "00d558" }, { ...LABEL, text: "#gggggg" }, { ...LABEL, fontId: "comic-sans" }, { ...LABEL, fontId: "" },
    ];
    for (const label of bad) {
      await expect(s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "L", label })).rejects.toThrow(/hex|font/);
    }
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect())).toEqual([]);
  });

  test("200 of their own, then refused; system rows do not count toward the cap; another collector is unaffected", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 199; i++) {
        await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: `b${i}`, count: { copies: 0, lines: 0 }, lastUpdated: 0 });
      }
    });
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await mk(s, "box", "the 200th");
    await expect(s.me.mutation(api.collectionContainers.create, { kind: "box", name: "201st" })).rejects.toThrow(/200 binders and boxes/);
    await s.them.mutation(api.collectionContainers.create, { kind: "box", name: "fine" });
    expect(await s.me.query(api.collectionContainers.list, {})).toHaveLength(204);
  });
});

describe("update", () => {
  test("renames, redescribes and relabels, returning the previous values", async () => {
    const s = await setup();
    const id = await mk(s, "binder", "Old");
    const r1 = await s.me.mutation(api.collectionContainers.update, {
      containerId: id, name: " New ", description: "desc", label: LABEL,
    });
    expect(r1.previous).toEqual({ name: "Old" });
    const row = (await rowOf(s, id))!;
    expect(row).toMatchObject({ name: "New", description: "desc" });
    expect(row.label).toMatchObject({ background: "#00d558" });
    const r2 = await s.me.mutation(api.collectionContainers.update, { containerId: id, description: "  ", label: null });
    expect(r2.previous).toMatchObject({ name: "New", description: "desc", label: expect.any(Object) });
    const cleared = (await rowOf(s, id))!;
    expect(cleared.description).toBeUndefined();
    expect(cleared.label).toBeUndefined();
    expect(cleared.name).toBe("New");
  });

  test("absent fields stay as they are; a bad label or blank name is refused and changes nothing", async () => {
    const s = await setup();
    const id = await mk(s, "binder", "Keep");
    await s.me.mutation(api.collectionContainers.update, { containerId: id, label: LABEL });
    await expect(s.me.mutation(api.collectionContainers.update, { containerId: id, label: { ...LABEL, text: "nope" } })).rejects.toThrow(/hex/);
    await expect(s.me.mutation(api.collectionContainers.update, { containerId: id, name: " " })).rejects.toThrow();
    const row = (await rowOf(s, id))!;
    expect(row.name).toBe("Keep");
    expect(row.label).toBeDefined();
    await s.me.mutation(api.collectionContainers.update, { containerId: id });
    expect((await rowOf(s, id))!.name).toBe("Keep");
  });

  test("system rows take a label only", async () => {
    const s = await setup();
    const ids = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    for (const containerId of [ids.mainId, ids.wantId, ids.tradeId, ids.unsortedId]) {
      const row = (await rowOf(s, containerId))!;
      await expect(s.me.mutation(api.collectionContainers.update, { containerId, name: "Renamed" })).rejects.toThrow(/keep their names/);
      await expect(s.me.mutation(api.collectionContainers.update, { containerId, description: "hello" })).rejects.toThrow(/keep their names/);
      // Echoing its own name is not a rename.
      await s.me.mutation(api.collectionContainers.update, { containerId, name: row.name, label: LABEL });
      expect((await rowOf(s, containerId))!.label).toMatchObject({ fontId: FONT });
      await s.me.mutation(api.collectionContainers.update, { containerId, label: null });
      expect((await rowOf(s, containerId))!.label).toBeUndefined();
      expect((await rowOf(s, containerId))!.name).toBe(row.name);
    }
  });
});

describe("empty and remove", () => {
  test("empty sends a box's lines to Unsorted, clears pockets and rows, folds into Unsorted twins, keeps counts, and never touches the collection tally", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const box = await mk(s, "box", "Box");
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 2, homeId: box, slot: 1 } });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 3, homeId: box, slot: 2 } });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.strawberry2, details: { quantity: 1, homeId: box, slot: 4, notes: "keep" } });
    const r = await s.me.mutation(api.collectionContainers.empty, { containerId: box });
    expect(r).toEqual({ moved: 6, remaining: 0 });
    const ids = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const rows = await copyRows(s);
    // Main's own line stays put; the box's lines now sit in Unsorted.
    expect(rows).toHaveLength(3);
    const inMain = rows.filter((x) => x.homeId === undefined || x.homeId === ids.mainId);
    expect(inMain).toHaveLength(1);
    expect(inMain[0]).toMatchObject({ cardId: s.fx.gooden1, quantity: 1 });
    const inUnsorted = rows.filter((x) => x.homeId === ids.unsortedId);
    expect(inUnsorted).toHaveLength(2);
    const g = inUnsorted.find((x) => x.cardId === s.fx.gooden1)!;
    expect(g.quantity).toBe(5);
    expect("slot" in g).toBe(false);
    const st = inUnsorted.find((x) => x.cardId === s.fx.strawberry2)!;
    expect(st).toMatchObject({ notes: "keep", quantity: 1 });
    expect("slot" in st).toBe(false);
    expect((await rowOf(s, ids.unsortedId))!.count).toEqual({ copies: 6, lines: 2 });
    expect((await rowOf(s, box))!.count).toEqual({ copies: 0, lines: 0 });
    await expectCountsExact(s.t, ME.subject, expect as never);
    const tally = await tallyTruth(s.t, ME.subject);
    expect(tally.truth).toEqual({ copies: 1, lines: 1, cards: 1 });
    expect(tally.stored).toEqual(tally.truth);
  });

  test("empty sends a binder's lines to Main's pockets, folds into Main twins, keeps counts and tally", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const binder = await mk(s, "binder", "Binder");
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 2, homeId: binder, slot: 1 } });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.strawberry2, details: { quantity: 1, homeId: binder, slot: 4, notes: "keep" } });
    const r = await s.me.mutation(api.collectionContainers.empty, { containerId: binder });
    expect(r).toEqual({ moved: 3, remaining: 0 });
    const rows = await copyRows(s);
    expect(rows).toHaveLength(2);
    // Main is a binder: the twin's pocket, then Main's first open one.
    expect(rows.find((x) => x.cardId === s.fx.gooden1)).toMatchObject({ quantity: 3, slot: 0 });
    expect(rows.find((x) => x.cardId === s.fx.strawberry2)).toMatchObject({ notes: "keep", quantity: 1, slot: 1 });
    await expectCountsExact(s.t, ME.subject, expect as never);
    const tally = await tallyTruth(s.t, ME.subject);
    expect(tally.truth).toEqual({ copies: 4, lines: 2, cards: 2 });
    expect(tally.stored).toEqual(tally.truth);
  });

  test("a Main twin with no room left is not stacked on: the card takes Main's next pocket", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 999 } });
    const binder = await mk(s, "binder", "Binder");
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: binder } });
    await s.me.mutation(api.collectionContainers.empty, { containerId: binder });
    const rows = (await copyRows(s)).sort((a, b) => (a.slot ?? -1) - (b.slot ?? -1));
    expect(rows.map((r) => [r.quantity, r.slot])).toEqual([[999, 0], [1, 1]]);
    await expectCountsExact(s.t, ME.subject, expect as never);
  });

  test("the trade flag travels: a flagged line folds only into a flagged Main twin", async () => {
    const s = await setup();
    const box = await mk(s, "box", "Box");
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1 } });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 2, homeId: box, upForTrade: true } });
    await s.me.mutation(api.collectionContainers.empty, { containerId: box });
    const rows = await copyRows(s);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.upForTrade === true)).toHaveLength(1);
    await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await expectCountsExact(s.t, ME.subject, expect as never);
  });

  test("empty chunks at 200 line items: two calls for 201, remaining counts down", async () => {
    const s = await setup();
    const box = await mk(s, "box", "Big");
    const ids = await s.t.run(async (ctx) => {
      const out: Array<Id<"cardChecklist">> = [];
      for (let i = 0; i < 201; i++) {
        out.push(
          await insertTestCard(ctx, {
            selectorOptionId: s.fx.baseId, cardNumber: `X${i}`, cardName: `X${i}`,
            playerIds: [], platformData: {}, isCustom: false, sortOrder: 100 + i, lastUpdated: 0,
          } as never),
        );
      }
      return out;
    });
    await s.me.mutation(api.collection.addHaves, { cardIds: ids.slice(0, 200), homeId: box });
    await s.me.mutation(api.collection.addHaves, { cardIds: ids.slice(200), homeId: box });
    const first = await s.me.mutation(api.collectionContainers.empty, { containerId: box });
    expect(first).toEqual({ moved: 200, remaining: 1 });
    expect((await rowOf(s, box))!.count).toEqual({ copies: 1, lines: 1 });
    await expect(s.me.mutation(api.collectionContainers.remove, { containerId: box })).rejects.toThrow(/still holds cards/);
    const second = await s.me.mutation(api.collectionContainers.empty, { containerId: box });
    expect(second).toEqual({ moved: 1, remaining: 0 });
    expect(await s.me.mutation(api.collectionContainers.empty, { containerId: box })).toEqual({ moved: 0, remaining: 0 });
    await expectCountsExact(s.t, ME.subject, expect as never);
    await s.me.mutation(api.collectionContainers.remove, { containerId: box });
  });

  test("empty and remove refuse a system row; another collector's container reads as not found", async () => {
    const s = await setup();
    const ids = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    for (const containerId of [ids.mainId, ids.wantId, ids.tradeId, ids.unsortedId]) {
      await expect(s.me.mutation(api.collectionContainers.empty, { containerId })).rejects.toThrow(/can't be emptied or deleted/);
      await expect(s.me.mutation(api.collectionContainers.remove, { containerId })).rejects.toThrow(/can't be emptied or deleted/);
    }
    const mine = await mk(s, "box", "Mine");
    await expect(s.them.mutation(api.collectionContainers.empty, { containerId: mine })).rejects.toThrow(/isn't in your collection/);
    await expect(s.them.mutation(api.collectionContainers.remove, { containerId: mine })).rejects.toThrow(/isn't in your collection/);
    await expect(s.them.mutation(api.collectionContainers.update, { containerId: mine, name: "Hijack" })).rejects.toThrow(/isn't in your collection/);
    expect((await rowOf(s, mine))!.name).toBe("Mine");
  });

  test("remove deletes an empty one and un-scopes only its wants", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "A");
    const b = await mk(s, "binder", "B");
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, binderId: a, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gold1, binderId: b, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.futureStar, on: true });
    expect(await s.me.mutation(api.collectionContainers.remove, { containerId: a })).toEqual({ unscopedWants: 2 });
    expect(await rowOf(s, a)).toBeNull();
    const wants = await s.me.query(api.collectionWants.list, {});
    expect(wants).toHaveLength(4);
    expect(wants.filter((w) => w.binderId === b)).toHaveLength(1);
    expect(wants.filter((w) => w.binderId === undefined)).toHaveLength(3);
  });

  test("remove refuses a container that still holds a card, and deletes nothing", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "A");
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: a });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true });
    await expect(s.me.mutation(api.collectionContainers.remove, { containerId: a })).rejects.toThrow(/still holds cards/);
    expect(await rowOf(s, a)).not.toBeNull();
    expect((await s.me.query(api.collectionWants.list, {}))[0].binderId).toBe(a);
  });
});
