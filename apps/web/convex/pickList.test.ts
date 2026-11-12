/**
 * NEO-500 — the Pick List's functions (`convex/pickList.ts`): a starter set
 * written with the functions. What is on the list, the legacy-sale fallback
 * (decision 7), the pulled mark and its refusals, the owner check on photos
 * and the sport code on cards.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { buildListingSku } from "./lib/listingSku";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** See `listingSales.test.ts`: convex-test ids carry no Convex checksum. */
vi.mock("./lib/listingSku", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/listingSku")>();
  const byCode = new Map(Object.entries(actual.BSC_CONDITION_SKU_CODE).map(([c, code]) => [code, c]));
  return {
    ...actual,
    buildListingSku: (p: { cardId: string; bscCondition: keyof typeof actual.BSC_CONDITION_SKU_CODE; boxId: string }) =>
      `NB1-${p.cardId}-${actual.BSC_CONDITION_SKU_CODE[p.bscCondition]}-${p.boxId}`,
    parseListingSku: (sku: string | null | undefined) => {
      const m = typeof sku === "string" ? /^NB1-([0-9A-Za-z]+)-([A-Z]{2,5})-([0-9A-Za-z]+)$/.exec(sku) : null;
      const bscCondition = m ? byCode.get(m[2]) : undefined;
      return m && bscCondition ? { cardId: m[1], bscCondition, boxId: m[3] } : null;
    },
  };
});

const ME = { subject: "pick-me" };
const THEM = { subject: "pick-them" };

type SaleItem = Doc<"marketplaceSales">["items"][number];

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(fx.sportId, { sportConfig: { skuCode: "BB" } });
    const box = await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Box 2", lastUpdated: 0 });
    const theirBox = await ctx.db.insert("collectionContainers", { ownerId: THEM.subject, kind: "box", name: "Theirs", lastUpdated: 0 });
    const copy = await ctx.db.insert("collectionCopies", {
      ownerId: ME.subject, cardId: fx.gooden1, variantId: fx.baseId, setId: fx.setId, homeId: box,
      slot: 2, quantity: 1, condition: "Near Mint", hasPhotos: true, lastUpdated: 0,
    });
    const theirCopy = await ctx.db.insert("collectionCopies", {
      ownerId: THEM.subject, cardId: fx.gooden1, variantId: fx.baseId, setId: fx.setId, homeId: theirBox,
      quantity: 1, condition: "Near Mint", hasPhotos: true, lastUpdated: 0,
    });
    const photo = (ownerId: string, copyId: Id<"collectionCopies">, token: string) =>
      ctx.db.insert("collectionCopyPhotos", {
        ownerId, copyId, side: "front", token, contentType: "image/jpeg", imageBytes: 1, thumbBytes: 1, status: "live", since: 0,
      });
    await photo(ME.subject, copy, "a".repeat(32));
    await photo(THEM.subject, theirCopy, "b".repeat(32));
    return { box, theirBox, copy, theirCopy };
  });

  const sale = (
    ownerId: string,
    orderNo: string,
    orderDate: number,
    items: SaleItem[],
    extra: Partial<Doc<"marketplaceSales">> = {},
  ) =>
    t.run(async (ctx) =>
      ctx.db.insert("marketplaceSales", {
        ownerId, platform: "bsc", orderId: `id-${orderNo}`, orderNo, orderDate, status: "READY_TO_SHIP",
        totals: {}, items, firstSeenAt: orderDate, lastUpdated: orderDate, ...extra,
      }),
    );
  const applied = (over: Partial<SaleItem> = {}): SaleItem => ({
    platformCardId: "bsc-1", cardId: fx.gooden1, condition: "near_mint", quantity: 1, priceCents: 100,
    applied: true, appliedAt: 1, ...over,
  });
  return { t, fx, ids, sale, applied, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}

