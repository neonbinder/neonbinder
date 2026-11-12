/**
 * NEO-500 — what the sale apply writes for the Pick List (`listingSales.ts`
 * `recordOrderCore` / `applySaleLinesCore` / `lowerCopies`): each applied
 * line's `from` (the box copies it took, a snapshot of slot, condition and
 * serial), `lastOnes` (no box copy of the card is left), `shortBy` on an
 * oversell, and the sale's `pullOpen` (the `by_owner_pull_open` index).
 * Exactly once: a re-apply writes nothing new; a re-poll keeps what the apply
 * and the Pick List wrote and recomputes `pullOpen`. The caps: `MAX_PICK_FROM`
 * per line, `MAX_FROM_PER_SALE` per sale, and a sale at `MAX_SALE_ITEMS`
 * lines stays under Convex's 1 MiB document cap. `pollInput` never hands a
 * test seed's order back to the poll.
 *
 * Fixtures copy `listingSales.test.ts` (same mocks, same setup). No test
 * reaches a live server.
 */
import { convexTest } from "convex-test";
import { getDocumentSize, type Value } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildListingSku } from "./lib/listingSku";
import { MAX_LINES_PER_CARD } from "./collection";
import { MAX_SALE_ITEMS, type ProjectedOrder } from "./listingSales";
import { MAX_FROM_PER_SALE, MAX_PICK_FROM } from "./lib/pickLines";
import { TEST_SALE_ORDER_PREFIX } from "./lib/testSeedMarks";
import { priceEveryVariant } from "../lib/testing/common-prices";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "tok-1" }),
    }),
    refreshSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => ({ refreshed: false }),
    }),
  };
});

/** See `listingDrain.test.ts`: convex-test ids carry no Convex checksum. */
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

const OWNER = "collector_picklist_001";
const ME = { subject: OWNER };
const NOW = 1_700_000_000_000;

async function setup() {
  const t = convexTest(schema, modules);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const box2 = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "Binder" })).containerId;
  const { cardId, otherCardId } = await t.run(async (ctx) => {
    const row = (level: string, value: string, parentId?: Id<"selectorOptions">) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: { bsc: { b0: `slug-${value}` } },
        isCustom: false,
        children: [],
        ...(parentId ? { parentId } : {}),
        lastUpdated: NOW,
      } as never);
    const sport = await row("sport", "Football");
    const year = await row("year", "2021", sport);
    const set = await row("setName", "Score", year);
    const variant = await row("variantType", "Base", set);
    const card = (n: string, ref: string) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variant,
        cardNumber: n,
        cardName: `Player ${n}`,
        listingTitle: `Card ${n}`,
        sportId: sport,
        platformData: { bsc: { ref, src: "b0" } },
        sortOrder: 0,
        lastUpdated: NOW,
      } as never);
    return { cardId: await card("TB2", "bsc-1"), otherCardId: await card("TB10", "bsc-2") };
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: OWNER,
      platform: "bsc",
      listingStartedAt: NOW,
      lastUpdated: NOW,
    });
    await ctx.db.insert("userProfiles", {
      userId: OWNER,
      siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
    } as never);
  });
  await priceEveryVariant(t, OWNER);
  return { t, me, box, box2, binder, cardId, otherCardId };
}
type S = Awaited<ReturnType<typeof setup>>;

const add = async (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  (
    await s.me.mutation(api.collection.addLineItem, {
      cardId,
      details: { quantity: 1, ...details } as never,
      keepsOwnLine: true,
    })
  ).copyId as Id<"collectionCopies">;

const skuOf = (s: S, cardId: Id<"cardChecklist"> = s.cardId, boxId: Id<"collectionContainers"> = s.box) =>
  buildListingSku({ cardId, bscCondition: "near_mint", boxId });

type Line = Partial<ProjectedOrder["items"][number]>;
function order(s: S, over: Partial<ProjectedOrder> & { lines?: Line[] } = {}): ProjectedOrder {
  const { lines, ...rest } = over;
  return {
    orderId: "order-1",
    orderNo: "NO-1",
    orderDate: NOW + 1000,
    status: "READY_TO_SHIP",
    totals: { subtotalCents: 50 },
    items: (lines ?? [{}]).map((l) => ({
      platformCardId: "bsc-1",
      condition: "near_mint",
      quantity: 1,
      priceCents: 25,
      sellerSku: skuOf(s),
      graded: false,
      ...l,
    })),
    ...rest,
  };
}

async function record(s: S, o: ProjectedOrder) {
  const r = await s.t.mutation(internal.listingSales.recordOrder, { ownerId: OWNER, platform: "bsc", order: o });
  if (r.saleId === null) throw new Error("listing is off");
  if (r.toApply.length > 0) {
    await s.t.mutation(internal.listingSales.applySaleItems, { ownerId: OWNER, saleId: r.saleId, indexes: r.toApply });
  }
  return { saleId: r.saleId, toApply: r.toApply };
}

const sale = async (s: S, orderId = "order-1"): Promise<Doc<"marketplaceSales">> => {
  const row = await s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc").eq("orderId", orderId))
      .unique(),
  );
  if (!row) throw new Error(`no sale ${orderId}`);
  return row;
};

