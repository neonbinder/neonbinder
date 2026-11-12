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
import {
  EBAY_OTHER_ORDERS_FLOOR_MS,
  INITIAL_CURSOR_GRACE_MS,
  MAX_HISTORY_PAGES,
  ORDER_READ_VERSION,
  ebayOrdersFloor,
  pollOwnerImpl,
  projectEbayOrderForRecord,
  type PollCtx,
} from "./listingSales";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { LISTED_TITLE_MAX, ordersModifiedSinceFilter, projectEbayOrder } from "./lib/ebayListing";

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
async function startEbay(s: S, extra: { bsc?: boolean; readVersion?: number | null } = {}) {
  // NEO-520: a row already read under the current version (no catch-up rewind), unless a test says otherwise.
  const readVersion = extra.readVersion === undefined ? ORDER_READ_VERSION.ebay : extra.readVersion;
  await s.t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: OWNER,
      platform: "ebay",
      listingStartedAt: NOW,
      lastUpdated: NOW,
      ...(readVersion !== null ? { ordersReadVersion: readVersion } : {}),
    });
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
  lines: Array<{ legacyItemId: string; sku?: string; quantity?: number; cost?: string; title?: string }>;
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
      ...(l.title !== undefined ? { title: l.title } : {}),
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

  test("a line whose SKU is not NB's is stored and refused as unmatched; a mixed order lowers only NB's line; a no-SKU line is stored too", async () => {
    const s = await oneListed();
    await link(s, s.cardId, "NM");
    const created = EBAY_OTHER_ORDERS_FLOOR_MS + 1000;
    pages = [
      [
        raw({ orderId: "FOREIGN", created, lines: [{ legacyItemId: "X1", sku: "MY-OWN-SKU", title: "Vintage lot" }, { legacyItemId: "X2" }] }),
        raw({ orderId: "MIXED", created, lines: [{ legacyItemId: "X1", sku: "MY-OWN-SKU" }, { legacyItemId: "L1", sku: SKU(s) }] }),
      ],
    ];
    const report = await poll(s);
    expect(report).toMatchObject({ ordersRead: 2, ordersStored: 2, linesApplied: 1 });
    const byOrder = new Map((await sales(s)).map((x) => [x.orderId, x]));
    expect(byOrder.get("FOREIGN")!.items).toEqual([
      expect.objectContaining({ platformCardId: "X1", condition: "", sellerSku: "MY-OWN-SKU", applied: false, problem: "unmatched", listed: { title: "Vintage lot" } }),
      expect.objectContaining({ platformCardId: "X2", condition: "", applied: false, problem: "unmatched" }),
    ]);
    expect(byOrder.get("FOREIGN")!.items[1].sellerSku).toBeUndefined();
    expect(byOrder.get("FOREIGN")!.items[1].cardId).toBeUndefined();
    const mixed = byOrder.get("MIXED")!.items;
    expect(mixed[0]).toMatchObject({ applied: false, problem: "unmatched" });
    expect(mixed[1]).toMatchObject({ applied: true, cardId: s.cardId });
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

// ── NEO-520: every eBay line is stored; non-NB lines are refused as unmatched ──

const F = EBAY_OTHER_ORDERS_FLOOR_MS;
const DAY = 24 * 60 * 60 * 1000;
const OTHER = (n = 1, title?: string) => ({ legacyItemId: `X${n}`, sku: `MY-OWN-${n}`, ...(title !== undefined ? { title } : {}) });
const projected = (o: RawOrder) => {
  const p = projectEbayOrder(raw(o));
  if (!p) throw new Error("fixture order did not project");
  return p;
};

describe("the floor and the read version (NEO-520)", () => {
  test("the NEO-520 floor is 2026-11-11 00:00 US Central", () => {
    expect(EBAY_OTHER_ORDERS_FLOOR_MS).toBe(Date.UTC(2026, 10, 11, 6, 0, 0));
  });

  test("the floor is the earlier of the state row's creation and the fixed floor", () => {
    expect(ebayOrdersFloor(F + 5 * DAY)).toBe(F);
    expect(ebayOrdersFloor(F - 5 * DAY)).toBe(F - 5 * DAY);
    expect(ebayOrdersFloor(F)).toBe(F);
  });

  test("eBay's order read is version 2 and BuySportsCards' stays at 1", () => {
    expect(ORDER_READ_VERSION).toEqual({ bsc: 1, ebay: 2 });
  });
});

describe("projectEbayOrderForRecord (NEO-520)", () => {
  const NB = { legacyItemId: "L1", sku: "NB2-abc-NM", title: "NB's own listing title" };

  test("an NB-SKU line keeps its bucket, SKU and unit price and carries the title; a foreign line stores an empty condition", () => {
    const out = projectEbayOrderForRecord(
      projected({ orderId: "O", created: F + 1, lines: [{ ...NB, quantity: 2, cost: "9.00" }, { ...OTHER(1, "Vintage lot"), quantity: 3, cost: "6.00" }] }),
      { ordersFrom: F },
    );
    expect(out?.items).toEqual([
      { platformCardId: "L1", condition: "NM", quantity: 2, priceCents: 450, sellerSku: "NB2-abc-NM", graded: false, listed: { title: "NB's own listing title" } },
      { platformCardId: "X1", condition: "", quantity: 3, priceCents: 200, sellerSku: "MY-OWN-1", graded: false, listed: { title: "Vintage lot" } },
    ]);
  });

  test("a line eBay sent with no SKU and no title stores neither sellerSku nor listed", () => {
    const out = projectEbayOrderForRecord(projected({ orderId: "O", created: F + 1, lines: [{ legacyItemId: "X9" }] }), { ordersFrom: F });
    expect(out?.items).toEqual([{ platformCardId: "X9", condition: "", quantity: 1, priceCents: 1000, graded: false }]);
    expect("sellerSku" in out!.items[0]).toBe(false);
    expect("listed" in out!.items[0]).toBe(false);
  });

  test("an order with no readable line is null", () => {
    const empty = { ...projected({ orderId: "O", created: F + 1, lines: [OTHER()] }), lines: [] };
    expect(projectEbayOrderForRecord(empty, { ordersFrom: null })).toBeNull();
  });

  test("an order of foreign lines placed before the floor is dropped; one millisecond later or exactly at it is kept", () => {
    const at = (created: number) => projectEbayOrderForRecord(projected({ orderId: "O", created, lines: [OTHER()] }), { ordersFrom: F });
    expect(at(F - 1)).toBeNull();
    expect(at(F)).not.toBeNull();
    expect(at(F + 1)).not.toBeNull();
  });

  test("an order with an NB line is kept whatever its date, even years before the floor", () => {
    const old = projectEbayOrderForRecord(projected({ orderId: "O", created: F - 400 * DAY, lines: [OTHER(), NB] }), { ordersFrom: F });
    expect(old?.items).toHaveLength(2);
  });

  test("no floor (null) keeps a foreign-only order of any date", () => {
    expect(projectEbayOrderForRecord(projected({ orderId: "O", created: 0 + DAY, lines: [OTHER()] }), { ordersFrom: null })).not.toBeNull();
  });

  test("the floor reads the order's creation date, not its last modification", () => {
    const o = projected({ orderId: "O", created: F - DAY, modified: F + DAY, lines: [OTHER()] });
    expect(projectEbayOrderForRecord(o, { ordersFrom: F })).toBeNull();
  });

  test("a SKU that only looks like NB's (not parseable) is a foreign line, and a title shaped like an NB SKU changes nothing", () => {
    const out = projectEbayOrderForRecord(
      projected({ orderId: "O", created: F + 1, lines: [{ legacyItemId: "X1", sku: "NB2-abc-ZZ", title: "NB2-abc-NM" }] }),
      { ordersFrom: F },
    );
    expect(out?.items[0]).toMatchObject({ condition: "", listed: { title: "NB2-abc-NM" } });
    // Foreign only, so the floor still applies.
    expect(
      projectEbayOrderForRecord(projected({ orderId: "O", created: F - 1, lines: [{ legacyItemId: "X1", sku: "NB2-abc-ZZ", title: "NB2-abc-NM" }] }), { ordersFrom: F }),
    ).toBeNull();
  });

  test("a title past the bound is not stored (dropped at the projection) while the line is", () => {
    const out = projectEbayOrderForRecord(
      projected({ orderId: "O", created: F + 1, lines: [OTHER(1, "t".repeat(LISTED_TITLE_MAX + 1))] }),
      { ordersFrom: F },
    );
    expect(out?.items).toHaveLength(1);
    expect(out?.items[0].listed).toBeUndefined();
  });
});

describe("a stored eBay order that NB didn't list (NEO-520)", () => {
  async function stocked() {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    await startEbay(s);
    await link(s, s.cardId, "NM");
    return s;
  }

  test("a paid foreign-only order is stored with eBay's title, refused as unmatched, lowers nothing and is on the Pick List", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "ORD-X", created: F + 1000, lines: [OTHER(1, "Binder of 1990 commons")] })]];

    const report = await poll(s);

    expect(report).toMatchObject({ ordersRead: 1, ordersStored: 1, linesApplied: 0, error: null });
    expect(await totalQty(s)).toBe(3);
    const [stored] = await sales(s);
    expect(stored.items).toEqual([
      expect.objectContaining({ platformCardId: "X1", sellerSku: "MY-OWN-1", applied: false, problem: "unmatched", listed: { title: "Binder of 1990 commons" } }),
    ]);
    expect(stored.pullOpen).toBe(true);
    const open = await s.me.query(api.pickList.open, {});
    expect(open.lines).toHaveLength(1);
    expect(open.lines[0]).toMatchObject({ cantFind: "unmatched", orderNo: "ORD-X", listed: { title: "Binder of 1990 commons" }, from: [] });
    expect(open.lines[0].cardId).toBeUndefined();
  });

  test("the public sale (listSales) carries the title on a line with no card, and none on an NB line", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "ORD-M", created: F + 1000, lines: [OTHER(1, "Foreign thing"), { legacyItemId: "L1", sku: SKU(s), title: "NB card title" }] })]];
    await poll(s);
    const page = await s.me.query(api.listingSync.listSales, { paginationOpts: { numItems: 10, cursor: null } } as never);
    const [sale] = (page as { page: Array<{ items: Array<{ title?: string; cardId?: string; problem?: string }> }> }).page;
    expect(sale.items[0]).toMatchObject({ title: "Foreign thing", problem: "unmatched" });
    expect(sale.items[0].cardId).toBeUndefined();
    expect(sale.items[1]).toMatchObject({ cardId: s.cardId, title: "NB card title" });
  });

  test("a mixed paid order lowers the oldest NB copy once and leaves the foreign line unmatched", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "ORD-M", created: F + 1000, lines: [OTHER(1, "Foreign"), { legacyItemId: "L1", sku: SKU(s), title: "Mine" }] })]];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    const [stored] = await sales(s);
    expect(stored.items.map((i) => [i.applied, i.problem])).toEqual([[false, "unmatched"], [true, undefined]]);
  });

  test("re-polling the same order keeps the title and a pulledAt the seller set, and applies nothing twice", async () => {
    const s = await stocked();
    const order = () => raw({ orderId: "ORD-M", created: F + 1000, modified: F + 2000, lines: [OTHER(1, "Foreign"), { legacyItemId: "L1", sku: SKU(s) }] });
    pages = [[order()]];
    await poll(s);
    const open = await s.me.query(api.pickList.open, {});
    const foreign = open.lines.find((l) => l.cantFind === "unmatched")!;
    await s.me.mutation(api.pickList.setPulled, { ids: [foreign.id], pulled: true });
    const before = (await sales(s))[0];
    expect(before.items[0].pulledAt).toBeTypeOf("number");

    // A re-read: force the catch-up and bump the order's modification so it is not skipped.
    await s.t.run(async (ctx) => {
      const st = (await ctx.db.query("marketplaceListingStates").collect())[0];
      await ctx.db.patch(st._id, { ordersReadVersion: 1 } as never);
    });
    pages = [[{ ...order(), lastModifiedDate: ISO(F + 5000) }]];
    await poll(s);
    await poll(s);

    expect(await sales(s)).toHaveLength(1);
    const after = (await sales(s))[0];
    expect(after.items[0]).toMatchObject({ listed: { title: "Foreign" }, problem: "unmatched", pulledAt: before.items[0].pulledAt });
    expect(after.items[1]).toMatchObject({ applied: true });
    expect(await totalQty(s)).toBe(2);
  });

  test("a foreign line on a cancelled order is stored but not refused, and an unpaid one waits", async () => {
    const s = await stocked();
    pages = [
      [
        raw({ orderId: "CAN", created: F + 1000, cancel: "CANCELED", lines: [OTHER(1, "Foreign")] }),
        raw({ orderId: "UNPAID", created: F + 1000, payment: "PENDING", lines: [OTHER(2, "Foreign two")] }),
      ],
    ];
    await poll(s);
    const byOrder = new Map((await sales(s)).map((x) => [x.orderId, x]));
    expect(byOrder.get("CAN")!.items[0].problem).toBeUndefined();
    expect(byOrder.get("UNPAID")!.items[0].problem).toBeUndefined();
    expect(byOrder.get("CAN")!.items[0].applied).toBe(false);
    expect(await totalQty(s)).toBe(3);
  });

  test("a link mismatch on an NB-SKU line is unchanged by the widening", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "ORD-1", created: F + 1000, lines: [{ legacyItemId: "SOMEONE-ELSES", sku: SKU(s) }, OTHER(1, "Foreign")] })]];
    await poll(s);
    const [stored] = await sales(s);
    expect(stored.items[0]).toMatchObject({ problem: "linkMismatch", cardId: s.cardId });
    expect(stored.items[1]).toMatchObject({ problem: "unmatched" });
    expect(await totalQty(s)).toBe(3);
  });

  test("an order of foreign lines placed before the floor is read but not stored; the poll still moves on", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "OLD", created: F - DAY, modified: F + 1000, lines: [OTHER(1, "Old sale")] })]];
    const report = await poll(s);
    expect(report).toMatchObject({ ordersRead: 1, ordersStored: 0, error: null });
    expect(await sales(s)).toEqual([]);
  });

  test("an order whose every line is unreadable is skipped with a note when it is in the floor; before the floor it is silent", async () => {
    const s = await stocked();
    const bad = { legacyItemId: "X1", quantity: 0 };
    pages = [[raw({ orderId: "BAD", created: F + 1000, lines: [bad] })]];
    const report = await poll(s);
    expect(await sales(s)).toEqual([]);
    expect(report.error).toMatch(/1 line\(s\) NeonBinder can't read/);

    pages = [[raw({ orderId: "BAD-OLD", created: F - DAY, lines: [bad] })]];
    const quiet = await poll(s);
    expect(quiet.error).toBeNull();
  });

  test("an order with some unreadable lines stores the rest and notes the others", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "PART", created: F + 1000, lines: [{ legacyItemId: "X1", quantity: 0 }, OTHER(2, "Readable")] })]];
    const report = await poll(s);
    expect(report.error).toMatch(/can't read; the rest were applied/);
    expect((await sales(s))[0].items).toHaveLength(1);
  });

  test("an order with a buyer and ship-to still stores none of it alongside the title", async () => {
    const s = await stocked();
    pages = [[raw({ orderId: "PII", created: F + 1000, lines: [OTHER(1, "Foreign")] })]];
    await poll(s);
    const json = JSON.stringify(await sales(s));
    for (const pii of ["buyer-handle-123", "Hidden Buyer", "1 Private Rd"]) expect(json).not.toContain(pii);
  });
});

