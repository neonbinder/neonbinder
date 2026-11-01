/**
 * NEO-370 — the order poll (`listingSales.ts`): a sale on BSC lowers the
 * collector's box copies exactly once, through the app's own write path.
 *
 * The apply tests drive `recordOrder` + `applySaleItems` directly; the poll
 * test stubs `fetch` with BSC's order history and the redacted real order
 * (`lib/__fixtures__/bsc-order-redacted.json`), re-pointed at this test's
 * card. The credentials layer is mocked at the identity-less entry points.
 * No test reaches a live server.
 */
import fs from "node:fs";
import path from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildListingSku } from "./lib/listingSku";
import { expectCountsExact } from "../lib/testing/collection-counts";
import { pollOwnerImpl, projectBscOrder, type PollCtx, type ProjectedOrder } from "./listingSales";
import { parseBscOrder } from "./lib/bscOrders";

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

const OWNER = "collector_sales_001";
const ME = { subject: OWNER };
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

async function setup(opts: { year?: string } = {}) {
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
    const year = await row("year", opts.year ?? "2021", sport);
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
    await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "bsc", lastUpdated: NOW });
  });
  return { t, me, box, box2, binder, cardId, otherCardId };
}
type S = Awaited<ReturnType<typeof setup>>;

const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });

const copies = (s: S, cardId: Id<"cardChecklist"> = s.cardId) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect())
      .filter((r) => r.cardId === cardId)
      .map((r) => ({ homeId: r.homeId, quantity: r.quantity, condition: r.condition, acquiredOn: r.acquiredOn })),
  );

function order(s: S, over: Partial<ProjectedOrder> & { lines?: Array<Partial<ProjectedOrder["items"][number]>> } = {}): ProjectedOrder {
  const { lines, ...rest } = over;
  const sku = buildListingSku({ cardId: s.cardId, bscCondition: "near_mint", boxId: s.box });
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
      sellerSku: sku,
      graded: false,
      ...l,
    })),
    ...rest,
  };
}

async function record(s: S, o: ProjectedOrder) {
  const r = await s.t.mutation(internal.listingSales.recordOrder, { ownerId: OWNER, platform: "bsc", order: o });
  if (r.saleId === null) throw new Error("listing is off");
  const saleId = r.saleId;
  if (r.toApply.length > 0) {
    await s.t.mutation(internal.listingSales.applySaleItems, { ownerId: OWNER, saleId, indexes: r.toApply });
  }
  return { saleId, toApply: r.toApply };
}

