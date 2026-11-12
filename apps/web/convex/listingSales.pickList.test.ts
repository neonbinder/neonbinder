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
import {
  capListed,
  listedBytes,
  MAX_LISTED_BYTES_PER_SALE,
  MAX_SALE_ITEMS,
  type ProjectedOrder,
  SPORT_ROW_SCAN,
  sportResolver,
  utf8Bytes,
} from "./listingSales";
import { BSC_LISTED_BOUNDS } from "./lib/bscOrders";
import { MAX_FROM_PER_SALE, MAX_PICK_FROM, saleLineKeys } from "./lib/pickLines";
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

  test("NEO-509: the same worst case with every line described stays under 1,000,000 bytes", () => {
    // Same worst-case line as above; `listed` on every line, then capped by
    // the sale's MAX_LISTED_BYTES_PER_SALE exactly as recordOrderCore caps it.
    const id = (table: string, n: number) => `${table.slice(0, 4)}${String(n).padStart(28, "0")}`;
    const sku = `NB1-${"c".repeat(32)}-NM-${"b".repeat(32)}`;
    let n = 0;
    const fromEntry = () => ({
      homeId: id("home", (n += 1)),
      copyId: id("copy", n),
      quantity: 99,
      slot: 999,
      condition: "Near Mint",
      serialNumber: "1234/9999 SSP RED".padEnd(32, "x"),
    });
    // Two shapes: values at their bounds in 3-byte characters (fewest lines,
    // most bytes each), and one-character values (most lines, most per-field
    // overhead the budget does not see).
    const fat = (line: number) => ({
      sport: "€".repeat(BSC_LISTED_BOUNDS.sport),
      sportId: id("spor", line),
      year: "€".repeat(BSC_LISTED_BOUNDS.year),
      setName: "€".repeat(BSC_LISTED_BOUNDS.setName),
      players: "€".repeat(BSC_LISTED_BOUNDS.players),
      cardNo: "€".repeat(BSC_LISTED_BOUNDS.cardNo),
      variant: "€".repeat(BSC_LISTED_BOUNDS.variant),
      variantName: "€".repeat(BSC_LISTED_BOUNDS.variantName),
    });
    const thin = (line: number) => ({
      sport: "a",
      sportId: id("spor", line),
      year: "1",
      setName: "s",
      players: "p",
      cardNo: "1",
      variant: "v",
      variantName: "n",
    });
    for (const describe of [fat, thin]) {
      n = 0;
      const items = capListed(
        Array.from({ length: MAX_SALE_ITEMS }, (_, line) => ({
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
          from: Array.from(
            { length: Math.max(0, Math.min(MAX_PICK_FROM, MAX_FROM_PER_SALE - line * MAX_PICK_FROM)) },
            fromEntry,
          ),
          listed: describe(line) as unknown as NonNullable<Doc<"marketplaceSales">["items"][number]["listed"]>,
        })),
      );
      const spent = items.reduce((t, i) => t + (i.listed ? listedBytes(i.listed) : 0), 0);
      expect(spent).toBeLessThanOrEqual(MAX_LISTED_BYTES_PER_SALE);
      expect(items.some((i) => i.listed === undefined)).toBe(true);
      const doc = {
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
      expect(getDocumentSize(doc)).toBeLessThan(1_000_000);
    }
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

describe("NEO-509 — the card a line describes (listed) on the stored sale", () => {
  const LISTED = {
    sport: "Football",
    platformSportId: "football",
    year: "2021",
    setName: "2021 Score",
    players: "Justin Fields",
    cardNo: "TB2",
    variant: "Insert",
    variantName: "1991 Throwback",
  };
  /** An unmatched line (not NB's SKU) carrying a description. */
  const unmatched = (listed?: Partial<typeof LISTED>): Line => ({
    platformCardId: "bsc-unknown",
    sellerSku: "303|TB2",
    ...(listed ? { listed } : {}),
  });
  const sportRow = (s: S, value: string, bscId: string) =>
    s.t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value,
        platformData: { bsc: { b0: bscId } },
        isCustom: false,
        children: [],
        lastUpdated: NOW,
      } as never),
    );

  test("stores the description with NB's sport resolved by id from exactly one sport row; the platform id is not stored", async () => {
    const s = await setup();
    const football = await sportRow(s, "Football (NB)", "football");
    await record(s, order(s, { lines: [unmatched(LISTED)] }));
    const item = (await sale(s)).items[0];
    expect(item.problem).toBe("unmatched");
    expect(item.listed).toEqual({
      sport: "Football",
      sportId: football,
      year: "2021",
      setName: "2021 Score",
      players: "Justin Fields",
      cardNo: "TB2",
      variant: "Insert",
      variantName: "1991 Throwback",
    });
    expect(JSON.stringify(item)).not.toContain("platformSportId");
  });

  test("no sport row holds the id: no sportId, BSC's sport word stays as the label", async () => {
    const s = await setup();
    await record(s, order(s, { lines: [unmatched(LISTED)] }));
    const listed = (await sale(s)).items[0].listed;
    expect(listed?.sportId).toBeUndefined();
    expect(listed?.sport).toBe("Football");
  });

  test("two sport rows hold the same id: no sportId (never the first)", async () => {
    const s = await setup();
    await sportRow(s, "Football", "football");
    await sportRow(s, "Football 2", "football");
    await record(s, order(s, { lines: [unmatched(LISTED)] }));
    expect((await sale(s)).items[0].listed?.sportId).toBeUndefined();
  });

  /** Pads the sport level to `total` rows, each holding a distinct BSC id. */
  const padSportRows = (s: S, total: number) =>
    s.t.run(async (ctx) => {
      const have = (await ctx.db.query("selectorOptions").withIndex("by_level", (q) => q.eq("level", "sport")).collect())
        .length;
      for (let i = have; i < total; i += 1) {
        await ctx.db.insert("selectorOptions", {
          level: "sport",
          value: `Pad Sport ${i}`,
          platformData: { bsc: { b0: `pad-sport-${i}` } },
          isCustom: false,
          children: [],
          lastUpdated: NOW,
        } as never);
      }
    });

  test("a full sport scan resolves nothing: a duplicate past the bound would be invisible (fail closed)", async () => {
    const s = await setup();
    await sportRow(s, "Football (NB)", "football");
    await padSportRows(s, SPORT_ROW_SCAN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await record(s, order(s, { lines: [unmatched(LISTED)] }));
    const listed = (await sale(s)).items[0].listed;
    expect(listed?.sportId).toBeUndefined();
    expect(listed?.sport).toBe("Football");
    expect(warn.mock.calls.some(([m]) => String(m).includes("sport resolve skipped"))).toBe(true);
    warn.mockRestore();
  });

  test("one row under the bound still resolves (control for the full-scan test)", async () => {
    const s = await setup();
    const football = await sportRow(s, "Football (NB)", "football");
    await padSportRows(s, SPORT_ROW_SCAN - 1);
    await record(s, order(s, { lines: [unmatched(LISTED)] }));
    expect((await sale(s)).items[0].listed?.sportId).toBe(football);
  });

  test("the sport is never resolved by name", async () => {
    const s = await setup();
    // The setup's sport row is named "Football" but its bsc slot is not "football".
    await record(s, order(s, { lines: [unmatched({ ...LISTED, platformSportId: "american-football" })] }));
    expect((await sale(s)).items[0].listed?.sportId).toBeUndefined();
  });

  test("a re-poll without a description keeps the stored one; with one, the fresh read wins; line ids do not move", async () => {
    const s = await setup();
    await add(s, s.cardId, { condition: "Near Mint", homeId: s.box });
    const { saleId } = await record(s, order(s, { lines: [{ listed: LISTED }, unmatched(LISTED)] }));
    const first = await sale(s);
    const ids = saleLineKeys(saleId, first.items);
    expect(first.items[0].applied).toBe(true);

    await record(s, order(s, { lines: [{}, unmatched()] }));
    const kept = await sale(s);
    expect(kept.items.map((i) => i.listed?.players)).toEqual(["Justin Fields", "Justin Fields"]);
    expect(kept.items[0].applied).toBe(true);
    expect(saleLineKeys(saleId, kept.items)).toEqual(ids);

    await record(s, order(s, { lines: [{}, unmatched({ ...LISTED, players: "Kyle Trask", cardNo: "TB10" })] }));
    const fresh = await sale(s);
    expect(fresh.items[1].listed?.players).toBe("Kyle Trask");
    expect(fresh.items[1].listed?.cardNo).toBe("TB10");
    expect(fresh.items[0].listed?.players).toBe("Justin Fields");
    expect(saleLineKeys(saleId, fresh.items)).toEqual(ids);
  });

  test("the store re-checks the bounds: an over-long or control-character field is dropped, the rest kept", async () => {
    const s = await setup();
    await record(
      s,
      order(s, {
        lines: [unmatched({ ...LISTED, players: "p".repeat(BSC_LISTED_BOUNDS.players + 1), cardNo: "TB\u00002" })],
      }),
    );
    const listed = (await sale(s)).items[0].listed;
    expect(listed?.players).toBeUndefined();
    expect(listed?.cardNo).toBeUndefined();
    expect(listed?.setName).toBe("2021 Score");
  });

  test("the store re-checks format characters too: a bidi override or zero-width char drops that field", async () => {
    const s = await setup();
    await record(
      s,
      order(s, {
        lines: [unmatched({ ...LISTED, cardNo: "TB\u202e2", players: "Justin\u200b Fields", setName: "2021 \u2066Score" })],
      }),
    );
    const listed = (await sale(s)).items[0].listed;
    expect(listed?.cardNo).toBeUndefined();
    expect(listed?.players).toBeUndefined();
    expect(listed?.setName).toBeUndefined();
    expect(listed?.variantName).toBe("1991 Throwback");
  });

  test("a description with nothing readable left is not stored", async () => {
    const s = await setup();
    await record(s, order(s, { lines: [unmatched({ platformSportId: "nobody-holds-this" })] }));
    expect((await sale(s)).items[0].listed).toBeUndefined();
  });

  test("capListed keeps descriptions in item order until the budget is spent, then none", () => {
    const big = { setName: "x".repeat(40_000) };
    const small = { cardNo: "1" };
    const items = capListed([{ listed: big }, { listed: small }, { listed: big }, { listed: big }, {}, { listed: small }]);
    // The third big one would pass 100 KB: from there on no line carries one, small or not.
    expect(items.map((i) => i.listed !== undefined)).toEqual([true, true, true, false, false, false]);
    expect(listedBytes({ cardNo: "1" })).toBeGreaterThan("cardNo1".length);
  });
});

describe("NEO-509 — utf8Bytes counts what the budget spends", () => {
  test.each([
    ["a", 1],
    ["é", 2],
    ["€", 3],
    ["😀", 4],
    // A lone surrogate stores as the 3-byte replacement character, high or low, mid-string or last.
    ["\ud83d", 3],
    ["\ude00", 3],
    ["a\ud83d", 4],
    ["\ud83dz", 4],
    ["\ude00\ud83d", 6],
    ["", 0],
  ])("%j is %i bytes", (text, bytes) => {
    expect(utf8Bytes(text)).toBe(bytes);
  });

  test("agrees with the platform's encoder on well-formed text", () => {
    for (const text of ["Topps Chrome", "Müller #7", "2023–24 Prizm €", "大谷翔平", "Gold 😀😀 Refractor"]) {
      expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  test("a multi-byte description spends the sale's budget sooner than an ASCII one of the same length", () => {
    const stored = (ch: string) => ({ setName: ch.repeat(120), players: ch.repeat(160), variantName: ch.repeat(120) });
    const lines = (ch: string) => capListed(Array.from({ length: 400 }, () => ({ listed: stored(ch) })));
    const kept = (ch: string) => lines(ch).filter((i) => i.listed !== undefined).length;
    expect(kept("€")).toBeLessThan(kept("a"));
    // The counts are exactly the budget over each line's cost: 3 bytes a character cost 3x the value bytes.
    expect(kept("€")).toBe(Math.floor(MAX_LISTED_BYTES_PER_SALE / listedBytes(stored("€"))));
    expect(kept("a")).toBe(Math.floor(MAX_LISTED_BYTES_PER_SALE / listedBytes(stored("a"))));
    expect(listedBytes(stored("€"))).toBeGreaterThan(2 * listedBytes(stored("a")) - 40);
  });
});

describe("NEO-509 — sportResolver reads BSC's slot only", () => {
  const withSportRow = async () => {
    const t = convexTest(schema, modules);
    const sportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: { b0: "football" } },
        isCustom: false,
        children: [],
        lastUpdated: NOW,
      } as never),
    );
    return { t, sportId };
  };

  test("another platform's lines resolve nothing, even for an id BSC's slot holds", async () => {
    const { t, sportId } = await withSportRow();
    const out = await t.run(async (ctx) => ({
      bsc: await sportResolver(ctx, "bsc")("football"),
      ebay: await sportResolver(ctx, "ebay")("football"),
    }));
    expect(out).toEqual({ bsc: sportId, ebay: null });
  });

  test("another platform's resolver never reads the sport rows", async () => {
    const db = {
      query: () => {
        throw new Error("a non-BSC resolver must not read");
      },
    };
    await expect(sportResolver({ db } as never, "ebay")("football")).resolves.toBeNull();
  });
});

