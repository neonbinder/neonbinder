/**
 * NEO-415 — the eBay order poll (`listingSales.ts`, `pollEbaySteps` and
 * `applyEbayLine`): a sale on eBay lowers the collector's box copies exactly
 * once, guarded by NB's own link row for the SKU; a cancelled or refunded
 * order lowers nothing; an order is stored without buyer data; the cursor
 * moves only past a complete read; a sale re-queues every platform.
 *
 * `fetch` is stubbed with eBay's getOrders. The credentials layer is mocked
 * at the identity-less token entry points. No test reaches a live server.
 * convex-test ids carry no Convex checksum, so the SKU parser is relaxed here
 * (`lib/ebayListing.test.ts` pins the real one).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { INITIAL_CURSOR_GRACE_MS, MAX_HISTORY_PAGES, pollOwnerImpl, type PollCtx } from "./listingSales";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { ordersModifiedSinceFilter } from "./lib/ebayListing";

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

vi.mock("./lib/ebayListing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ebayListing")>();
  return {
    ...actual,
    parseEbaySku: (sku: string | null | undefined) => {
      const m = typeof sku === "string" ? /^NB2-([0-9A-Za-z]+)-(NM|EX|VG|PR)$/.exec(sku) : null;
      return m ? { cardId: m[1], conditionCode: m[2] as "NM" | "EX" | "VG" | "PR" } : null;
    },
  };
});

const OWNER = "collector_ebaysales_001";
const ME = { subject: OWNER };
const NOW = 1_700_000_000_000;
const ISO = (ms: number) => new Date(ms).toISOString();

type T = ReturnType<typeof convexTest>;

async function setup(opts: { bsc?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const box2 = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  const inPerson = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "In person" })).containerId;
  await me.mutation(api.collectionContainers.setContainerListed, { containerId: inPerson, listed: false });
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "Binder" })).containerId;
  const { cardId, otherCardId } = await t.run(async (ctx) => {
    const row = (level: string, value: string, parentId?: Id<"selectorOptions">) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: {},
        isCustom: false,
        children: [],
        ...(parentId ? { parentId } : {}),
        lastUpdated: NOW,
      } as never);
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2021", sport);
    const set = await row("setName", "Topps", year);
    const variant = await row("variantType", "Base", set);
    const card = (n: string, bscRef?: string) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variant,
        cardNumber: n,
        cardName: `Player ${n}`,
        listingTitle: `Card ${n}`,
        sportId: sport,
        platformData: bscRef ? { bsc: { ref: bscRef, src: "b0" } } : {},
        sortOrder: 0,
        lastUpdated: NOW,
      } as never);
    return { cardId: await card("1", opts.bsc ? "bsc-1" : undefined), otherCardId: await card("2") };
  });
  return { t, me, box, box2, inPerson, binder, cardId, otherCardId };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Starts listing on eBay (after the copies are added, so the add gate does not apply). */
async function startEbay(s: S, extra: { bsc?: boolean } = {}) {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    if (extra.bsc) {
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
    }
    await ctx.db.insert("userProfiles", {
      userId: OWNER,
      siteCredentials: [
        { site: "ebay", hasCredentials: true },
        ...(extra.bsc ? [{ site: "buysportscards", hasCredentials: true }] : []),
      ],
    } as never);
  });
}

const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });

const copies = (s: S, cardId: Id<"cardChecklist"> = s.cardId) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect())
      .filter((r) => r.cardId === cardId)
      .map((r) => ({ homeId: r.homeId, quantity: r.quantity, condition: r.condition })),
  );
const totalQty = async (s: S, cardId?: Id<"cardChecklist">) => (await copies(s, cardId)).reduce((n, c) => n + c.quantity, 0);

/** NB's link row for a listing the collector has live. */
async function link(
  s: S,
  cardId: Id<"cardChecklist">,
  code: string,
  listingId: string | null = "L1",
  sku?: string,
  previousListingIds?: string[],
) {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingLinks", {
      ownerId: OWNER,
      platform: "ebay",
      cardId,
      conditionCode: code,
      sku: sku ?? `NB2-${cardId}-${code}`,
      offerId: "O1",
      ...(listingId !== null ? { listingId } : {}),
      status: "live",
      ...(previousListingIds ? { previousListingIds } : {}),
      lastUpdated: NOW,
    });
  });
}