/** The Pick List's own read: the owner's sales with `pullOpen: true`. */
const openOrders = (s: S) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query("marketplaceSales")
        .withIndex("by_owner_pull_open", (q) => q.eq("ownerId", OWNER).eq("pullOpen", true))
        .collect()
    ).map((r) => r.orderId),
  );

const copyRows = (s: S) => s.t.run(async (ctx) => await ctx.db.query("collectionCopies").collect());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the apply records where a line came from", () => {
  test("from snapshots each box copy taken: box, copy, how many, slot, condition and serial", async () => {
    const s = await setup();
    const older = await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", acquiredOn: "2026-01-01", serialNumber: "07/25" });
    const newer = await add(s, s.cardId, { homeId: s.box2, condition: "Mint", quantity: 3, acquiredOn: "2026-02-01" });
    // A slot as an older client wrote it (boxes do not hand out pockets).
    await s.t.run(async (ctx) => ctx.db.patch(older, { slot: 4 }));

    await record(s, order(s, { lines: [{ quantity: 2 }] }));
    const item = (await sale(s)).items[0];
    expect(item.from).toEqual([
      { homeId: s.box, copyId: older, quantity: 1, slot: 4, condition: "Near Mint", serialNumber: "07/25" },
      { homeId: s.box2, copyId: newer, quantity: 1, condition: "Mint" },
    ]);
    // The first copy is gone; the snapshot outlives it.
    const left = await copyRows(s);
    expect(left.map((r) => r._id)).toEqual([newer]);
    // Two Mint copies remain in Box B: not the last ones.
    expect(item.lastOnes).toBeUndefined();
    expect((await sale(s)).pullOpen).toBe(true);
    expect(await openOrders(s)).toEqual(["order-1"]);
  });

  test("lastOnes when the apply took every box copy of the card", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    // The other card's copy and the binder copy are not box copies of THIS card.
    await add(s, s.otherCardId, { homeId: s.box, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.binder, condition: "Near Mint" });
    await record(s, order(s));
    const item = (await sale(s)).items[0];
    expect(item).toMatchObject({ applied: true, lastOnes: true });
    expect(item.problem).toBeUndefined();
  });

  test("no lastOnes while a box still holds the card in a condition the sale could not take", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.box2, condition: "Poor" });
    await record(s, order(s));
    expect((await sale(s)).items[0].lastOnes).toBeUndefined();
  });

  test("no lastOnes while a graded copy of the card sits in a box (a slab is still a box copy)", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.box2, grading: { grader: "PSA", grade: "10" } });
    await record(s, order(s));
    const item = (await sale(s)).items[0];
    expect(item.from).toHaveLength(1);
    expect(item.lastOnes).toBeUndefined();
  });

  test("oversold: shortBy says how many NB lacked, from lists what was taken, lastOnes is set", async () => {
    const s = await setup();
    const a = await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await record(s, order(s, { lines: [{ quantity: 5 }] }));
    const item = (await sale(s)).items[0];
    expect(item).toMatchObject({ applied: true, problem: "oversold", shortBy: 3, lastOnes: true });
    expect(item.from).toEqual([{ homeId: s.box, copyId: a, quantity: 2, condition: "Near Mint" }]);
    // Short lines are still to pull.
    expect((await sale(s)).pullOpen).toBe(true);
  });

  test("a line NB held nothing for: no from, shortBy the whole quantity, and no lastOnes (nothing to pull)", async () => {
    const s = await setup();
    await record(s, order(s, { lines: [{ quantity: 2 }] }));
    const item = (await sale(s)).items[0];
    expect(item).toMatchObject({ applied: true, problem: "oversold", shortBy: 2 });
    expect(item.lastOnes).toBeUndefined();
    expect(item.from).toBeUndefined();
  });

  test("a refused line carries neither from nor lastOnes, and still opens the order (Can't find it)", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await record(s, order(s, { lines: [{ sellerSku: "303|TB2" }, { platformCardId: "bsc-somebody-else" }] }));
    const items = (await sale(s)).items;
    expect(items.map((i) => i.problem)).toEqual(["unmatched", "linkMismatch"]);
    for (const i of items) {
      expect(i.from).toBeUndefined();
      expect(i.lastOnes).toBeUndefined();
    }
    expect((await sale(s)).pullOpen).toBe(true);
  });

  test("no lastOnes when the copy read was truncated (more than MAX_LINES_PER_CARD rows)", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    // MAX_LINES_PER_CARD more rows of the card in the binder: the read takes
    // MAX + 1 and cannot see everything.
    await s.t.run(async (ctx) => {
      const home = s.binder;
      for (let i = 0; i < MAX_LINES_PER_CARD; i += 1) {
        await ctx.db.insert("collectionCopies", {
          ownerId: OWNER,
          cardId: s.cardId,
          homeId: home,
          quantity: 1,
          condition: "Near Mint",
          lastUpdated: NOW,
        } as never);
      }
    });
    await record(s, order(s));
    const item = (await sale(s)).items[0];
    expect(item.applied).toBe(true);
    expect(item.from).toHaveLength(1);
    expect(item.lastOnes).toBeUndefined();
  });

  test("control for the truncation test: exactly MAX_LINES_PER_CARD rows is a whole read, so lastOnes is set", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_LINES_PER_CARD - 1; i += 1) {
        await ctx.db.insert("collectionCopies", {
          ownerId: OWNER,
          cardId: s.cardId,
          homeId: s.binder,
          quantity: 1,
          condition: "Near Mint",
          lastUpdated: NOW,
        } as never);
      }
    });
    await record(s, order(s));
    expect((await sale(s)).items[0].lastOnes).toBe(true);
  });

  test("two lines of the same card in one apply: the first line's lastOnes is read before the second lowers its copy", async () => {
    // Current behaviour, documented: lastOnes is per line, computed right
    // after that line lowers. The first line leaves one copy for the second,
    // so only the second line says "Last ones".
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2026-02-01" });
    await record(s, order(s, { lines: [{}, {}] }));
    const items = (await sale(s)).items;
    expect(items.map((i) => i.applied)).toEqual([true, true]);
    expect(items[0].lastOnes).toBeUndefined();
    expect(items[1].lastOnes).toBe(true);
    expect(items.map((i) => i.from?.[0].homeId)).toEqual([s.box, s.box2]);
    expect(await copyRows(s)).toEqual([]);
  });
});

