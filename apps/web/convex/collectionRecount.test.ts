/**
 * NEO-364 — the collection-only tally's migration (`collection:recountCollectionTallies`)
 * and the marker it rests on.
 *
 * A tally or building-set `cards` without `tallyScope: "collection"` counted
 * boxes too (NEO-359). It reads as absent: a read counts by hand, the next
 * write recounts it collection-only and stamps it. The armed internal action
 * only spares those hand counts, and writes only when `confirm` is "RECOUNT"
 * AND the deployment is armed (`ALLOW_COLLECTION_BACKFILL`).
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { buildingTruth, tallyTruth } from "../lib/testing/collection-counts";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const FLAG = "ALLOW_COLLECTION_BACKFILL";
const BOXY = "collector_with_a_box";
const PLAIN = "collector_binders_only";
const DONE = "collector_already_scoped";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Three collectors as NEO-359 left them (tally and set-build `cards`
 * unmarked), plus one already migrated:
 *   BOXY  a box and an unmarked tally that counts it     (-> cleared)
 *   PLAIN binders only, an unmarked tally                (-> stamped as is)
 *   DONE  already stamped                                (-> untouched)
 */
async function seed() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const ids = await t.run(async (ctx) => {
    const main = (ownerId: string, extra: Record<string, unknown>) =>
      ctx.db.insert("collectionContainers", {
        ownerId, kind: "binder", system: "main", name: "Main", lastUpdated: 1, ...extra,
      } as never);
    const build = (ownerId: string, extra: Record<string, unknown>) =>
      ctx.db.insert("collectionBuildingSets", { ownerId, setId: fx.setId, lastUpdated: 1, ...extra } as never);
    const copy = (ownerId: string, cardId: Id<"cardChecklist">, homeId: Id<"collectionContainers">, quantity = 1) =>
      ctx.db.insert("collectionCopies", {
        ownerId, cardId, variantId: fx.baseId, setId: fx.setId, homeId, quantity, lastUpdated: 1,
      });

    const boxyMain = await main(BOXY, { tally: { copies: 6, lines: 2, cards: 2 } });
    const boxyBox = await ctx.db.insert("collectionContainers", {
      ownerId: BOXY, kind: "box", name: "Box", count: { copies: 5, lines: 1 }, lastUpdated: 1,
    });
    await copy(BOXY, fx.gooden1, boxyMain);
    await copy(BOXY, fx.strawberry2, boxyBox, 5);
    const boxyBuild = await build(BOXY, { cards: 2 });

    const plainMain = await main(PLAIN, { tally: { copies: 3, lines: 1, cards: 1 } });
    await copy(PLAIN, fx.gooden1, plainMain, 3);
    const plainBuild = await build(PLAIN, { cards: 1 });

    const doneMain = await main(DONE, { tally: { copies: 1, lines: 1, cards: 1 }, tallyScope: "collection" });
    await copy(DONE, fx.gooden1, doneMain, 1);
    const doneBuild = await build(DONE, { cards: 1, tallyScope: "collection" });
    return { boxyMain, boxyBuild, plainMain, plainBuild, doneMain, doneBuild, boxyBox };
  });
  return { t, fx, ids };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const snapshot = (t: Seeded["t"]) =>
  t.run(async (ctx) => ({
    containers: await ctx.db.query("collectionContainers").collect(),
    builds: await ctx.db.query("collectionBuildingSets").collect(),
    copies: await ctx.db.query("collectionCopies").collect(),
  }));
const run = (t: Seeded["t"], args: { confirm?: string } = {}) =>
  t.action(internal.collection.recountCollectionTallies, args);