interface RawOrder {
  orderId: string;
  lines: Array<{ legacyItemId: string; sku?: string; quantity?: number; cost?: string }>;
  payment?: string;
  fulfillment?: string;
  cancel?: string;
  created?: number;
  modified?: number;
}
function raw(o: RawOrder) {
  return {
    orderId: o.orderId,
    creationDate: ISO(o.created ?? NOW + 1000),
    lastModifiedDate: ISO(o.modified ?? o.created ?? NOW + 1000),
    orderPaymentStatus: o.payment ?? "PAID",
    orderFulfillmentStatus: o.fulfillment ?? "NOT_STARTED",
    ...(o.cancel ? { cancelStatus: { cancelState: o.cancel } } : {}),
    pricingSummary: { priceSubtotal: { value: "10.00" }, deliveryCost: { value: "1.00" }, total: { value: "11.00" } },
    buyer: { username: "buyer-handle-123" },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Hidden Buyer", contactAddress: { addressLine1: "1 Private Rd" } } } }],
    lineItems: o.lines.map((l) => ({
      legacyItemId: l.legacyItemId,
      ...(l.sku !== undefined ? { sku: l.sku } : {}),
      quantity: l.quantity ?? 1,
      lineItemCost: { value: l.cost ?? "10.00" },
    })),
  };
}

let requests: Array<{ filter: string | null; offset: string | null; limit: string | null; auth: string }> = [];
let pages: unknown[][] = [[]];
let failPage: number | null = null;
/** When > 0 every page claims another follows. */
let alwaysMore = false;

function stubOrders() {
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname !== "/sell/fulfillment/v1/order") throw new Error(`unexpected ${u.pathname}`);
    const offset = Number(u.searchParams.get("offset"));
    requests.push({
      filter: u.searchParams.get("filter"),
      offset: u.searchParams.get("offset"),
      limit: u.searchParams.get("limit"),
      auth: ((init?.headers ?? {}) as Record<string, string>).Authorization,
    });
    const index = offset / 100;
    if (failPage === index) return new Response("{}", { status: 500 });
    const orders = pages[index] ?? (alwaysMore ? [] : []);
    const more = alwaysMore || index < pages.length - 1;
    return Response.json({ orders, ...(more ? { next: "https://next" } : {}), total: 1 });
  }) as typeof fetch);
}