describe("open", () => {
  test("an open order's lines, the box they name, and a shipped or another owner's order left off", async () => {
    const { ids, sale, applied, me } = await setup();
    await sale(ME.subject, "A-1", 1000, [
      applied({ from: [{ homeId: ids.box, copyId: ids.copy, quantity: 1, slot: 2, condition: "Near Mint" }], lastOnes: true }),
      { platformCardId: "bsc-x", condition: "near_mint", quantity: 1, priceCents: 5, applied: false, problem: "unmatched" },
    ], { pullOpen: true });
    await sale(ME.subject, "A-2", 2000, [applied()], { status: "SHIPPED" });
    await sale(THEM.subject, "B-1", 3000, [applied()], { pullOpen: true });

    const open = await me.query(api.pickList.open, {});
    expect(open.truncated).toBe(false);
    expect(open.lines.map((l) => [l.orderNo, l.cantFind ?? null, l.lastOnes ?? null])).toEqual([
      ["A-1", null, true],
      ["A-1", "unmatched", null],
    ]);
    expect(open.lines[0].from).toEqual([{ copyId: ids.copy, boxId: ids.box, slot: 2, quantity: 1, condition: "Near Mint" }]);
    expect(open.boxes).toEqual([{ id: ids.box, name: "Box 2" }]);
    // No marketplace card id or SKU leaves.
    expect(JSON.stringify(open)).not.toContain("bsc-1");
    expect(JSON.stringify(open)).not.toContain("bsc-x");
  });

  test("a sale applied before NEO-500 (no pullOpen, no from) shows as Box not recorded, with the SKU's box", async () => {
    const { fx, ids, sale, applied, me } = await setup();
    const sku = buildListingSku({ cardId: fx.gooden1, bscCondition: "near_mint", boxId: ids.box });
    await sale(ME.subject, "L-1", 1000, [applied({ sellerSku: sku })]);
    const open = await me.query(api.pickList.open, {});
    expect(open.lines).toHaveLength(1);
    expect(open.lines[0]).toMatchObject({ orderNo: "L-1", boxUnrecorded: true, skuBoxId: ids.box, from: [] });
    expect(JSON.stringify(open)).not.toContain("NB1-");
  });

  test("past the open-order read the list is cut short and keeps the oldest orders", async () => {
    const { t, applied, me } = await setup();
    await t.run(async (ctx) => {
      // The newest 100 sales have shipped, so the temporary date window adds nothing.
      for (let i = 0; i < 100; i += 1) {
        await ctx.db.insert("marketplaceSales", {
          ownerId: ME.subject, platform: "bsc", orderId: `s-${i}`, orderNo: `S-${i}`, orderDate: 10_000 + i,
          status: "SHIPPED", totals: {}, items: [applied()], firstSeenAt: 0, lastUpdated: 0,
        });
      }
      // 201 open orders, oldest O-1.
      for (let i = 1; i <= 201; i += 1) {
        await ctx.db.insert("marketplaceSales", {
          ownerId: ME.subject, platform: "bsc", orderId: `o-${i}`, orderNo: `O-${i}`, orderDate: i,
          status: "READY_TO_SHIP", totals: {}, items: [applied()], pullOpen: true, firstSeenAt: 0, lastUpdated: 0,
        });
      }
    });
    const open = await me.query(api.pickList.open, {});
    expect(open.truncated).toBe(true);
    const orders = open.lines.map((l) => l.orderNo);
    expect(orders).toHaveLength(200);
    expect(orders[0]).toBe("O-1");
    expect(orders).toContain("O-200");
    expect(orders).not.toContain("O-201");
  });

  test("anonymous is refused", async () => {
    const { t } = await setup();
    await expect(t.query(api.pickList.open, {})).rejects.toThrow(/Not authenticated/);
  });
});

describe("setPulled", () => {
  test("marks a line pulled (off the list, pullOpen cleared) and Undo puts it back", async () => {
    const { t, sale, applied, me } = await setup();
    const saleId = await sale(ME.subject, "A-1", 1000, [applied()], { pullOpen: true });
    const [line] = (await me.query(api.pickList.open, {})).lines;

    expect(await me.mutation(api.pickList.setPulled, { ids: [line.id], pulled: true })).toEqual({ updated: 1 });
    expect((await me.query(api.pickList.open, {})).lines).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(saleId)))?.pullOpen).toBeUndefined();

    expect(await me.mutation(api.pickList.setPulled, { ids: [line.id], pulled: false })).toEqual({ updated: 1 });
    expect((await me.query(api.pickList.open, {})).lines.map((l) => l.id)).toEqual([line.id]);
    expect((await t.run((ctx) => ctx.db.get(saleId)))?.pullOpen).toBe(true);
  });

  test("another owner's line is refused and nothing is written", async () => {
    const { t, sale, applied, me, them } = await setup();
    const saleId = await sale(THEM.subject, "B-1", 1000, [applied()], { pullOpen: true });
    const [line] = (await them.query(api.pickList.open, {})).lines;
    await expect(me.mutation(api.pickList.setPulled, { ids: [line.id], pulled: true })).rejects.toThrow(/Pick List/);
    await expect(me.mutation(api.pickList.setPulled, { ids: ["not-a-line"], pulled: true })).rejects.toThrow(/Pick List/);
    expect((await t.run((ctx) => ctx.db.get(saleId)))?.items[0].pulledAt).toBeUndefined();
  });
});