describe("the dry run (the default)", () => {
  test("reports what an armed run would do and writes nothing", async () => {
    const { t } = await seed();
    const before = await snapshot(t);
    const r = await run(t);
    expect(r).toMatchObject({
      mode: "dry-run",
      mains: 3,
      alreadyScoped: 1,
      stamped: 1,
      cleared: 1,
      buildingStamped: 1,
      buildingCleared: 1,
    });
    expect(await snapshot(t)).toEqual(before);
  });

  test("stays a dry run when the deployment is armed but no confirm was given", async () => {
    vi.stubEnv(FLAG, "1");
    const { t } = await seed();
    const before = await snapshot(t);
    expect((await run(t)).mode).toBe("dry-run");
    expect(await snapshot(t)).toEqual(before);
  });

  test("a wrong confirm word is a dry run with a message, even when armed", async () => {
    vi.stubEnv(FLAG, "1");
    const { t } = await seed();
    const before = await snapshot(t);
    const r = await run(t, { confirm: "yes please" });
    expect(r.mode).toBe("dry-run");
    expect(r.message).toMatch(/RECOUNT/);
    expect(await snapshot(t)).toEqual(before);
  });
});

describe("armed", () => {
  test("a confirm on an unarmed deployment is refused and writes nothing", async () => {
    const { t } = await seed();
    const before = await snapshot(t);
    const r = await run(t, { confirm: "RECOUNT" });
    expect(r.mode).toBe("refused");
    expect(r.message).toContain(FLAG);
    expect(r).toMatchObject({ stamped: 1, cleared: 1 }); // the report is still what it would do
    expect(await snapshot(t)).toEqual(before);
  });

  test("the page itself refuses write:true on an unarmed deployment and writes nothing", async () => {
    const { t } = await seed();
    const before = await snapshot(t);
    await expect(
      t.mutation(internal.collection.recountCollectionTalliesPage, { cursor: null, write: true }),
    ).rejects.toThrow(new RegExp(FLAG));
    expect(await snapshot(t)).toEqual(before);
  });

  test("the page itself refuses write:true when the flag is not 1 or true", async () => {
    vi.stubEnv(FLAG, "yes");
    const { t } = await seed();
    const before = await snapshot(t);
    await expect(
      t.mutation(internal.collection.recountCollectionTalliesPage, { cursor: null, write: true }),
    ).rejects.toThrow(new RegExp(FLAG));
    expect(await snapshot(t)).toEqual(before);
  });

  test("the page runs write:false (a dry-run page) on an unarmed deployment", async () => {
    const { t } = await seed();
    const before = await snapshot(t);
    const page = await t.mutation(internal.collection.recountCollectionTalliesPage, { cursor: null, write: false });
    expect(page).toMatchObject({ mains: 3, stamped: 1, cleared: 1 });
    expect(await snapshot(t)).toEqual(before);
  });

  test("a flag that is not 1 or true does not arm it", async () => {
    vi.stubEnv(FLAG, "yes");
    const { t } = await seed();
    const before = await snapshot(t);
    expect((await run(t, { confirm: "RECOUNT" })).mode).toBe("refused");
    expect(await snapshot(t)).toEqual(before);
  });

  test("armed and confirmed: clears the owner with a box, stamps the others, leaves the migrated one", async () => {
    vi.stubEnv(FLAG, "1");
    const { t, ids } = await seed();
    const r = await run(t, { confirm: "RECOUNT" });
    expect(r).toMatchObject({ mode: "armed", mains: 3, alreadyScoped: 1, stamped: 1, cleared: 1, buildingStamped: 1, buildingCleared: 1 });
    const get = (id: Id<"collectionContainers"> | Id<"collectionBuildingSets">) =>
      t.run(async (ctx) => ctx.db.get(id as never)) as Promise<Record<string, unknown>>;
    const boxyMain = await get(ids.boxyMain);
    expect(boxyMain.tally).toBeUndefined();
    expect(boxyMain.tallyScope).toBeUndefined();
    const boxyBuild = await get(ids.boxyBuild);
    expect(boxyBuild.cards).toBeUndefined();
    expect(boxyBuild.tallyScope).toBeUndefined();
    expect(await get(ids.plainMain)).toMatchObject({ tally: { copies: 3, lines: 1, cards: 1 }, tallyScope: "collection" });
    expect(await get(ids.plainBuild)).toMatchObject({ cards: 1, tallyScope: "collection" });
    expect(await get(ids.doneMain)).toMatchObject({ tally: { copies: 1, lines: 1, cards: 1 }, tallyScope: "collection" });
    expect(await get(ids.doneBuild)).toMatchObject({ cards: 1, tallyScope: "collection" });
  });

  test("never touches a copy, a box, or its count", async () => {
    vi.stubEnv(FLAG, "true");
    const { t } = await seed();
    const before = await snapshot(t);
    await run(t, { confirm: "RECOUNT" });
    const after = await snapshot(t);
    expect(after.copies).toEqual(before.copies);
    expect(after.containers.filter((c) => c.kind === "box")).toEqual(before.containers.filter((c) => c.kind === "box"));
  });

  test("a second run finds nothing to do and writes nothing", async () => {
    vi.stubEnv(FLAG, "1");
    const { t } = await seed();
    await run(t, { confirm: "RECOUNT" });
    const settled = await snapshot(t);
    const again = await run(t, { confirm: "RECOUNT" });
    expect(again).toMatchObject({ mode: "armed", mains: 3, alreadyScoped: 3, stamped: 0, cleared: 0, buildingStamped: 0, buildingCleared: 0 });
    expect(await snapshot(t)).toEqual(settled);
  });

  test("walks every page: more owners than one page holds", async () => {
    vi.stubEnv(FLAG, "1");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 45; i++) {
        await ctx.db.insert("collectionContainers", {
          ownerId: `owner_${i}`, kind: "binder", system: "main", name: "Main",
          tally: { copies: 1, lines: 1, cards: 1 }, lastUpdated: 1,
        });
      }
    });
    const r = await run(t, { confirm: "RECOUNT" });
    expect(r).toMatchObject({ mode: "armed", mains: 45, stamped: 45, cleared: 0 });
    expect(r.pages).toBeGreaterThan(1);
    const mains = await t.run(async (ctx) => ctx.db.query("collectionContainers").collect());
    expect(mains.every((m) => m.tallyScope === "collection")).toBe(true);
  });
});

