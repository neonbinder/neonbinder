/**
 * NEO-378 — a collector's common card price per exact variant
 * (`convex/commonPrices.ts`), and a copy's own minimum price.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";

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

describe("common prices", () => {
  test("refuse a signed-out caller and write nothing", async () => {
    const { t, fx } = await setup();
    await expect(t.query(api.commonPrices.forVariants, { variantIds: [fx.baseId] })).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      t.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 25 }),
    ).rejects.toThrow(/Not authenticated/);
    expect(await t.run(async (ctx) => ctx.db.query("variantCommonPrices").collect())).toEqual([]);
  });

  test("set, read, change and clear one variant's price, each returning the one it replaced", async () => {
    const { fx, me } = await setup();
    expect(await me.query(api.commonPrices.forVariants, { variantIds: [fx.baseId, fx.goldId] })).toEqual([]);

    expect(await me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 25 })).toEqual({
      previous: null,
    });
    expect(await me.mutation(api.commonPrices.set, { variantId: fx.goldId, priceCents: 150 })).toEqual({
      previous: null,
    });
    expect(await me.query(api.commonPrices.forVariants, { variantIds: [fx.baseId, fx.goldId] })).toEqual([
      { variantId: fx.baseId, priceCents: 25 },
      { variantId: fx.goldId, priceCents: 150 },
    ]);

    expect(await me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 18 })).toEqual({
      previous: 25,
    });
    expect(await me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: null })).toEqual({
      previous: 18,
    });
    expect(await me.query(api.commonPrices.forVariants, { variantIds: [fx.baseId, fx.goldId] })).toEqual([
      { variantId: fx.goldId, priceCents: 150 },
    ]);
  });

  test("are the caller's own: another collector neither sees nor changes them", async () => {
    const { fx, me, them } = await setup();
    await me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 25 });
    expect(await them.query(api.commonPrices.forVariants, { variantIds: [fx.baseId] })).toEqual([]);
    await them.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 99 });
    expect(await me.query(api.commonPrices.forVariants, { variantIds: [fx.baseId] })).toEqual([
      { variantId: fx.baseId, priceCents: 25 },
    ]);
  });

  test("refuse a price that is not whole cents, and a row that is not a variant", async () => {
    const { fx, me } = await setup();
    await expect(me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: -1 })).rejects.toThrow(
      /Common price/,
    );
    await expect(me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 2.5 })).rejects.toThrow(
      /Common price/,
    );
    await expect(me.mutation(api.commonPrices.set, { variantId: fx.setId, priceCents: 25 })).rejects.toThrow(
      /isn't in the catalog/,
    );
    await expect(me.mutation(api.commonPrices.set, { variantId: "nope", priceCents: 25 })).rejects.toThrow(
      /isn't in the catalog/,
    );
  });

  test("a read skips what is not an id instead of failing", async () => {
    const { fx, me } = await setup();
    await me.mutation(api.commonPrices.set, { variantId: fx.baseId, priceCents: 25 });
    expect(await me.query(api.commonPrices.forVariants, { variantIds: ["nope", fx.baseId, fx.baseId] })).toEqual([
      { variantId: fx.baseId, priceCents: 25 },
    ]);
  });
});

describe("a copy's own minimum price", () => {
  test("is stored, read back, edited and cleared with the copy's other details", async () => {
    const { fx, me } = await setup();
    const { containerId: box } = await me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" });
    const { copyId } = await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 3, homeId: box, minPriceCents: 50 },
    });
    expect(await me.query(api.collection.copiesOf, { cardId: fx.gooden1 })).toEqual([
      expect.objectContaining({ _id: copyId, quantity: 3, minPriceCents: 50 }),
    ]);
    const { previous } = await me.mutation(api.collection.updateCopy, {
      copyId,
      details: { quantity: 3, minPriceCents: 75 },
    });
    expect(previous.minPriceCents).toBe(50);
    await me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 3 } });
    const [copy] = await me.query(api.collection.copiesOf, { cardId: fx.gooden1 });
    expect(copy).not.toHaveProperty("minPriceCents");
  });

  test("is part of the line: a quick count never touches a line with its own floor", async () => {
    const { t, fx, me } = await setup();
    const { containerId: box } = await me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" });
    await me.mutation(api.collection.addLineItem, {
      cardId: fx.gooden1,
      details: { quantity: 2, homeId: box, minPriceCents: 50 },
    });
    await me.mutation(api.collectionInventory.setBoxQuantity, { cardId: fx.gooden1, boxId: box, quantity: 1 });
    const rows = await t.run(async (ctx) => ctx.db.query("collectionCopies").collect());
    expect(rows.map((r) => [r.quantity, r.minPriceCents]).sort()).toEqual([
      [1, undefined],
      [2, 50],
    ]);
  });
});

/**
 * NEO-415 — a change to the common price wakes the owner's listings of the
 * variant (`listingOutbox.wakeVariantEverywhere`): one outbox row, for the
 * variant's first card that carries the platform's id, on each platform the
 * owner pushes counts to.
 */