describe("NEO-509 — the listed budget across a re-poll", () => {
  const FAT = {
    sport: "S".repeat(BSC_LISTED_BOUNDS.sport),
    year: "2021",
    setName: "T".repeat(BSC_LISTED_BOUNDS.setName),
    players: "P".repeat(BSC_LISTED_BOUNDS.players),
    cardNo: "N".repeat(BSC_LISTED_BOUNDS.cardNo),
    variant: "V".repeat(BSC_LISTED_BOUNDS.variant),
    variantName: "W".repeat(BSC_LISTED_BOUNDS.variantName),
  };
  const fat = (n: number): Line => ({ platformCardId: "bsc-unknown", sellerSku: "303|TB2", listed: { ...FAT, cardNo: `${n}` } });

  test("lines already holding a description keep it; the budget is spent on new lines only after them, and never passed", async () => {
    const s = await setup();
    await record(s, order(s, { lines: Array.from({ length: 100 }, (_, n) => fat(n)) }));
    const first = (await sale(s)).items;
    expect(first.every((i) => i.listed !== undefined)).toBe(true);

    await record(s, order(s, { lines: Array.from({ length: 300 }, (_, n) => fat(n)) }));
    const items = (await sale(s)).items;
    expect(items).toHaveLength(300);
    const has = items.map((i) => i.listed !== undefined);
    // The first 100 (the stored ones) keep theirs; the new lines fill the rest until it runs out, then none.
    expect(has.slice(0, 100).every(Boolean)).toBe(true);
    const lastWith = has.lastIndexOf(true);
    expect(lastWith).toBeGreaterThan(100);
    expect(lastWith).toBeLessThan(299);
    expect(has.slice(0, lastWith + 1).every(Boolean)).toBe(true);
    expect(has.slice(lastWith + 1).some(Boolean)).toBe(false);
    const spent = items.reduce((n, i) => n + (i.listed ? listedBytes(i.listed) : 0), 0);
    expect(spent).toBeLessThanOrEqual(MAX_LISTED_BYTES_PER_SALE);
    // Exactly as far as the budget goes: one more would not fit.
    expect(spent + listedBytes(items[0].listed!)).toBeGreaterThan(MAX_LISTED_BYTES_PER_SALE);
  });

  /** A line with its own key (card id), so a re-poll pairs it by key whatever its position. */
  const keyed = (id: string, listed?: Record<string, string>): Line => ({
    platformCardId: id,
    sellerSku: "303|TB2",
    ...(listed ? { listed } : {}),
  });
  const fatFor = (n: number) => ({ ...FAT, cardNo: `${n}` });
  const spentOn = (items: Doc<"marketplaceSales">["items"]) =>
    items.reduce((t, i) => t + (i.listed ? listedBytes(i.listed) : 0), 0);

  test.each([
    ["the stored lines come after the new ones", true],
    ["the stored lines are missing from the read (kept at the end)", false],
  ])("stored descriptions are budgeted first when %s; new fat lines only fill what is left", async (_name, resend) => {
    const s = await setup();
    await record(s, order(s, { lines: Array.from({ length: 100 }, (_, n) => keyed(`bsc-old-${n}`, fatFor(n))) }));
    const before = new Map((await sale(s)).items.map((i) => [i.platformCardId, i.listed]));
    expect([...before.values()].every((l) => l !== undefined)).toBe(true);

    // BSC's order puts 300 large new descriptions in front of the stored lines.
    const fresh = Array.from({ length: 300 }, (_, n) => keyed(`bsc-new-${n}`, fatFor(1000 + n)));
    const resent = resend ? Array.from({ length: 100 }, (_, n) => keyed(`bsc-old-${n}`, fatFor(n))) : [];
    await record(s, order(s, { lines: [...fresh, ...resent] }));
    const items = (await sale(s)).items;
    expect(items).toHaveLength(400);

    // Every stored line keeps its description, unchanged.
    const old = items.filter((i) => i.platformCardId.startsWith("bsc-old-"));
    expect(old).toHaveLength(100);
    for (const i of old) expect(i.listed).toEqual(before.get(i.platformCardId));

    // New lines fill what is left in item order, then none; the sale never passes the budget.
    const has = items.filter((i) => i.platformCardId.startsWith("bsc-new-")).map((i) => i.listed !== undefined);
    const lastWith = has.lastIndexOf(true);
    expect(lastWith).toBeGreaterThan(0);
    expect(lastWith).toBeLessThan(299);
    expect(has.slice(0, lastWith + 1).every(Boolean)).toBe(true);
    expect(has.slice(lastWith + 1).some(Boolean)).toBe(false);
    const spent = spentOn(items);
    expect(spent).toBeLessThanOrEqual(MAX_LISTED_BYTES_PER_SALE);
    const nextNew = items.find((i) => i.platformCardId === `bsc-new-${lastWith + 1}`)!;
    expect(nextNew.listed).toBeUndefined();
    expect(spent + listedBytes(old[0].listed!)).toBeGreaterThan(MAX_LISTED_BYTES_PER_SALE);
  });

  test("a changed description wins when it fits and never pushes another stored one out", async () => {
    const s = await setup();
    const THIN = { setName: "2021 Score", cardNo: "1" };
    // A thin line first, then more fat lines than the budget holds: the sale stores as many as fit.
    await record(
      s,
      order(s, { lines: [keyed("bsc-thin", THIN), ...Array.from({ length: 300 }, (_, n) => keyed(`bsc-fat-${n}`, fatFor(n)))] }),
    );
    const first = (await sale(s)).items;
    const storedFat = first.filter((i) => i.platformCardId.startsWith("bsc-fat-") && i.listed !== undefined);
    const spent0 = spentOn(first);
    const thinCost = listedBytes(first[0].listed!);
    const fatCost = listedBytes(storedFat[0].listed!);
    // The precondition: the thin line growing to a fat one cannot fit beside the stored ones.
    expect(spent0 - thinCost + fatCost).toBeGreaterThan(MAX_LISTED_BYTES_PER_SALE);

    // Re-poll: the thin line now reads fat (no room), the first fat line now reads thin (room).
    const lines = [
      keyed("bsc-thin", fatFor(9999)),
      ...Array.from({ length: 300 }, (_, n) => keyed(`bsc-fat-${n}`, n === 0 ? { setName: "1991 Score", cardNo: "2" } : fatFor(n))),
    ];
    await record(s, order(s, { lines }));
    const items = (await sale(s)).items;
    const byId = new Map(items.map((i) => [i.platformCardId, i.listed]));

    // No room for the growth: the line keeps its stored description rather than going bare.
    expect(byId.get("bsc-thin")).toEqual(first[0].listed);
    // A shrinking change fits, so it wins.
    expect(byId.get("bsc-fat-0")).toEqual({ setName: "1991 Score", cardNo: "2" });
    // Every other stored description is still there.
    for (const i of storedFat.slice(1)) expect(byId.get(i.platformCardId)).toEqual(i.listed);
    expect(spentOn(items)).toBeLessThanOrEqual(MAX_LISTED_BYTES_PER_SALE);
  });

  test("capListed: stored descriptions first, a changed one only when the swap fits, then new ones in item order", () => {
    const big = { setName: "x".repeat(40_000) };
    const small = { cardNo: "1" };
    const stored = [undefined, undefined, small, big] as const;
    // Lines 0-1 are new and big; line 2 changed small -> big; line 3 is stored big and unchanged.
    const items = capListed(
      [{ listed: big }, { listed: big }, { listed: big }, { listed: big }],
      (_item, i) => stored[i],
    );
    // Stored: small + big. The swap on line 2 fits (big + big), then line 0 fills nothing more: 3 x 40 KB > 100 KB.
    expect(items.map((i) => i.listed)).toEqual([undefined, undefined, big, big]);
    // Without room for the swap, line 2 keeps its stored small description, and no new line fits.
    const tight = capListed(
      [{ listed: big }, { listed: big }, { listed: big }, { listed: big }, { listed: big }],
      (_item, i) => [undefined, undefined, small, big, big][i],
    );
    expect(tight.map((i) => i.listed)).toEqual([undefined, undefined, small, big, big]);
  });
});