const sale = (s: S, orderId = "order-1") =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc").eq("orderId", orderId))
      .unique(),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("applying a sale", () => {
  test("lowers the oldest matching box copy once, through the app's write path", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2026-03-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Mint", quantity: 2, acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.binder, condition: "Near Mint", acquiredOn: "2025-01-01" });

    await record(s, order(s));
    const after = await copies(s);
    // The oldest BOX copy (Mint folds into near_mint) went 2 → 1; the older
    // binder copy is never for sale.
    expect(after.find((c) => c.homeId === s.box)?.quantity).toBe(1);
    expect(after.find((c) => c.homeId === s.box2)?.quantity).toBe(1);
    expect(after.find((c) => c.homeId === s.binder)?.quantity).toBe(1);
    const stored = await sale(s);
    expect(stored?.items[0]).toMatchObject({ applied: true, cardId: s.cardId, platformCardId: "bsc-1" });
    expect(stored?.items[0].problem).toBeUndefined();
    await expectCountsExact(s.t, OWNER, expect as never);

    // The sale is a box-side change like any other: the hook queued the card.
    const queued = await s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());
    expect(queued.map((r) => r.cardId)).toEqual([s.cardId]);

    // Read again (a re-poll, or a racing one): nothing more comes off.
    const again = await record(s, order(s, { status: "SHIPPED" }));
    expect(again.toApply).toEqual([]);
    // Even a stray apply call for the same line is a no-op.
    await s.t.mutation(internal.listingSales.applySaleItems, { ownerId: OWNER, saleId: again.saleId, indexes: [0] });
    expect(await copies(s)).toEqual(after);
    expect((await sale(s))?.status).toBe("SHIPPED");
    expect((await sale(s))?.items).toHaveLength(1);
  });

  test("the SKU's box wins a tie on the age day", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", acquiredOn: "2026-01-01" });
    await record(s, order(s));
    const after = await copies(s);
    expect(after.find((c) => c.homeId === s.box)).toBeUndefined();
    expect(after.find((c) => c.homeId === s.box2)?.quantity).toBe(1);
    await expectCountsExact(s.t, OWNER, expect as never);
  });

  test("a cancelled order lowers nothing", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    const r = await record(s, order(s, { status: "CANCELLED" }));
    expect(r.toApply).toEqual([]);
    expect((await copies(s))[0].quantity).toBe(1);
    expect((await sale(s))?.items[0].applied).toBe(false);
  });

  test("a cancel after the line was applied is left for the operator, never restored", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await record(s, order(s));
    expect((await copies(s))[0].quantity).toBe(1);
    await record(s, order(s, { status: "CANCELLED" }));
    expect((await copies(s))[0].quantity).toBe(1);
    const stored = await sale(s);
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.items[0].applied).toBe(true);
  });

  test("a status NB does not know is stored and not applied", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    const r = await record(s, order(s, { status: "ON_HOLD" }));
    expect(r.toApply).toEqual([]);
    expect((await copies(s))[0].quantity).toBe(1);
  });

  test("linkMismatch: the SKU's card does not carry the line's BSC id", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await record(s, order(s, { lines: [{ platformCardId: "bsc-somebody-else" }] }));
    expect((await copies(s))[0].quantity).toBe(1);
    expect((await sale(s))?.items[0]).toMatchObject({ applied: false, problem: "linkMismatch", cardId: s.cardId });
  });

  test("unmatched: a SKU that is not NB's (the old platform's) is never applied", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await record(s, order(s, { lines: [{ sellerSku: "303|TB2" }] }));
    expect((await copies(s))[0].quantity).toBe(1);
    expect((await sale(s))?.items[0]).toMatchObject({ applied: false, problem: "unmatched" });
  });

  test("oversold: more sold than NB held takes the copies to 0 and says by how many", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2, acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2026-02-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Excellent", acquiredOn: "2025-01-01" });
    await record(s, order(s, { lines: [{ quantity: 5 }] }));
    const left = await copies(s);
    // Only the Excellent copy (another BSC condition) is left.
    expect(left).toHaveLength(1);
    expect(left[0].condition).toBe("Excellent");
    expect((await sale(s))?.items[0]).toMatchObject({ applied: true, problem: "oversold", shortBy: 2 });
    await expectCountsExact(s.t, OWNER, expect as never);
  });

  test("a vintage line lowers only the NB condition that maps to it", async () => {
    const s = await setup({ year: "1975" });
    await add(s, s.cardId, { homeId: s.box, condition: "Mint", acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", acquiredOn: "2026-02-01" });
    const sku = buildListingSku({ cardId: s.cardId, bscCondition: "nm", boxId: s.box });
    await record(s, order(s, { lines: [{ condition: "nm", sellerSku: sku }] }));
    const left = await copies(s);
    expect(left).toHaveLength(1);
    expect(left[0].condition).toBe("Mint");
  });
});

