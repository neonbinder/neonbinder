/**
 * NEO-370 — the order poll (`listingSales.ts`): a sale on BSC lowers the
 * collector's box copies exactly once, through the app's own write path.
 *
 * The apply tests drive `recordOrder` + `applySaleItems` directly; the poll
 * test stubs `fetch` with BSC's order history and the redacted real order
 * (`lib/__fixtures__/bsc-order-redacted.json`), re-pointed at this test's
 * card. The credentials layer is mocked at the identity-less entry points.
 * No test reaches a live server.
 *
 * NEO-370 Revision 5: the poll takes the same rule as pushing (a saved,
 * unpaused sign-in is listing): a row held off by the E2E test marker polls
 * nothing, nothing at all is read while BSC is paused, and not a dormant row
 * or an owner with no credentials either; each tick starts the pass over
 * sign-ins saved before Revision 5;
 * an owner needing a fresh sign-in is polled at most hourly; a poll that
 * throws still finishes (stamped, drain kicked); a sale that removes a copy
 * keeps its photos.
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
import {
  POLL_STAGGER_MS,
  pollOwnerImpl,
  pollStaggerMs,
  projectBscOrder,
  REAUTH_POLL_INTERVAL_MS,
  type PollCtx,
  type ProjectedOrder,
} from "./listingSales";
import { parseBscOrder } from "./lib/bscOrders";
import { priceEveryVariant } from "../lib/testing/common-prices";
import { SAVED_SIGN_INS_PASS_KEY } from "./listingSync";

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
  // NEO-370: a syncing collector's box adds need a price (`listingGate`).
  await priceEveryVariant(t, OWNER);
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

  test("a sale that removes the last copy keeps its photos; a manual remove detaches them as before", async () => {
    const s = await setup();
    const photo = async (copyId: Id<"collectionCopies">, side: "front" | "back") => {
      const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
        ownerId: OWNER,
        copyId,
        side,
        contentType: "image/jpeg",
        imageBytes: 300_000,
        thumbBytes: 20_000,
      });
      await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: OWNER, photoId });
      return photoId;
    };
    const sold = (await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" })).copyId as Id<"collectionCopies">;
    const front = await photo(sold, "front");
    const back = await photo(sold, "back");
    const kept = (await add(s, s.otherCardId, { homeId: s.box, condition: "Near Mint" })).copyId as Id<"collectionCopies">;
    const keptPhoto = await photo(kept, "front");

    await record(s, order(s));
    // The copy is gone; its photo rows stay, live, pointing at it.
    expect(await copies(s)).toEqual([]);
    const rows = await s.t.run(async (ctx) => await ctx.db.query("collectionCopyPhotos").collect());
    expect(rows.filter((r) => r.copyId === sold).map((r) => [r._id, r.status]).sort()).toEqual(
      [[front, "live"], [back, "live"]].sort(),
    );
    // No delete of their files was scheduled.
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("deleteObjects"))).toEqual([]);

    // A manual remove keeps today's behaviour: the photo is detached for the
    // Undo, and the hourly sweep deletes it.
    await s.me.mutation(api.collection.removeCopy, { copyId: kept });
    const after = await s.t.run(async (ctx) => await ctx.db.get(keptPhoto));
    expect(after?.status).toBe("detached");

    // The per-user test reset clears the orphaned photo rows with the rest.
    process.env.TESTING_RESET_SECRET = "test-enabled";
    try {
      await s.me.mutation(api.testing.resetMyTestState, {});
    } finally {
      delete process.env.TESTING_RESET_SECRET;
    }
    expect(await s.t.run(async (ctx) => await ctx.db.query("collectionCopyPhotos").collect())).toEqual([]);
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

  test("an in-person box's copy is never sold off, unless the SKU names that box", async () => {
    const s = await setup();
    // box2 is in person: its older copy stays; the SKU's (listed) box loses one.
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box2, listed: false });
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2025-01-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2, acquiredOn: "2026-01-01" });
    await record(s, order(s));
    let after = await copies(s);
    expect(after.find((c) => c.homeId === s.box2)?.quantity).toBe(1);
    expect(after.find((c) => c.homeId === s.box)?.quantity).toBe(1);

    // The SKU's own box made in person after the listing went up: a sale
    // through that listing still lowers it (the copy sold is the one listed).
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    await record(s, order(s, { orderId: "order-2", orderNo: "NO-2" }));
    after = await copies(s);
    expect(after.find((c) => c.homeId === s.box)).toBeUndefined();
    expect(after.find((c) => c.homeId === s.box2)?.quantity).toBe(1);

    // No listed box and not the SKU's box: nothing to lower, the line says so.
    const sku2 = buildListingSku({ cardId: s.cardId, bscCondition: "near_mint", boxId: s.box });
    const third = await record(s, order(s, { orderId: "order-3", orderNo: "NO-3", lines: [{ sellerSku: sku2 }] }));
    expect(third.toApply).toHaveLength(1);
    expect((await copies(s)).find((c) => c.homeId === s.box2)?.quantity).toBe(1);
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

  test("the row put to sleep mid-poll (credentials cleared): no sale stored, no copy lowered", async () => {
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
      // The collector clears their BSC credentials while the detail is in flight.
      await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: OWNER, site: "buysportscards" });
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
    const states = await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").collect());
    expect(states).toHaveLength(1);
    expect(states[0].dormant).toBe("noCredentials");
  });

  test("a sign-in saved but listing not started polls nothing: no order read, no sale stored, no copy lowered", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { listingStartedAt: undefined });
    });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return Response.json({ totalElements: 0, results: [] });
    }) as typeof fetch);
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const report = await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report.ordersStored).toBe(0);
    expect(report.linesApplied).toBe(0);
    expect(fetched).toEqual([]);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("marketplaceSales").collect()).length)).toBe(0);
    expect((await copies(s))[0].quantity).toBe(2);
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("drainOwner"))).toEqual([]);
  });

  test("a sale recorded for an owner who is not started is neither stored nor applied (the write-side gate)", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { listingStartedAt: undefined });
    });
    const sku = buildListingSku({ cardId: s.cardId, bscCondition: "near_mint", boxId: s.box });
    const order: ProjectedOrder = {
      orderId: "o-unstarted",
      orderNo: "UNSTARTED",
      orderDate: NOW,
      status: "READY_TO_SHIP",
      totals: {},
      items: [{ platformCardId: "bsc-1", condition: "near_mint", quantity: 1, priceCents: 100, sellerSku: sku, graded: false }],
    };
    const r = await s.t.mutation(internal.listingSales.recordOrder, { ownerId: OWNER, platform: "bsc", order });
    expect(r.saleId).toBeNull();
    expect(await s.t.run(async (ctx) => (await ctx.db.query("marketplaceSales").collect()).length)).toBe(0);
    expect((await copies(s))[0].quantity).toBe(2);
  });

  test("a poll that throws part-way still finishes: stamped, error recorded, drain kicked", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    // A queued change, so the finish has a drain to kick.
    await s.t.run(async (ctx) => {
      const card = await ctx.db.get(s.cardId);
      await ctx.db.insert("listingOutbox", {
        ownerId: OWNER,
        platform: "bsc",
        cardId: s.cardId,
        variantId: card!.selectorOptionId,
        seq: 1,
        changedAt: NOW,
      });
    });
    const createdAt = (await s.t.run(async (ctx) => (await ctx.db.query("marketplaceListingStates").first())!._creationTime));
    const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("seller/order/history")) {
        return Response.json({
          totalElements: 1,
          results: [{ orderId: "o-boom", orderNo: "BOOM", orderDate: iso(createdAt + 1000), orderStatus: "READY_TO_SHIP" }],
        });
      }
      return Response.json({ ...fixture, orderId: "o-boom", orderDate: iso(createdAt + 1000), orderStatus: "READY_TO_SHIP" });
    }) as typeof fetch);
    const base = stubCtx(s.t);
    const ctx: PollCtx = {
      ...base,
      runMutation: (async (ref: unknown, args: unknown) => {
        if (JSON.stringify(args).includes("o-boom") && !JSON.stringify(args).includes("error")) {
          throw new Error("recordOrder blew up");
        }
        return (base.runMutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args);
      }) as PollCtx["runMutation"],
    };
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    await expect(pollOwnerImpl(ctx, { ownerId: OWNER, platform: "bsc" })).rejects.toThrow(/blew up/);

    const st = await s.t.run(async (ctx2) => await ctx2.db.query("marketplaceListingStates").first());
    expect(st?.lastPolledAt).toBeTypeOf("number");
    expect(st?.lastPollError).toMatch(/stopped part-way/);
    expect(st?.orderCursorAt).toBeUndefined();
    expect(st?.drainScheduledAt).toBeTypeOf("number");
    const scheduled = await s.t.run(async (ctx2) => ctx2.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("drainOwner"))).toHaveLength(1);
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

  test("pollAll schedules one poll per LISTING owner and one saved-sign-in pass; the test marker's row is stamped to the back, never polled", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "someone_else",
        platform: "bsc",
        listingStartedAt: NOW,
        lastUpdated: NOW,
      });
      await ctx.db.insert("userProfiles", {
        userId: "someone_else",
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never);
      // Signed in by the testing seed without listing (the E2E test marker).
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "not_started",
        platform: "bsc",
        testListingOff: true,
        lastUpdated: NOW,
      });
      await ctx.db.insert("userProfiles", {
        userId: "not_started",
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never);
    });
    // Fake timers: the scheduled polls are inspected, never run (they would
    // reach the network after this test's fetch stub is gone).
    vi.useFakeTimers();
    const r = await s.t.mutation(internal.listingSales.pollAll, {});
    expect(r).toEqual({ scheduled: 2, skipped: 1 });
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("pollOwner")).map((f) => (f.args[0] as { ownerId: string }).ownerId).sort()).toEqual(
      [OWNER, "someone_else"].sort(),
    );
    const notStarted = await s.t.run(async (ctx) =>
      (await ctx.db.query("marketplaceListingStates").collect()).find((row) => row.ownerId === "not_started"),
    );
    // Moved to the back of the read, still not dormant.
    expect(notStarted?.lastPolledAt).toBeTypeOf("number");
    expect(notStarted?.dormant).toBeUndefined();
    expect(scheduled.filter((f) => f.name.includes("setUpSavedSignInsPage")).map((f) => f.args[0])).toEqual([
      { cursor: null },
    ]);
  });

  test("pollAll starts the saved-sign-in pass only until it is done, and never on a testing deployment", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const passes = async () =>
      (await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f) =>
        f.name.includes("setUpSavedSignInsPage"),
      ).length;
    process.env.TESTING_RESET_SECRET = "test-enabled";
    try {
      await s.t.mutation(internal.listingSales.pollAll, {});
    } finally {
      delete process.env.TESTING_RESET_SECRET;
    }
    expect(await passes()).toBe(0);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("listingBackfillState", { key: SAVED_SIGN_INS_PASS_KEY, doneAt: NOW });
    });
    await s.t.mutation(internal.listingSales.pollAll, {});
    expect(await passes()).toBe(0);
  });

  test("pollAll while NB has paused BuySportsCards: reads and writes nothing, schedules nothing", async () => {
    const s = await setup();
    const before = await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").collect());
    const prior = process.env.NEONBINDER_PAUSED_PLATFORMS;
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      expect(await s.t.mutation(internal.listingSales.pollAll, {})).toEqual({ scheduled: 0, skipped: 0 });
    } finally {
      if (prior === undefined) delete process.env.NEONBINDER_PAUSED_PLATFORMS;
      else process.env.NEONBINDER_PAUSED_PLATFORMS = prior;
    }
    expect(await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").collect())).toEqual(before);
    expect(await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test("pollAll: no credentials puts the row to sleep; a dormant row is never read; re-sign-in waits an hour", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      // No credentials saved at all.
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "no_creds",
        platform: "bsc",
        listingStartedAt: NOW,
        lastUpdated: NOW,
      });
      // Already dormant (a seller conflict): skipped by the index itself.
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "conflicted",
        platform: "bsc",
        listingStartedAt: NOW,
        dormant: "sellerConflict",
        lastUpdated: NOW,
      });
      await ctx.db.insert("userProfiles", {
        userId: "conflicted",
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never);
      // Needs a fresh sign-in, last tried 10 minutes ago.
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "reauth_recent",
        platform: "bsc",
        listingStartedAt: NOW,
        reauthPollAt: Date.now() - 10 * 60_000,
        lastUpdated: NOW,
      });
      await ctx.db.insert("userProfiles", {
        userId: "reauth_recent",
        siteCredentials: [{ site: "buysportscards", hasCredentials: true, needsReauth: true }],
      } as never);
      // Needs a fresh sign-in, last tried over an hour ago.
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "reauth_due",
        platform: "bsc",
        listingStartedAt: NOW,
        reauthPollAt: Date.now() - REAUTH_POLL_INTERVAL_MS - 1,
        lastUpdated: NOW,
      });
      await ctx.db.insert("userProfiles", {
        userId: "reauth_due",
        siteCredentials: [{ site: "buysportscards", hasCredentials: true, needsReauth: true }],
      } as never);
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = await s.t.mutation(internal.listingSales.pollAll, {});
    expect(r).toEqual({ scheduled: 2, skipped: 2 });
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(
      scheduled.filter((f) => f.name.includes("pollOwner")).map((f) => (f.args[0] as { ownerId: string }).ownerId).sort(),
    ).toEqual([OWNER, "reauth_due"].sort());
    const byOwner = new Map(
      (await s.t.run(async (ctx) => await ctx.db.query("marketplaceListingStates").collect())).map((row) => [row.ownerId, row]),
    );
    expect(byOwner.get("no_creds")?.dormant).toBe("noCredentials");
    expect(byOwner.get("conflicted")?.lastPolledAt).toBeUndefined();
    // Waiting out the hour: stamped so it moves to the back, not polled.
    expect(byOwner.get("reauth_recent")?.lastPolledAt).toBeTypeOf("number");
    // Due: its re-sign-in attempt is stamped now.
    expect(byOwner.get("reauth_due")?.reauthPollAt).toBeGreaterThan(Date.now() - 60_000);

    // A second tick: the dormant row stays out of the read, and nothing new is due.
    const again = await s.t.mutation(internal.listingSales.pollAll, {});
    expect(again.scheduled).toBe(1);
  });

  test("the stagger spreads one tick's polls inside the 15-minute window", () => {
    expect(pollStaggerMs(1)).toBe(POLL_STAGGER_MS);
    expect(pollStaggerMs(100)).toBe(POLL_STAGGER_MS);
    expect(pollStaggerMs(500)).toBe(Math.floor((14 * 60 * 1000) / 500));
    expect(499 * pollStaggerMs(500)).toBeLessThan(15 * 60 * 1000);
  });

  test("pollOwner for an owner with no credentials reads nothing", async () => {
    const s = await setup();
    await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: OWNER, site: "buysportscards" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const report = await pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.ordersRead).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
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