describe("a common price change wakes the owner's listings of the variant", () => {
  let held: Awaited<ReturnType<typeof setup>> | null = null;
  afterEach(async () => {
    if (!held) {
      vi.useRealTimers();
      return;
    }
    // Cancel first: a held drain never fires, so draining would wait on it.
    await cancelScheduled(held.t as never);
    vi.useRealTimers();
    await drainScheduled(held.t);
    held = null;
  });

  async function wakeSetup() {
    // Hold the scheduler's timer so a kicked drain stays pending and never runs.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const s = await setup();
    held = s;
    const box = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" })).containerId;
    return { ...s, box };
  }
  type W = Awaited<ReturnType<typeof wakeSetup>>;

  const listOnBsc = (w: W, owner = ME.subject) =>
    w.t.run((ctx) =>
      ctx.db.insert("marketplaceListingStates", {
        ownerId: owner,
        platform: "bsc",
        listingStartedAt: 1,
        lastUpdated: 0,
      }),
    );
  const outboxCards = async (w: W) =>
    (await w.t.run((ctx) => ctx.db.query("listingOutbox").collect())).map((r) => r.cardId).sort();
  const setPrice = (w: W, variantId: string, priceCents: number | null) =>
    w.me.mutation(api.commonPrices.set, { variantId, priceCents });
  const count = (w: W, cardId: W["fx"]["gooden1"], boxId: W["box"]) =>
    w.me.mutation(api.collectionInventory.setBoxQuantity, { cardId, boxId, quantity: 1 });

  test("an owner who lists nowhere: setting a price writes no outbox row", async () => {
    const w = await wakeSetup();
    await setPrice(w, w.fx.baseId, 25);
    expect(await outboxCards(w)).toEqual([]);
  });

  test("an owner listing on BSC: setting a price writes one row, for the variant's first card that carries a BSC ref", async () => {
    const w = await wakeSetup();
    // The variant's first-created card has no BSC id; the next one does.
    await w.t.run((ctx) => ctx.db.patch(w.fx.gooden1, { platformData: {} }));
    await listOnBsc(w);
    await setPrice(w, w.fx.baseId, 25);
    const rows = await w.t.run((ctx) => ctx.db.query("listingOutbox").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: ME.subject,
      platform: "bsc",
      cardId: w.fx.strawberry2,
      variantId: w.fx.baseId,
    });
  });

  test("a variant none of whose cards carries a BSC ref: setting a price writes no row", async () => {
    const w = await wakeSetup();
    await w.t.run(async (ctx) => {
      for (const id of [w.fx.gooden1, w.fx.strawberry2, w.fx.gooden1Sliding]) {
        await ctx.db.patch(id, { platformData: {} });
      }
    });
    await listOnBsc(w);
    await setPrice(w, w.fx.baseId, 25);
    expect(await outboxCards(w)).toEqual([]);
  });

  test("another owner's listing is not woken by my price", async () => {
    const w = await wakeSetup();
    await listOnBsc(w, THEM.subject);
    await setPrice(w, w.fx.baseId, 25);
    expect(await outboxCards(w)).toEqual([]);
  });

  test("listing on, then the price, then two copy writes to other cards: the wake and both writes are three rows", async () => {
    const w = await wakeSetup();
    await listOnBsc(w);
    await setPrice(w, w.fx.baseId, 25);
    expect(await outboxCards(w)).toEqual([w.fx.gooden1]);
    await count(w, w.fx.strawberry2, w.box);
    await count(w, w.fx.gooden1Sliding, w.box);
    expect(await outboxCards(w)).toEqual([w.fx.gooden1, w.fx.strawberry2, w.fx.gooden1Sliding].sort());
  });

  test("price first, then listing starts (box empty at the walk), then the same two writes: two rows, no wake row", async () => {
    const w = await wakeSetup();
    await setPrice(w, w.fx.baseId, 25);
    expect(await outboxCards(w)).toEqual([]);
    // Listing starts the way a saved sign-in starts it: the state row, then the walk.
    await listOnBsc(w);
    await w.t.mutation(internal.listingSync.startListingWalk, { ownerId: ME.subject, platform: "bsc", startedAt: 1 });
    expect(await outboxCards(w)).toEqual([]);
    await count(w, w.fx.strawberry2, w.box);
    await count(w, w.fx.gooden1Sliding, w.box);
    expect(await outboxCards(w)).toEqual([w.fx.strawberry2, w.fx.gooden1Sliding].sort());
  });

  test("changing the price wakes once more (the same row, bumped), and clearing it wakes too", async () => {
    const w = await wakeSetup();
    await listOnBsc(w);
    await setPrice(w, w.fx.baseId, 25);
    const seqOf = async () => (await w.t.run((ctx) => ctx.db.query("listingOutbox").collect())).map((r) => r.seq);
    const [first] = await seqOf();
    await setPrice(w, w.fx.baseId, 30);
    expect(await outboxCards(w)).toEqual([w.fx.gooden1]);
    const [second] = await seqOf();
    expect(second).toBeGreaterThan(first);
    await setPrice(w, w.fx.baseId, null);
    expect(await outboxCards(w)).toEqual([w.fx.gooden1]);
    const [third] = await seqOf();
    expect(third).toBeGreaterThan(second);
  });

  test("setting the same price again, and clearing a price that was never set, wake nothing", async () => {
    const w = await wakeSetup();
    await setPrice(w, w.fx.baseId, 25);
    await listOnBsc(w);
    await setPrice(w, w.fx.baseId, 25);
    await setPrice(w, w.fx.goldId, null);
    expect(await outboxCards(w)).toEqual([]);
  });
});