describe("the stored title is re-checked at the store (NEO-520)", () => {
  const record = (s: S, title: string) =>
    s.t.mutation(internal.listingSales.recordOrder, {
      ownerId: OWNER,
      platform: "ebay",
      order: {
        orderId: "DIRECT",
        orderNo: "DIRECT",
        orderDate: F + 1,
        status: "NOT_STARTED",
        totals: {},
        items: [{ platformCardId: "X1", condition: "", quantity: 1, priceCents: 100, graded: false, listed: { title } }],
      },
    } as never);

  test("a caller other than the projection gets the same bound: kept at the limit, dropped one past it", async () => {
    const s = await setup();
    await startEbay(s);
    await record(s, "t".repeat(LISTED_TITLE_MAX));
    expect((await sales(s))[0].items[0].listed?.title).toHaveLength(LISTED_TITLE_MAX);
    const s2 = await setup();
    await startEbay(s2);
    await record(s2, "t".repeat(LISTED_TITLE_MAX + 1));
    expect((await sales(s2))[0].items[0].listed).toBeUndefined();
  });
});

describe("an order stored before NEO-520 and read again with its other lines (NEO-520)", () => {
  async function stockedWithNbOnlyOrder() {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    await startEbay(s, { readVersion: null });
    await link(s, s.cardId, "NM");
    // The old read: only the NB line of ORD-MIX was stored and applied.
    pages = [[raw({ orderId: "ORD-MIX", created: F + 1000, lines: [{ legacyItemId: "L1", sku: SKU(s) }] })]];
    // Run the old behaviour by hand: the rewind is switched off for this first poll.
    await s.t.run(async (ctx) => {
      const st = (await ctx.db.query("marketplaceListingStates").collect())[0];
      await ctx.db.patch(st._id, { ordersReadVersion: ORDER_READ_VERSION.ebay });
    });
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    await s.t.run(async (ctx) => {
      const st = (await ctx.db.query("marketplaceListingStates").collect())[0];
      await ctx.db.patch(st._id, { ordersReadVersion: undefined } as never);
    });
    return s;
  }

  test("the foreign line is added in front of the NB line, and the NB line is not lowered a second time", async () => {
    const s = await stockedWithNbOnlyOrder();
    pages = [
      [
        raw({
          orderId: "ORD-MIX",
          created: F + 1000,
          modified: F + 9000,
          lines: [OTHER(1, "Foreign first"), { legacyItemId: "L1", sku: SKU(s) }],
        }),
      ],
    ];
    await poll(s);
    expect(await totalQty(s)).toBe(2);
    const all = await sales(s);
    expect(all).toHaveLength(1);
    const byKey = all[0].items.map((i) => [i.platformCardId, i.applied, i.problem]);
    expect(byKey).toEqual(expect.arrayContaining([["X1", false, "unmatched"], ["L1", true, undefined]]));
    expect(all[0].items).toHaveLength(2);
  });

  test("two identical foreign lines in one order both survive as separate lines", async () => {
    const s = await setup();
    await startEbay(s);
    pages = [[raw({ orderId: "DUP", created: F + 1000, lines: [OTHER(1, "Same"), OTHER(1, "Same")] })]];
    await poll(s);
    expect((await sales(s))[0].items).toHaveLength(2);
    await poll(s);
    expect(await sales(s)).toHaveLength(1);
    expect((await sales(s))[0].items).toHaveLength(2);
    const open = await s.me.query(api.pickList.open, {});
    expect(new Set(open.lines.map((l) => l.id)).size).toBe(2);
  });
});