function stubCtx(t: T): PollCtx {
  return {
    runQuery: ((ref: never, args: never) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runQuery"],
    runMutation: ((ref: never, args: never) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runMutation"],
    runAction: ((ref: never, args: never) => (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as PollCtx["runAction"],
  };
}
const poll = (s: S) => pollOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "ebay" });
const sales = (s: S) => s.t.run(async (ctx) => await ctx.db.query("marketplaceSales").collect());
const state = (s: S) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", OWNER).eq("platform", "ebay"))
      .unique(),
  );

beforeEach(() => {
  requests = [];
  pages = [[]];
  failPage = null;
  alwaysMore = false;
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  stubOrders();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SKU = (s: S, code = "NM", cardId: Id<"cardChecklist"> = s.cardId) => `NB2-${cardId}-${code}`;

describe("an eBay sale lowers NB's copies", () => {
  test("a paid order lowers the oldest matching box copy once, stores unit price and the bucket, and no buyer data", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box2, condition: "Near Mint", acquiredOn: "2026-03-01" });
    await add(s, s.cardId, { homeId: s.box, condition: "Mint", quantity: 2, acquiredOn: "2026-01-01" });
    await add(s, s.cardId, { homeId: s.binder, condition: "Near Mint", acquiredOn: "2025-01-01" });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s), quantity: 2, cost: "30.00" }] })]];

    const report = await poll(s);

    expect(report).toMatchObject({ ordersRead: 1, ordersStored: 1, linesApplied: 1, error: null });
    expect(requests[0]).toMatchObject({ limit: "100", offset: "0", auth: "Bearer tok-1" });
    // Oldest (Mint x2 in Box A) goes first; the binder copy is never for sale.
    expect(await copies(s)).toEqual(
      expect.arrayContaining([
        { homeId: s.box2, quantity: 1, condition: "Near Mint" },
        { homeId: s.binder, quantity: 1, condition: "Near Mint" },
      ]),
    );
    expect(await totalQty(s)).toBe(2);
    const [stored] = await sales(s);
    expect(stored).toMatchObject({ platform: "ebay", orderId: "ORD-1", orderNo: "ORD-1", status: "NOT_STARTED" });
    expect(stored.totals).toEqual({ subtotalCents: 1000, shippingCents: 100, totalCents: 1100 });
    expect(stored.items).toEqual([
      expect.objectContaining({ platformCardId: "L1", condition: "NM", quantity: 2, priceCents: 1500, applied: true, cardId: s.cardId }),
    ]);
    const json = JSON.stringify(stored);
    for (const pii of ["buyer-handle-123", "Hidden Buyer", "1 Private Rd"]) expect(json).not.toContain(pii);
  });

  test("polling the same order again lowers nothing more", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    await poll(s);
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    expect(await sales(s)).toHaveLength(1);
  });

  test("the bucket decides which NB conditions come off: a Very Good bucket sale takes a Good copy, never a Near Mint one", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.box, condition: "Good" });
    await startEbay(s);
    await link(s, s.cardId, "VG");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s, "VG") }] })]];
    await poll(s);
    expect(await copies(s)).toEqual([{ homeId: s.box, quantity: 1, condition: "Near Mint" }]);
  });

  test("a sale beyond what NB holds lowers what it can and records oversold with the shortfall", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s), quantity: 3 }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(0);
    const [stored] = await sales(s);
    expect(stored.items[0]).toMatchObject({ applied: true, problem: "oversold", shortBy: 2 });
  });

  test("a card whose only copy sits in an in-person box, a binder, or is graded is oversold, and nothing is touched", async () => {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.inPerson, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.binder, condition: "Near Mint" });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint" });
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("collectionCopies").collect()).find((c) => c.homeId === s.box)!;
      await ctx.db.patch(row._id, { grading: { grader: "PSA", grade: "9" } } as never);
    });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(3);
    expect((await sales(s))[0].items[0]).toMatchObject({ problem: "oversold", shortBy: 1 });
  });
});

describe("the exactly-one guard", () => {
  async function oneListed() {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await startEbay(s);
    return s;
  }

  test("a line whose eBay item id is not the one NB's link row holds is refused, lowering nothing", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM", "L1");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "SOMEONE-ELSES", sku: SKU(s) }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    expect((await sales(s))[0].items[0]).toMatchObject({ applied: false, problem: "linkMismatch", cardId: s.cardId });
  });

  test("a late sale on the listing a republish replaced still routes; an id the link never held does not", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM", "L-NEW", undefined, ["L-OLD"]);
    pages = [
      [
        raw({ orderId: "LATE", lines: [{ legacyItemId: "L-OLD", sku: SKU(s) }] }),
        raw({ orderId: "STRANGER", lines: [{ legacyItemId: "L-NEVER", sku: SKU(s) }] }),
      ],
    ];
    await poll(s);
    expect(await totalQty(s)).toBe(1);
    const byOrder = new Map((await sales(s)).map((x) => [x.orderId, x]));
    expect(byOrder.get("LATE")?.items[0]).toMatchObject({ applied: true });
    expect(byOrder.get("STRANGER")?.items[0]).toMatchObject({ applied: false, problem: "linkMismatch" });
  });

  test("a SKU with no link row is refused", async () => {
    const s = await oneListed();
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    expect((await sales(s))[0].items[0].problem).toBe("linkMismatch");
  });

  test("a link row with no listing id (never published) never matches", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM", null);
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
  });

  test("a link row that points at a different card than the SKU names is refused", async () => {
    const s = await oneListed();
    await link(s, s.otherCardId, "NM", "L1", SKU(s));
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    expect((await sales(s))[0].items[0].problem).toBe("linkMismatch");
  });

  test("a SKU naming a card that no longer exists is unmatched", async () => {
    const s = await oneListed();
    await link(s, s.otherCardId, "NM", "L1");
    await s.t.run(async (ctx) => {
      await ctx.db.delete(s.otherCardId);
    });
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s, "NM", s.otherCardId) }] })]];
    await poll(s);
    expect((await sales(s))[0].items[0]).toMatchObject({ applied: false, problem: "unmatched" });
  });

  test("a line whose SKU is not NB's is skipped, and an order of only such lines is not stored", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM");
    pages = [
      [
        raw({ orderId: "FOREIGN", lines: [{ legacyItemId: "X1", sku: "MY-OWN-SKU" }, { legacyItemId: "X2" }] }),
        raw({ orderId: "MIXED", lines: [{ legacyItemId: "X1", sku: "MY-OWN-SKU" }, { legacyItemId: "L1", sku: SKU(s) }] }),
      ],
    ];
    const report = await poll(s);
    expect(report).toMatchObject({ ordersRead: 2, ordersStored: 1 });
    const stored = await sales(s);
    expect(stored.map((x) => x.orderId)).toEqual(["MIXED"]);
    expect(stored[0].items).toHaveLength(1);
    expect(await totalQty(s)).toBe(1);
  });

  test("two link rows for one SKU refuse the line instead of failing the poll", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM", "L1");
    await link(s, s.cardId, "NM", "L1", SKU(s));
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    const report = await poll(s);
    expect(report.error).toBeNull();
    expect(await totalQty(s)).toBe(2);
    expect((await sales(s))[0].items[0].problem).toBe("linkMismatch");
  });
});

