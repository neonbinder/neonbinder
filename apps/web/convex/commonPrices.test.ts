/**
 * NEO-378 — a collector's common card price per exact variant
 * (`convex/commonPrices.ts`), and a copy's own minimum price.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

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