describe("pollOwner", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "lib", "__fixtures__", "bsc-order-redacted.json"), "utf8"),
  ) as Record<string, unknown> & { orderItems: Array<Record<string, unknown>> };

  function stubCtx(t: T): PollCtx {
    return {
      runQuery: ((ref: never, args: never) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runQuery"],
      runMutation: ((ref: never, args: never) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runMutation"],
      runAction: ((ref: never, args: never) => (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runAction"],
    };
  }

  test("reads new orders back to the cursor, applies them, stores no buyer data and moves the cursor", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    const createdAt = (await s.t.run(async (ctx) => (await ctx.db.query("marketplaceListingStates").first())!._creationTime));
    const sku = buildListingSku({ cardId: s.cardId, bscCondition: "near_mint", boxId: s.box });
    const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
    const newDate = createdAt + 60_000;
    // The real order, re-pointed: line 1 is our card with NB's SKU, line 2
    // keeps the old platform's SKU (unmatched). Plus the buyer keys the
    // projection must drop.
    const detail = {
      ...fixture,
      orderDate: iso(newDate),
      orderStatus: "READY_TO_SHIP",
      buyer: { name: "Someone", email: "x@example.com" },
      shippingAddress: { line1: "1 Main" },
      orderItems: [
        { ...fixture.orderItems[0], cardId: "bsc-1", card: { id: "bsc-1", cardNo: "TB2" }, sellerSku: sku, orderQuantity: 2 },
        fixture.orderItems[1],
      ],
    };
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method} ${href.replace("https://api-prod.buysportscards.com/", "")}`);
      if (href.endsWith("seller/order/history")) {
        return Response.json({
          totalElements: 2,
          results: [
            { orderId: fixture.orderId, orderNo: fixture.orderNo, orderDate: iso(newDate), orderStatus: "READY_TO_SHIP" },
            // Before NB: older than the cursor (creation less the grace).
            { orderId: "old-order", orderNo: "OLD", orderDate: iso(createdAt - 2 * 86_400_000), orderStatus: "SHIPPED" },
          ],
        });
      }
      if (href.endsWith(`seller/order/${fixture.orderId}`)) return Response.json(detail);
      throw new Error(`unexpected ${href}`);
    }) as typeof fetch);

    const report = await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.error).toBeNull();
    expect(calls).toEqual(["POST seller/order/history", `GET seller/order/${fixture.orderId}`]);
    expect((await copies(s))[0].quantity).toBe(1);

    const stored = await sale(s, fixture.orderId as string);
    expect(stored).toMatchObject({ orderNo: fixture.orderNo, status: "READY_TO_SHIP" });
    expect(stored?.items.map((i) => ({ applied: i.applied, problem: i.problem }))).toEqual([
      { applied: true, problem: undefined },
      { applied: false, problem: "unmatched" },
    ]);
    expect(stored?.totals).toEqual({ subtotalCents: 175, shippingCents: 169, feesCents: 0, netCents: 133, totalCents: 344 });
    const json = JSON.stringify(stored);
    for (const pii of ["Someone", "x@example.com", "1 Main", "buyer", "shippingAddress", "stripe"]) {
      expect(json).not.toContain(pii);
    }
    const st = await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").first());
    expect(st?.orderCursorAt).toBe(Date.parse(`${iso(newDate)}Z`));
    expect(st?.lastPolledAt).toBeTypeOf("number");
    expect(st?.lastPollError).toBeUndefined();
    expect(await s.t.run(async (ctx) => (await ctx.db.query("marketplaceSales").collect()).length)).toBe(1);

    // The next poll: nothing new past the cursor, but the stored order is
    // not final, so it is re-read (a later cancel must be seen) and nothing
    // more comes off.
    calls.length = 0;
    await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(calls).toEqual(["POST seller/order/history", `GET seller/order/${fixture.orderId}`]);
    expect((await copies(s))[0].quantity).toBe(1);
  });

  test("listing switched off mid-poll: no sale stored, no copy lowered, no state row recreated", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    const createdAt = (await s.t.run(async (ctx) => (await ctx.db.query("marketplaceListingStates").first())!._creationTime));
    const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
    const sku = buildListingSku({ cardId: s.cardId, bscCondition: "near_mint", boxId: s.box });
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("seller/order/history")) {
        return Response.json({
          totalElements: 1,
          results: [{ orderId: "o-off", orderNo: "OFF", orderDate: iso(createdAt + 1000), orderStatus: "READY_TO_SHIP" }],
        });
      }
      // The collector switches listing off while the detail is in flight.
      await s.t.run(async (ctx) => {
        const row = await ctx.db.query("marketplaceListingStates").first();
        if (row) await ctx.db.delete(row._id);
      });
      return Response.json({
        ...fixture,
        orderId: "o-off",
        orderDate: iso(createdAt + 1000),
        orderStatus: "READY_TO_SHIP",
        orderItems: [{ ...fixture.orderItems[0], cardId: "bsc-1", card: { id: "bsc-1", cardNo: "TB2" }, sellerSku: sku }],
      });
    }) as typeof fetch);

    const report = await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.error).toBeNull();
    expect(report.ordersStored).toBe(0);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("marketplaceSales").collect()).length)).toBe(0);
    expect((await copies(s))[0].quantity).toBe(2);
    expect(await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").collect())).toHaveLength(0);
  });

  test("a failed detail read holds the cursor back", async () => {
    const s = await setup();
    const createdAt = (await s.t.run(async (ctx) => (await ctx.db.query("marketplaceListingStates").first())!._creationTime));
    const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("seller/order/history")) {
        return Response.json({
          totalElements: 1,
          results: [{ orderId: "o-9", orderNo: "N9", orderDate: iso(createdAt + 1000), orderStatus: "READY_TO_SHIP" }],
        });
      }
      return new Response("busy", { status: 503 });
    }) as typeof fetch);
    const report = await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.error).toMatch(/503/);
    const st = await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").first());
    expect(st?.orderCursorAt).toBeUndefined();
    expect(st?.lastPollError).toMatch(/503/);
  });

  test("pollAll schedules one poll per owner listing on BSC", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: "someone_else", platform: "bsc", lastUpdated: NOW });
    });
    // Fake timers: the scheduled polls are inspected, never run (they would
    // reach the network after this test's fetch stub is gone).
    vi.useFakeTimers();
    const r = await s.t.mutation(internal.listingSales.pollAll, {});
    expect(r.scheduled).toBe(2);
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("pollOwner")).map((f) => (f.args[0] as { ownerId: string }).ownerId).sort()).toEqual(
      [OWNER, "someone_else"].sort(),
    );
  });
});

describe("projectBscOrder", () => {
  test("keeps ids, date, status, money and line facts from the real order and nothing else", () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, "lib", "__fixtures__", "bsc-order-redacted.json"), "utf8"),
    );
    const parsed = parseBscOrder(fixture);
    expect(parsed).not.toBeNull();
    const projected = projectBscOrder(parsed!, null);
    expect(Object.keys(projected).sort()).toEqual(["items", "orderDate", "orderId", "orderNo", "status", "totals"]);
    expect(projected.items[0]).toEqual({
      platformCardId: "859115a1371626f4911ba3d70722d757",
      condition: "near_mint",
      quantity: 1,
      priceCents: 25,
      sellerSku: "303|TB2",
      graded: false,
    });
  });
});