describe("cancelled, refunded and unpaid orders", () => {
  async function listed() {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    return s;
  }
  const line = (s: S) => [{ legacyItemId: "L1", sku: SKU(s) }];

  test.each([
    ["cancelled", { cancel: "CANCELED" }, "CANCELED"],
    ["fully refunded", { payment: "FULLY_REFUNDED" }, "FULLY_REFUNDED"],
  ])("an order %s is stored but lowers nothing", async (_label, over, status) => {
    const s = await listed();
    pages = [[raw({ orderId: "ORD-1", lines: line(s), ...over })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    expect((await sales(s))[0]).toMatchObject({ status });
    expect((await sales(s))[0].items[0].applied).toBe(false);
  });

  test("an unpaid order waits; once it is paid the same order lowers the copy", async () => {
    const s = await listed();
    pages = [[raw({ orderId: "ORD-1", lines: line(s), payment: "PENDING" })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    pages = [[raw({ orderId: "ORD-1", lines: line(s), payment: "PAID", modified: NOW + 5000 })]];
    await poll(s);
    expect(await totalQty(s)).toBe(1);
    expect(await sales(s)).toHaveLength(1);
  });

  test("a partial refund leaves the sale standing", async () => {
    const s = await listed();
    pages = [[raw({ orderId: "ORD-1", lines: line(s), payment: "PARTIALLY_REFUNDED" })]];
    await poll(s);
    expect(await totalQty(s)).toBe(1);
  });

  test("an order cancelled after it was applied does not put the copy back", async () => {
    const s = await listed();
    pages = [[raw({ orderId: "ORD-1", lines: line(s) })]];
    await poll(s);
    pages = [[raw({ orderId: "ORD-1", lines: line(s), cancel: "CANCELED", modified: NOW + 9000 })]];
    await poll(s);
    expect(await totalQty(s)).toBe(1);
    expect((await sales(s))[0].status).toBe("CANCELED");
    expect((await sales(s))[0].items[0].applied).toBe(true);
  });
});

describe("paging and the cursor", () => {
  async function listed() {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 10 });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    return s;
  }
  const order = (s: S, id: string, modified: number) => raw({ orderId: id, modified, created: modified - 10, lines: [{ legacyItemId: "L1", sku: SKU(s) }] });

  test("asks for orders modified since the cursor, reads every page, and moves the cursor to the newest modification", async () => {
    const s = await listed();
    const created = Math.floor((await state(s))!._creationTime);
    const cursor = (await state(s))!._creationTime - INITIAL_CURSOR_GRACE_MS;
    pages = [[order(s, "A", created + 100)], [order(s, "B", created + 900)], [order(s, "C", created + 500)]];
    const report = await poll(s);
    expect(requests.map((r) => r.offset)).toEqual(["0", "100", "200"]);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(cursor));
    expect(report.ordersStored).toBe(3);
    expect(await totalQty(s)).toBe(7);
    expect((await state(s))?.orderCursorAt).toBe(created + 900);
    expect((await state(s))?.lastPollError).toBeUndefined();

    // The next poll filters from the new cursor.
    requests = [];
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(created + 900));
  });

  test("a page that fails keeps the cursor where it was, reports the error, and keeps what page one applied", async () => {
    const s = await listed();
    const before = (await state(s))?.orderCursorAt;
    pages = [[order(s, "A", NOW + 100)], [order(s, "B", NOW + 200)]];
    failPage = 1;
    const report = await poll(s);
    // eBay's 500 is said in NB's words; the status lives in the structured log only.
    expect(report.error).toBe("eBay's not answering right now. Try again in a bit.");
    expect((await state(s))?.orderCursorAt).toBe(before);
    expect((await state(s))?.lastPollError).toBeTypeOf("string");
    expect(await totalQty(s)).toBe(9);
    // Retry succeeds; order A is not lowered twice.
    failPage = null;
    await poll(s);
    expect(await totalQty(s)).toBe(8);
  });

  test("a read that never ends within the page limit does not move the cursor", async () => {
    const s = await listed();
    const before = (await state(s))?.orderCursorAt;
    pages = [[order(s, "A", NOW + 100)]];
    alwaysMore = true;
    await poll(s);
    expect(requests).toHaveLength(MAX_HISTORY_PAGES);
    expect((await state(s))?.orderCursorAt).toBe(before);
  });

  test("an order eBay sends malformed is skipped with a note while the rest apply", async () => {
    const s = await listed();
    pages = [[{ orderId: 5, nonsense: true }, order(s, "OK", NOW + 100)]];
    const report = await poll(s);
    expect(report.error).toMatch(/couldn't be read/);
    expect(report.ordersStored).toBe(1);
    expect(await totalQty(s)).toBe(9);
  });

  test("an unconnected eBay (no token) fails the poll with a sentence and no write", async () => {
    const s = await listed();
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { siteCredentials: [] } as never);
    });
    const report = await poll(s);
    expect(report).toMatchObject({ ordersRead: 0 });
    expect(requests).toEqual([]);
  });

  test("a deployment not wired to eBay polls nothing", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const s = await listed();
    pages = [[order(s, "A", NOW + 100)]];
    const report = await poll(s);
    expect(report.ordersStored).toBe(0);
    expect(requests).toEqual([]);
  });
});