describe("soldPhotos and cards", () => {
  test("photos of the caller's copies only, even once the copy row is gone", async () => {
    const { t, ids, me } = await setup();
    await t.run((ctx) => ctx.db.delete(ids.copy));
    const photos = await me.query(api.pickList.soldPhotos, { copyIds: [ids.copy, ids.theirCopy] });
    expect(photos.map((p) => p.copyId)).toEqual([ids.copy]);
    expect(photos[0].front?.thumbUrl).toMatch(/\/copy-photo\/a{32}\/thumb$/);
  });

  test("cards carry the sport's own code; a bad id is null", async () => {
    const { fx, me } = await setup();
    const out = await me.query(api.pickList.cards, { cardIds: [fx.gooden1, "nope"] });
    expect(out[0]?.sportCode).toBe("BB");
    expect(out[0]?.card.cardNumber).toBe("1");
    expect(out[1]).toBeNull();
  });
});

describe("NEO-509: a Can't find it line's own words", () => {
  test("open carries the sale's listed card on an unmatched line only, as stored", async () => {
    const { fx, sale, applied, me } = await setup();
    const listed = { sport: "Baseball", sportId: fx.sportId, year: "2024", setName: "Topps", players: "Dwight Gooden", cardNo: "1", variant: "Base" };
    await sale(ME.subject, "W-1", 1000, [
      applied(),
      { platformCardId: "bsc-y", condition: "near_mint", quantity: 1, priceCents: 5, applied: false, problem: "unmatched", listed },
      { platformCardId: "bsc-z", condition: "near_mint", quantity: 1, priceCents: 5, applied: false, problem: "unmatched" },
    ], { pullOpen: true });
    const open = await me.query(api.pickList.open, {});
    expect(open.lines.map((l) => l.listed ?? null)).toEqual([null, listed, null]);
  });

  test("a linkMismatch line carries its listed card too, and an unmatched line with none carries none", async () => {
    const { fx, sale, me } = await setup();
    const listed = { sport: "Baseball", sportId: fx.sportId, year: "2024", setName: "Topps", cardNo: "1", variant: "Base" };
    await sale(ME.subject, "W-2", 1000, [
      { platformCardId: "bsc-m", condition: "near_mint", quantity: 1, priceCents: 5, applied: false, problem: "linkMismatch", listed },
      { platformCardId: "bsc-n", condition: "near_mint", quantity: 1, priceCents: 5, applied: false, problem: "linkMismatch" },
    ], { pullOpen: true });
    const open = await me.query(api.pickList.open, {});
    expect(open.lines.map((l) => [l.cantFind, l.listed ?? null])).toEqual([
      ["linkMismatch", listed],
      ["linkMismatch", null],
    ]);
  });

  test("sports names NB's sport and its code; a bad id or a row that is no sport is null", async () => {
    const { fx, me } = await setup();
    const out = await me.query(api.pickList.sports, { sportIds: [fx.sportId, fx.setId, "nope"] });
    expect(out).toEqual([{ id: fx.sportId, name: "Baseball", code: "BB" }, null, null]);
  });

  test("sports refuses more than its limit and an anonymous caller", async () => {
    const { t, fx, me } = await setup();
    await expect(me.query(api.pickList.sports, { sportIds: Array.from({ length: 21 }, () => fx.sportId) })).rejects.toThrow(/at most 20/);
    await expect(t.query(api.pickList.sports, { sportIds: [] })).rejects.toThrow(/Not authenticated/);
  });
});