describe("exactly once", () => {
  test("a second apply of the same lines writes nothing new and lowers nothing", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    const { saleId, toApply } = await record(s, order(s));
    const before = await sale(s);
    const copiesBefore = await copyRows(s);
    const outboxBefore = await s.t.run(async (ctx) => (await ctx.db.query("listingOutbox").collect()).length);

    const again = await s.t.mutation(internal.listingSales.applySaleItems, { ownerId: OWNER, saleId, indexes: toApply });
    expect(again).toEqual({ applied: 0, lowered: 0 });
    const after = await sale(s);
    expect(after.items).toEqual(before.items);
    expect(after.pullOpen).toBe(before.pullOpen);
    expect(await copyRows(s)).toEqual(copiesBefore);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("listingOutbox").collect()).length)).toBe(outboxBefore);
  });

  test("a re-poll keeps from, lastOnes and pulledAt, and recomputes pullOpen", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await add(s, s.otherCardId, { homeId: s.box, condition: "Near Mint" });
    const two = [{}, { platformCardId: "bsc-2", sellerSku: skuOf(s, s.otherCardId) }];
    await record(s, order(s, { lines: two }));
    const first = await sale(s);
    expect(first.items.every((i) => i.from?.length === 1 && i.lastOnes === true)).toBe(true);

    // The collector marks line 0 pulled (as `pickList.setPulled` would).
    await s.t.run(async (ctx) => {
      const items = first.items.map((i, n) => (n === 0 ? { ...i, pulledAt: NOW + 5 } : i));
      await ctx.db.patch(first._id, { items });
    });

    // The marketplace hands the lines back in the other order, new prices.
    const r = await record(s, order(s, { lines: [{ ...two[1], priceCents: 30 }, { priceCents: 30 }] }));
    expect(r.toApply).toEqual([]);
    const after = await sale(s);
    const byCard = new Map(after.items.map((i) => [i.platformCardId, i]));
    expect(byCard.get("bsc-1")).toMatchObject({ pulledAt: NOW + 5, lastOnes: true, from: first.items[0].from, priceCents: 30 });
    expect(byCard.get("bsc-2")).toMatchObject({ lastOnes: true, from: first.items[1].from, priceCents: 30 });
    expect(byCard.get("bsc-2")?.pulledAt).toBeUndefined();
    expect(after.pullOpen).toBe(true);

    // Pull the other line too: the next re-poll takes the order off the list.
    await s.t.run(async (ctx) => {
      const items = after.items.map((i) => ({ ...i, pulledAt: NOW + 6 }));
      await ctx.db.patch(after._id, { items });
    });
    await record(s, order(s, { lines: two }));
    const done = await sale(s);
    expect("pullOpen" in done).toBe(false);
    expect(await openOrders(s)).toEqual([]);
    expect(done.items.every((i) => i.from?.length === 1)).toBe(true);
  });

  test.each(["SHIPPED", "PARTIALLY_REFUNDED_SHIPPED", "CANCELLED"])(
    "a %s re-poll clears pullOpen: the field is gone and the index finds nothing",
    async (status) => {
      const s = await setup();
      await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
      await record(s, order(s));
      expect(await openOrders(s)).toEqual(["order-1"]);
      const from = (await sale(s)).items[0].from;

      await record(s, order(s, { status }));
      const after = await sale(s);
      expect(after.status).toBe(status);
      expect("pullOpen" in after).toBe(false);
      expect(await openOrders(s)).toEqual([]);
      // What the apply wrote stays.
      expect(after.items[0]).toMatchObject({ applied: true, from, lastOnes: true });
    },
  );

  test("an order first seen SHIPPED is applied but never opened", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await record(s, order(s, { status: "SHIPPED" }));
    const stored = await sale(s);
    expect(stored.items[0].applied).toBe(true);
    expect(stored.items[0].from).toHaveLength(1);
    expect("pullOpen" in stored).toBe(false);
    expect(await openOrders(s)).toEqual([]);
  });
});