describe("a sale re-queues every platform", () => {
  test("lowering a copy on eBay queues the card for eBay and for BuySportsCards", async () => {
    const s = await setup({ bsc: true });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await startEbay(s, { bsc: true });
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];

    await poll(s);

    const rows = await s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());
    expect(rows.filter((r) => r.cardId === s.cardId).map((r) => r.platform).sort()).toEqual(["bsc", "ebay"]);
    await drainScheduled(s.t);
  });

  test("a card with no BSC id is queued for eBay only (eBay carries every catalog card)", async () => {
    const s = await setup({ bsc: false });
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 2 });
    await startEbay(s, { bsc: true });
    await link(s, s.cardId, "NM");
    pages = [[raw({ orderId: "ORD-1", lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    await poll(s);
    const rows = await s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());
    expect(rows.map((r) => r.platform)).toEqual(["ebay"]);
    await drainScheduled(s.t);
  });
});

describe("the cron fan-out", () => {
  test("pollAll schedules an eBay owner's poll when eBay is wired, and none when it is not or is paused", async () => {
    const s = await setup();
    await startEbay(s);
    const scheduledPolls = async () =>
      (await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
        (f) => f.name.includes("pollOwner") && f.state.kind === "pending",
      ).length;

    vi.stubEnv("EBAY_ENVIRONMENT", "");
    expect(await s.t.mutation(internal.listingSales.pollAll, {})).toEqual({ scheduled: 0, skipped: 0 });
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    expect(await s.t.mutation(internal.listingSales.pollAll, {})).toEqual({ scheduled: 0, skipped: 0 });
    expect(await scheduledPolls()).toBe(0);

    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
    expect(await s.t.mutation(internal.listingSales.pollAll, {})).toEqual({ scheduled: 1, skipped: 0 });
    await drainScheduled(s.t);
  });
});