describe("an unmarked tally", () => {
  test("a read ignores it and counts the binder lines by hand", async () => {
    const { t } = await seed();
    const boxy = t.withIdentity({ subject: BOXY });
    // The stored 6 copies / 2 cards counted the box; the collection holds 1.
    expect(await boxy.query(api.collection.summary, {})).toMatchObject({
      copies: 1, lines: 1, distinctCards: 1, exact: true,
    });
  });

  test("the next write recounts it collection-only and stamps it", async () => {
    const { t, fx, ids } = await seed();
    const boxy = t.withIdentity({ subject: BOXY });
    await boxy.mutation(api.collection.addHave, { cardId: fx.gold1 });
    const main = await t.run(async (ctx) => ctx.db.get(ids.boxyMain));
    expect(main!.tallyScope).toBe("collection");
    const { stored, truth } = await tallyTruth(t, BOXY);
    expect(truth).toEqual({ copies: 2, lines: 2, cards: 2 });
    expect(stored).toEqual(truth);
  });

  test("the next write recounts an unmarked set-build count too", async () => {
    const { t, fx, ids } = await seed();
    const boxy = t.withIdentity({ subject: BOXY });
    // The stored 2 counted the box card. Adding a binder card of the build moves it.
    await boxy.mutation(api.collection.addHave, { cardId: fx.gold1 });
    const [build] = await buildingTruth(t, BOXY);
    expect(build).toMatchObject({ kept: 2, truth: 2, scope: "collection" });
    const row = await t.run(async (ctx) => ctx.db.get(ids.boxyBuild));
    expect(row!.cards).toBe(2);
  });

  test("a box-only write leaves an unmarked tally unmarked (nothing to move), and it still reads right", async () => {
    const { t, fx, ids } = await seed();
    const boxy = t.withIdentity({ subject: BOXY });
    await boxy.mutation(api.collectionInventory.setBoxQuantity, { cardId: fx.gooden1, boxId: ids.boxyBox, quantity: 2 });
    const main = await t.run(async (ctx) => ctx.db.get(ids.boxyMain));
    expect(main!.tallyScope).toBeUndefined();
    expect(await boxy.query(api.collection.summary, {})).toMatchObject({ copies: 1, lines: 1, distinctCards: 1, exact: true });
  });
});