describe("the from caps", () => {
  test(`one line records at most MAX_PICK_FROM (${MAX_PICK_FROM}) copies, and still lowers them all`, async () => {
    const s = await setup();
    const n = MAX_PICK_FROM + 1;
    for (let i = 0; i < n; i += 1) {
      await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", acquiredOn: `2026-01-${String(i + 1).padStart(2, "0")}` });
    }
    await record(s, order(s, { lines: [{ quantity: n }] }));
    const item = (await sale(s)).items[0];
    expect(item.from).toHaveLength(MAX_PICK_FROM);
    expect(item.problem).toBeUndefined();
    expect(item.lastOnes).toBe(true);
    expect(await copyRows(s)).toEqual([]);
  });

  /**
   * A stored applied line already holding `held` `from` entries (each naming
   * one real copy row), then a re-poll that adds a new line taking `take`
   * copies of the other card.
   */
  async function saleNearCap(held: number, take: number) {
    const s = await setup();
    const anchor = await add(s, s.cardId, { homeId: s.binder, condition: "Near Mint" });
    for (let i = 0; i < take; i += 1) {
      await add(s, s.otherCardId, { homeId: s.box, condition: "Near Mint", acquiredOn: `2026-01-${String(i + 1).padStart(2, "0")}` });
    }
    const base = order(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceSales", {
        ownerId: OWNER,
        platform: "bsc",
        orderId: base.orderId,
        orderNo: base.orderNo,
        orderDate: base.orderDate,
        status: base.status,
        totals: base.totals,
        items: [
          {
            ...base.items[0],
            graded: undefined,
            applied: true,
            appliedAt: NOW,
            cardId: s.cardId,
            from: Array.from({ length: held }, () => ({ homeId: s.box, copyId: anchor, quantity: 1, condition: "Near Mint" as const })),
          },
        ].map(({ graded: _g, ...rest }) => rest),
        pullOpen: true,
        firstSeenAt: NOW,
        lastUpdated: NOW,
      });
    });
    await record(
      s,
      order(s, { lines: [{}, { platformCardId: "bsc-2", quantity: take, sellerSku: skuOf(s, s.otherCardId) }] }),
    );
    const items = (await sale(s)).items;
    return { s, newLine: items.find((i) => i.platformCardId === "bsc-2")! };
  }

  test("a line that fits the sale's remaining MAX_FROM_PER_SALE budget exactly records its from", async () => {
    const { newLine } = await saleNearCap(MAX_FROM_PER_SALE - 5, 5);
    expect(newLine.applied).toBe(true);
    expect(newLine.from).toHaveLength(5);
  });

  test("a line that would pass MAX_FROM_PER_SALE records no from at all, and is still applied", async () => {
    const { s, newLine } = await saleNearCap(MAX_FROM_PER_SALE - 4, 5);
    expect(newLine.applied).toBe(true);
    expect(newLine.from).toBeUndefined();
    expect(newLine.lastOnes).toBe(true);
    expect((await copyRows(s)).filter((r) => r.cardId === s.otherCardId)).toEqual([]);
  });

  test(`a sale at MAX_SALE_ITEMS (${MAX_SALE_ITEMS}) lines with MAX_FROM_PER_SALE entries stays under 1 MiB`, () => {
    // Worst case per line: every optional field present, long ids and SKU,
    // a long serial on every from entry.
    const id = (table: string, n: number) => `${table.slice(0, 4)}${String(n).padStart(28, "0")}`;
    const sku = `NB1-${"c".repeat(32)}-NM-${"b".repeat(32)}`;
    const fromEntry = (n: number) => ({
      homeId: id("home", n),
      copyId: id("copy", n),
      quantity: 99,
      slot: 999,
      condition: "Near Mint",
      serialNumber: "1234/9999 SSP RED".padEnd(32, "x"),
    });
    const buildDoc = (fromPerLine: (line: number) => number) => {
      let n = 0;
      const items = Array.from({ length: MAX_SALE_ITEMS }, (_, line) => ({
        platformCardId: `bsc-${"r".repeat(36)}`,
        condition: "near_mint",
        quantity: 99,
        priceCents: 999_999,
        sellerSku: sku,
        applied: true,
        appliedAt: NOW,
        cardId: id("card", line),
        problem: "oversold",
        shortBy: 99,
        lastOnes: true,
        pulledAt: NOW,
        from: Array.from({ length: fromPerLine(line) }, () => fromEntry((n += 1))),
      }));
      return {
        _id: id("sale", 0),
        _creationTime: NOW,
        ownerId: `user_${"o".repeat(28)}`,
        platform: "bsc",
        orderId: "o".repeat(40),
        orderNo: "n".repeat(40),
        orderDate: NOW,
        status: "PARTIALLY_REFUNDED_READY_TO_SHIP",
        totals: { subtotalCents: 1, shippingCents: 1, taxCents: 1, totalCents: 1 },
        items,
        pullOpen: true,
        firstSeenAt: NOW,
        lastUpdated: NOW,
      } as unknown as Record<string, Value>;
    };
    const MIB = 1024 * 1024;
    const perLine = MAX_FROM_PER_SALE / MAX_SALE_ITEMS;
    // The cap as the apply enforces it: MAX_FROM_PER_SALE entries, spread
    // MAX_PICK_FROM to a line until the budget is spent.
    const capped = buildDoc((line) => Math.max(0, Math.min(MAX_PICK_FROM, MAX_FROM_PER_SALE - line * MAX_PICK_FROM)));
    expect((capped.items as unknown as Array<{ from: unknown[] }>).reduce((t, i) => t + i.from.length, 0)).toBe(MAX_FROM_PER_SALE);
    expect(getDocumentSize(capped)).toBeLessThan(MIB);
    // And the per-sale cap is load-bearing: MAX_PICK_FROM on every line would not fit.
    expect(getDocumentSize(buildDoc(() => MAX_PICK_FROM))).toBeGreaterThan(MIB);
    expect(perLine).toBeLessThan(MAX_PICK_FROM);
  });
});

describe("pollInput", () => {
  test("drops a test seed's order and keeps the platform's own", async () => {
    const s = await setup();
    await record(s, order(s, { orderId: "real-order-1", status: "CANCELLED" }));
    await record(s, order(s, { orderId: `${TEST_SALE_ORDER_PREFIX}seeded-1`, orderNo: "seeded-1", status: "CANCELLED" }));
    const input = await s.t.query(internal.listingSales.pollInput, { ownerId: OWNER, platform: "bsc" });
    expect(input?.stored.map((o) => o.orderId)).toEqual(["real-order-1"]);
  });
});