describe("the one-time catch-up rewind (NEO-520)", () => {
  const stateRow = async (s: S) => (await state(s))!;
  /** A listing eBay seller whose cursor sits well past the floor. */
  async function behind(readVersion: number | null) {
    const s = await setup();
    await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 3 });
    await startEbay(s, { readVersion });
    await link(s, s.cardId, "NM");
    const floor = ebayOrdersFloor((await stateRow(s))._creationTime);
    const cursor = floor + 3 * DAY;
    const id = (await stateRow(s))._id;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(id, { orderCursorAt: cursor });
    });
    return { s, floor, cursor };
  }

  test("a state row with no read version is rewound once: the first request starts at the floor, not the cursor", async () => {
    const { s, floor } = await behind(null);
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(floor));
  });

  test("a complete read stamps version 2 and moves the cursor; the next poll starts at the cursor", async () => {
    const { s, floor } = await behind(null);
    pages = [[raw({ orderId: "A", created: floor + DAY, modified: floor + 4 * DAY, lines: [OTHER(1, "Missed sale")] })]];
    await poll(s);
    expect((await stateRow(s)).ordersReadVersion).toBe(ORDER_READ_VERSION.ebay);
    expect((await stateRow(s)).orderCursorAt).toBe(floor + 4 * DAY);
    requests = [];
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(floor + 4 * DAY));
  });

  test("the rewind picks up an order the old read skipped, and it is stored once", async () => {
    const { s, floor } = await behind(null);
    pages = [[raw({ orderId: "MISSED", created: floor + DAY, modified: floor + DAY, lines: [OTHER(1, "Missed sale")] })]];
    const report = await poll(s);
    expect(report.ordersStored).toBe(1);
    await poll(s);
    expect(await sales(s)).toHaveLength(1);
  });

  test("a row at the current version is not rewound", async () => {
    const { s, cursor } = await behind(ORDER_READ_VERSION.ebay);
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(cursor));
  });

  test("a cursor already earlier than the floor is never moved forward by the rewind", async () => {
    const { s, floor } = await behind(null);
    const earlier = floor - 10 * DAY;
    const id = (await stateRow(s))._id;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(id, { orderCursorAt: earlier });
    });
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(earlier));
  });

  test("a failed page keeps the old version and cursor, so the next poll rewinds again", async () => {
    const { s, floor, cursor } = await behind(null);
    pages = [[raw({ orderId: "A", created: floor + DAY, lines: [OTHER(1, "x")] })], [raw({ orderId: "B", created: floor + DAY, lines: [OTHER(2, "y")] })]];
    failPage = 1;
    await poll(s);
    expect((await stateRow(s)).ordersReadVersion).toBeUndefined();
    expect((await stateRow(s)).orderCursorAt).toBe(cursor);
    failPage = null;
    requests = [];
    await poll(s);
    expect(requests[0].filter).toBe(ordersModifiedSinceFilter(floor));
    expect((await stateRow(s)).ordersReadVersion).toBe(ORDER_READ_VERSION.ebay);
  });

  test("a read that never ends within the page limit does not stamp the version", async () => {
    const { s, floor } = await behind(null);
    pages = [[raw({ orderId: "A", created: floor + DAY, lines: [OTHER(1, "x")] })]];
    alwaysMore = true;
    await poll(s);
    expect((await stateRow(s)).ordersReadVersion).toBeUndefined();
  });

  test("an old order modified after the floor, holding only foreign lines, is not stored by the catch-up", async () => {
    const { s, floor } = await behind(null);
    pages = [
      [
        raw({ orderId: "OLD-FOREIGN", created: floor - 20 * DAY, modified: floor + DAY, lines: [OTHER(1, "Old")] }),
        raw({ orderId: "OLD-NB", created: floor - 20 * DAY, modified: floor + DAY, lines: [{ legacyItemId: "L1", sku: SKU(s) }] }),
      ],
    ];
    await poll(s);
    expect((await sales(s)).map((x) => x.orderId)).toEqual(["OLD-NB"]);
  });

  test("the floor is the earlier of the state row's creation and the fixed floor: a row created before it stores orders from its creation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(F - 30 * DAY);
      const s = await setup();
      await add(s, s.cardId, { homeId: s.box, condition: "Near Mint", quantity: 1 });
      await startEbay(s);
      const created = (await stateRow(s))._creationTime;
      expect(created).toBeLessThan(F);
      pages = [
        [
          raw({ orderId: "BEFORE-ROW", created: created - DAY, modified: created + 1000, lines: [OTHER(1, "a")] }),
          raw({ orderId: "AFTER-ROW", created: created + DAY, modified: created + DAY, lines: [OTHER(2, "b")] }),
        ],
      ];
      await poll(s);
      expect((await sales(s)).map((x) => x.orderId)).toEqual(["AFTER-ROW"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("BuySportsCards is never rewound: it reports version 1 and no floor", async () => {
    const s = await setup({ bsc: true });
    await startEbay(s, { bsc: true });
    const input = await s.t.query(internal.listingSales.pollInput, { ownerId: OWNER, platform: "bsc" });
    expect(input).toMatchObject({ readVersion: 1, ordersFrom: null });
    const bscState = await s.t.run(async (ctx) =>
      (await ctx.db.query("marketplaceListingStates").collect()).find((r) => r.platform === "bsc"),
    );
    expect(input!.cursorAt).toBe(bscState!._creationTime - INITIAL_CURSOR_GRACE_MS);
  });

  test("finishPoll never stamps a version without a cursor, and never lowers one", async () => {
    const s = await setup();
    await startEbay(s, { readVersion: 2 });
    await s.t.mutation(internal.listingSales.finishPoll, { ownerId: OWNER, platform: "ebay", readVersion: 5 });
    expect((await stateRow(s)).ordersReadVersion).toBe(2);
    await s.t.mutation(internal.listingSales.finishPoll, { ownerId: OWNER, platform: "ebay", cursorAt: NOW, readVersion: 1 });
    expect((await stateRow(s)).ordersReadVersion).toBe(2);
    await s.t.mutation(internal.listingSales.finishPoll, { ownerId: OWNER, platform: "ebay", cursorAt: NOW, readVersion: 3 });
    expect((await stateRow(s)).ordersReadVersion).toBe(3);
  });
});
