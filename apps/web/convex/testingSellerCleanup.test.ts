/**
 * NEO-445 — `testingSellerCleanup.clearSellerAccounts`: what it refuses, what it
 * touches on each test seller, and what it leaves alone. `fetch` is stubbed, so
 * nothing reaches the browser service, eBay or BuySportsCards; the credential
 * actions and adapters are the real ones.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { bscConditionsForEra, bscEraForYear } from "./lib/bscConditions";
import { planBscSheet } from "./lib/bscSheetPlan";
import { BSC_FIRST_READ_RETRY_PAUSE_MS, MAX_CHAIN_SIBLINGS } from "./testingSellerCleanup";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const BROWSER = "http://localhost:9999";
const EBAY_HOST = "api.sandbox.ebay.com";
const BSC_HOST = "api-prod.buysportscards.com";
const OWNER = "user_e2esellercleanup";
const ERA = bscConditionsForEra(bscEraForYear("1988") as "modern" | "vintage") as readonly string[];
const COND = ERA[0];
const OTHER_COND = ERA[1];

type T = ReturnType<typeof convexTest>;

type Item = { sku?: string };
type Offer = { offerId: string; status: "PUBLISHED" | "UNPUBLISHED" };
type Row = { productId: string; cardId: string; cardNo: string; condition: string; availableQuantity: number; price: string; productType: "raw" | "graded"; card: { id: string; cardNo: string } };

const sku = (name: string) => `NB2-${name}-NM`;
const item = (s: string): Item => ({ sku: s });
const row = (productId: string, cardId: string, condition: string, availableQuantity: number): Row => ({
  productId,
  cardId,
  cardNo: cardId.replace("bsc-", ""),
  condition,
  availableQuantity,
  price: "1.00",
  productType: "raw",
  card: { id: cardId, cardNo: cardId.replace("bsc-", "") },
});

let pages: Array<{ inventoryItems?: Item[]; next?: string }>;
let offers: Map<string, Offer>;
let withdrawals: string[];
let withdrawAnswers: Array<Response>;
let offerReads: string[];
let offersRefused: Set<string>;
let deletes: string[];
let deleteAnswers: Map<string, Array<Response>>;
let gone: Set<string>;
/** Each eBay write in the order it reached eBay, to prove the withdraw comes before the delete. */
let ebayWrites: string[];
/** Added to `Date.now()`, so a test can run out the cleanup's budget at a chosen call. */
let clockSkewMs: number;
let onOfferRead: (() => void) | null;
let onDelete: (() => void) | null;
let inventoryOffsets: string[];
let sheet: Row[];
let sheetReads: Array<{ condition: string; filters: Record<string, string[]> }>;
let maxReadsInFlight: number;
let puts: Array<{ sellerId: string; listings: Row[] }>;
let putTakes: boolean;
let sheetAnswer: Response | null;
/** One entry per sheet read, in order, used up as they arrive: a status, a failure with no status, or null for the real sheet. */
let sheetScript: Array<number | "network" | "timeout" | null>;
/** How many sheet reads had reached BSC at each retry pause. */
let firstReadPauses: number[];
let browserCalls: Array<{ method: string; path: string }>;
let ebayCalls: number;
let bscCalls: number;
let logged: string[];

beforeEach(() => {
  pages = [{ inventoryItems: [] }];
  offers = new Map();
  withdrawals = [];
  withdrawAnswers = [];
  offerReads = [];
  offersRefused = new Set();
  deletes = [];
  deleteAnswers = new Map();
  gone = new Set();
  ebayWrites = [];
  clockSkewMs = 0;
  onOfferRead = null;
  onDelete = null;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockSkewMs);
  inventoryOffsets = [];
  sheet = [];
  sheetReads = [];
  maxReadsInFlight = 0;
  puts = [];
  putTakes = true;
  sheetAnswer = null;
  sheetScript = [];
  firstReadPauses = [];
  // The retry pause, and only that: 10 real seconds per test would outlast the
  // test's own timeout. Faking the clock instead would stall convex-test.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== BSC_FIRST_READ_RETRY_PAUSE_MS) return realSetTimeout(handler, ms, ...rest);
    firstReadPauses.push(sheetReads.length);
    return realSetTimeout(handler, 0, ...rest);
  }) as typeof setTimeout);
  browserCalls = [];
  ebayCalls = 0;
  bscCalls = 0;
  logged = [];
  process.env.NEONBINDER_BROWSER_URL = BROWSER;
  __resetContractCache();
  vi.stubEnv("TESTING_RESET_SECRET", "test-enabled");
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("DEV_EBAY_REFRESH_TOKEN", "sandbox-refresh-token");
  vi.stubEnv("DEV_BSC_USERNAME", "seller@example.com");
  vi.stubEnv("DEV_BSC_PASSWORD", "bsc-password");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
  let readsInFlight = 0;
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    if (u.origin === BROWSER) {
      if (u.pathname === "/health") return Response.json({ status: "ok", environment: "test", contractVersion: 1 });
      browserCalls.push({ method, path: u.pathname });
      if (u.pathname === "/oauth/ebay/connect") {
        return Response.json({ username: "sandbox-seller", ebayUserId: "SBX-1", environment: "sandbox", expiresAt: 1 });
      }
      if (u.pathname === "/login/bsc") return Response.json({ success: true, sellerId: "seller-1" });
      if (u.pathname.endsWith("/token")) return Response.json({ token: "live-access-token" });
      if (method === "DELETE") return new Response(null, { status: 200 });
      throw new Error(`unexpected browser path ${u.pathname}`);
    }
    if (u.hostname === EBAY_HOST) {
      ebayCalls += 1;
      if (u.pathname === "/sell/inventory/v1/inventory_item") {
        const offset = u.searchParams.get("offset") ?? "?";
        inventoryOffsets.push(offset);
        // As eBay: a deleted item is no longer listed.
        const page = pages[Number(offset)] ?? {};
        const left = page.inventoryItems?.filter((i) => i.sku === undefined || !gone.has(i.sku));
        return Response.json({ ...page, ...(left ? { inventoryItems: left } : {}) });
      }
      const deleted = /^\/sell\/inventory\/v1\/inventory_item\/([^/]+)$/.exec(u.pathname);
      if (deleted && method === "DELETE") {
        const s = decodeURIComponent(deleted[1]);
        deletes.push(s);
        ebayWrites.push(`delete ${s}`);
        onDelete?.();
        const answer = deleteAnswers.get(s)?.shift();
        if (answer) return answer;
        gone.add(s);
        offers.delete(s);
        return new Response(null, { status: 204 });
      }
      if (u.pathname === "/sell/inventory/v1/offer") {
        const s = u.searchParams.get("sku") ?? "";
        offerReads.push(s);
        onOfferRead?.();
        if (offersRefused.has(s)) return Response.json({ errors: [{ errorId: 25709 }] }, { status: 400 });
        const offer = offers.get(s);
        if (!offer) return Response.json({ errors: [{ errorId: 25713 }] }, { status: 404 });
        return Response.json({ offers: [{ ...offer, sku: s, listing: { listingId: "L1" } }] });
      }
      const withdraw = /^\/sell\/inventory\/v1\/offer\/([^/]+)\/withdraw$/.exec(u.pathname);
      if (withdraw && method === "POST") {
        withdrawals.push(withdraw[1]);
        ebayWrites.push(`withdraw ${withdraw[1]}`);
        return withdrawAnswers.shift() ?? Response.json({ listingId: "L1" });
      }
      throw new Error(`unexpected eBay path ${u.pathname}`);
    }
    if (u.hostname === BSC_HOST) {
      bscCalls += 1;
      if (u.pathname === "/seller/bulk-upload/results") {
        readsInFlight += 1;
        maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        readsInFlight -= 1;
        const body = JSON.parse(String(init?.body)) as { condition: string; filters: Record<string, string[]> };
        sheetReads.push(body);
        const scripted = sheetScript.shift() ?? null;
        if (scripted === "network") throw new TypeError("fetch failed");
        if (scripted === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        if (scripted !== null) return new Response("nope", { status: scripted });
        if (sheetAnswer) return sheetAnswer.clone();
        return Response.json(sheet.filter((r) => r.condition === body.condition));
      }
      if (u.pathname === "/seller/bulk-upload" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { sellerId: string; listings: Row[] };
        puts.push(body);
        if (putTakes) {
          for (const l of body.listings) {
            const held = sheet.find((r) => r.productId === l.productId);
            if (held) held.availableQuantity = l.availableQuantity;
          }
        }
        return Response.json({ ok: true });
      }
      if (u.pathname === "/marketplace/user/profile") return Response.json({ sellerProfile: { sellerId: "seller-1" } });
      throw new Error(`unexpected BSC path ${u.pathname}`);
    }
    throw new Error(`unexpected host ${u.hostname}`);
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_BROWSER_URL;
});

/** The real set's chain, BSC slots and all, plus another set the cleanup must not read. */
async function seedSet(t: T) {
  return await t.run(async (ctx) => {
    const add = async (
      level: "sport" | "year" | "manufacturer" | "setName" | "variantType",
      value: string,
      parentId?: Id<"selectorOptions">,
      facets?: Record<string, string>,
    ) =>
      await ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: { bsc: { b0: `slug-${value}-${parentId ?? "root"}` } },
        ...(facets ? { platformFacets: { bsc: facets } } : {}),
        isCustom: false,
        children: [],
        ...(parentId ? { parentId } : {}),
        lastUpdated: 0,
      } as never);
    const sport = await add("sport", "Baseball");
    const year = await add("year", "1988", sport);
    const brand = await add("manufacturer", "Topps", year);
    const set = await add("setName", "Topps", brand);
    await add("variantType", "Base", set, { b0: "variant" });
    await add("variantType", "Insert", set, { b0: "variant" });
    const traded = await add("setName", "Traded", brand);
    await add("variantType", "Base", traded, { b0: "variant" });
  });
}

const clear = async (t: T) => await t.action(internal.testingSellerCleanup.clearSellerAccounts, {});

async function ready() {
  const t = convexTest(schema, modules);
  await seedSet(t);
  return t;
}

const ownerRows = (t: T) =>
  t.run(async (ctx) => ({
    profiles: (await ctx.db.query("userProfiles").collect()).filter((r) => r.userId === OWNER).length,
    states: (await ctx.db.query("marketplaceListingStates").collect()).filter((r) => r.ownerId === OWNER).length,
    settings: (await ctx.db.query("ebaySellerSettings").collect()).filter((r) => r.ownerId === OWNER).length,
  }));

describe("what it refuses", () => {
  test("fails closed without the testing flag, before anything is read or called", async () => {
    vi.stubEnv("TESTING_RESET_SECRET", "");
    const t = await ready();
    await expect(clear(t)).rejects.toThrow(/not enabled/);
    expect([browserCalls.length, ebayCalls, bscCalls]).toEqual([0, 0, 0]);
  });

  test.each([["production"], [""], ["staging"]])("refuses EBAY_ENVIRONMENT=%j and touches neither seller", async (environment) => {
    vi.stubEnv("EBAY_ENVIRONMENT", environment);
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    await expect(clear(t)).rejects.toThrow(/not the sandbox/);
    expect([browserCalls.length, ebayCalls, bscCalls]).toEqual([0, 0, 0]);
  });

  test("a deployment missing the set fails the job without signing in to BuySportsCards; eBay is still cleared", async () => {
    const t = convexTest(schema, modules);
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: no 1988 Topps Topps Base.*seed/);
    expect(withdrawals).toEqual(["O1"]);
    expect(bscCalls).toBe(0);
    expect(browserCalls.some((c) => c.path === "/login/bsc")).toBe(false);
    await drainScheduled(t);
  });

  test("two rows of one name in the chain: never picks one", async () => {
    const t = await ready();
    await t.run(async (ctx) => {
      await ctx.db.insert("selectorOptions", { level: "sport", value: "Baseball", platformData: {}, isCustom: false, children: [], lastUpdated: 0 } as never);
    });
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: 1988 Topps Topps Base can't be told apart: its sport row/);
    expect(bscCalls).toBe(0);
    await drainScheduled(t);
  });

  test("a missing eBay token fails the job but BuySportsCards is still cleared", async () => {
    vi.stubEnv("DEV_EBAY_REFRESH_TOKEN", "");
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    await expect(clear(t)).rejects.toThrow(/eBay: DEV_EBAY_REFRESH_TOKEN is not set/);
    expect(sheet[0].availableQuantity).toBe(0);
    await drainScheduled(t);
  });

  test("missing BuySportsCards credentials fail the job but eBay is still cleared", async () => {
    vi.stubEnv("DEV_BSC_PASSWORD", "");
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: DEV_BSC_USERNAME or DEV_BSC_PASSWORD is not set/);
    expect(withdrawals).toEqual(["O1"]);
    await drainScheduled(t);
  });
});

describe("a paused marketplace", () => {
  test("paused eBay is never contacted, even off the sandbox; BuySportsCards still runs", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 2)];
    const r = await clear(t);
    expect(r.ebay.outcome).toBe("paused");
    expect(r.bsc).toMatchObject({ outcome: "clean", zeroed: 1 });
    expect(ebayCalls).toBe(0);
    expect(browserCalls.some((c) => c.path.includes("ebay"))).toBe(false);
    await drainScheduled(t);
  });

  test("paused BuySportsCards is never contacted; eBay still runs", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
    const t = await ready();
    const r = await clear(t);
    expect(r.bsc.outcome).toBe("paused");
    expect(r.ebay.outcome).toBe("clean");
    expect(bscCalls).toBe(0);
    expect(browserCalls.some((c) => c.path.includes("bsc") || c.path.includes("buysportscards"))).toBe(false);
    await drainScheduled(t);
  });

  test("both paused: success with nothing called and no set needed", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay,buysportscards");
    const t = convexTest(schema, modules);
    const r = await clear(t);
    expect([r.ebay.outcome, r.bsc.outcome]).toEqual(["paused", "paused"]);
    expect(r.ebay).toEqual({ outcome: "paused", items: 0, withdrawn: 0, deleted: 0 });
    expect([browserCalls.length, ebayCalls, bscCalls]).toEqual([0, 0, 0]);
    await drainScheduled(t);
  });
});

describe("eBay", () => {
  test("withdraws every published offer, whatever the item is, and only published ones", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b")), item("NOT-AN-NB-SKU"), item(sku("c")), item(sku("nooffer"))] }];
    offers.set(sku("a"), { offerId: "O-a", status: "PUBLISHED" });
    offers.set(sku("b"), { offerId: "O-b", status: "UNPUBLISHED" });
    offers.set("NOT-AN-NB-SKU", { offerId: "O-other", status: "PUBLISHED" });
    offers.set(sku("c"), { offerId: "O-c", status: "PUBLISHED" });
    const r = await clear(t);
    expect([...withdrawals].sort()).toEqual(["O-a", "O-c", "O-other"]);
    expect(r.ebay).toEqual({ outcome: "clean", items: 5, withdrawn: 3, deleted: 5 });
    await drainScheduled(t);
  });

  test("deletes every item, whatever its offer: published, unpublished, none, or not one of NB's", async () => {
    const t = await ready();
    const skus = [sku("live"), sku("draft"), sku("nooffer"), "NOT-AN-NB-SKU"];
    pages = [{ inventoryItems: skus.map(item) }];
    offers.set(sku("live"), { offerId: "O-live", status: "PUBLISHED" });
    offers.set(sku("draft"), { offerId: "O-draft", status: "UNPUBLISHED" });
    const r = await clear(t);
    expect([...deletes].sort()).toEqual([...skus].sort());
    expect(r.ebay).toEqual({ outcome: "clean", items: 4, withdrawn: 1, deleted: 4 });
    // The seller is empty: a second look finds nothing to do.
    const again = await clear(t);
    expect(again.ebay).toEqual({ outcome: "clean", items: 0, withdrawn: 0, deleted: 0 });
    await drainScheduled(t);
  });

  test("a live offer is withdrawn before its item is deleted", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O-a", status: "PUBLISHED" });
    await clear(t);
    expect(ebayWrites).toEqual(["withdraw O-a", `delete ${sku("a")}`]);
    await drainScheduled(t);
  });

  test("deletes across every page", async () => {
    const t = await ready();
    pages = [
      { inventoryItems: [item(sku("p0"))], next: "/sell/inventory/v1/inventory_item?limit=100&offset=1" },
      { inventoryItems: [item(sku("p1"))] },
    ];
    const r = await clear(t);
    expect([...deletes].sort()).toEqual([sku("p0"), sku("p1")]);
    expect(r.ebay.deleted).toBe(2);
    await drainScheduled(t);
  });

  test("an item eBay says is already gone counts as deleted", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("gone"))] }];
    deleteAnswers.set(sku("gone"), [Response.json({ errors: [{ errorId: 25710 }] }, { status: 404 })]);
    const r = await clear(t);
    expect(r.ebay).toEqual({ outcome: "clean", items: 1, withdrawn: 0, deleted: 1 });
    await drainScheduled(t);
  });

  test("a delete eBay refuses fails the job, naming it; the other items are still deleted", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b"))] }];
    deleteAnswers.set(sku("a"), [Response.json({ errors: [{ errorId: 25709 }] }, { status: 400 })]);
    await expect(clear(t)).rejects.toThrow(/eBay: 1 of 2 items could not be deleted.*400.*25709/);
    expect([...gone]).toEqual([sku("b")]);
    await drainScheduled(t);
  });

  test("eBay busy on a delete gets one more try", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    deleteAnswers.set(sku("a"), [Response.json({ errors: [{ errorId: 25001 }] }, { status: 500 })]);
    const r = await clear(t);
    expect(deletes).toEqual([sku("a"), sku("a")]);
    expect(r.ebay.deleted).toBe(1);
    await drainScheduled(t);
  });

  test("an item whose live offer would not end is kept, so a re-run can still find the listing", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    withdrawAnswers = [Response.json({ errors: [{ errorId: 25002 }] }, { status: 400 })];
    await expect(clear(t)).rejects.toThrow(/eBay: 1 of 1 items could not be checked or withdrawn, so they were kept.*25002/);
    expect(deletes).toEqual([]);
    const r = await clear(t);
    expect(r.ebay).toEqual({ outcome: "clean", items: 1, withdrawn: 1, deleted: 1 });
    await drainScheduled(t);
  });

  test("an item whose offer can't be read is kept: it may hold a live listing", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b"))] }];
    offersRefused.add(sku("a"));
    await expect(clear(t)).rejects.toThrow(/eBay: 1 of 2 items could not be checked or withdrawn, so they were kept.*400/);
    expect(deletes).toEqual([sku("b")]);
    await drainScheduled(t);
  });

  test("refused withdraws and refused deletes are both named", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b"))] }];
    offersRefused.add(sku("a"));
    deleteAnswers.set(sku("b"), [Response.json({ errors: [{ errorId: 25709 }] }, { status: 400 })]);
    await expect(clear(t)).rejects.toThrow(/could not be checked or withdrawn.*; 1 of 2 items could not be deleted/);
    await drainScheduled(t);
  });

  test("out of time part-way fails asking for a re-run, and the re-run finishes the rest", async () => {
    const t = await ready();
    const skus = Array.from({ length: 30 }, (_, i) => sku(`n${i}`));
    pages = [{ inventoryItems: skus.map(item) }];
    onDelete = () => {
      if (deletes.length === 3) clockSkewMs += 6 * 60 * 1000;
    };
    await expect(clear(t)).rejects.toThrow(/eBay: ran out of time with 30 items to clear.*\d+ deleted; re-run the workflow/);
    const first = gone.size;
    expect(first).toBeGreaterThanOrEqual(3);
    expect(first).toBeLessThan(30);

    onDelete = null;
    const r = await clear(t);
    expect(r.ebay).toEqual({ outcome: "clean", items: 30 - first, withdrawn: 0, deleted: 30 - first });
    expect([...gone].sort()).toEqual([...skus].sort());
    await drainScheduled(t);
  });

  test("the budget running out during an offer read starts no delete", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    onOfferRead = () => {
      clockSkewMs += 6 * 60 * 1000;
    };
    await expect(clear(t)).rejects.toThrow(/eBay: ran out of time/);
    expect(deletes).toEqual([]);
    await drainScheduled(t);
  });

  test("the seller_cleanup log line carries the count", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b"))] }];
    await clear(t);
    const line = logged.map((l) => /\{"msg":"seller_cleanup","platform":"ebay".*\}/.exec(l)?.[0]).find(Boolean);
    expect(JSON.parse(line as string)).toMatchObject({ outcome: "clean", items: 2, withdrawn: 0, deleted: 2 });
    await drainScheduled(t);
  });

  test("reads every page by following eBay's own next link: the offset is a page number", async () => {
    const t = await ready();
    pages = [
      { inventoryItems: [item(sku("p0"))], next: "/sell/inventory/v1/inventory_item?limit=100&offset=1" },
      { inventoryItems: [item(sku("p1"))], next: "https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?offset=2&limit=100" },
      { inventoryItems: [item(sku("p2"))] },
    ];
    offers.set(sku("p0"), { offerId: "O0", status: "PUBLISHED" });
    offers.set(sku("p2"), { offerId: "O2", status: "PUBLISHED" });
    const r = await clear(t);
    expect(inventoryOffsets).toEqual(["0", "1", "2"]);
    expect([...withdrawals].sort()).toEqual(["O0", "O2"]);
    expect(r.ebay).toMatchObject({ items: 3, withdrawn: 2 });
    await drainScheduled(t);
  });

  test("a next link that repeats a page fails rather than looping or claiming it read everything", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [], next: "/x?limit=100&offset=0" }];
    await expect(clear(t)).rejects.toThrow(/eBay: stopped paging/);
    expect(inventoryOffsets).toEqual(["0"]);
    await drainScheduled(t);
  });

  test("a next link NB can't read fails", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [], next: "/x?limit=100" }];
    await expect(clear(t)).rejects.toThrow(/eBay: could not read the seller's inventory/);
    await drainScheduled(t);
  });

  test("an item with no readable SKU fails: it may hold a live listing", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [{}] }];
    await expect(clear(t)).rejects.toThrow(/eBay: 1 inventory items came back with no readable SKU/);
    await drainScheduled(t);
  });

  test("nothing to clean is success, including an account with no items at all", async () => {
    const t = await ready();
    pages = [{}];
    const r = await clear(t);
    expect(r.ebay).toEqual({ outcome: "clean", items: 0, withdrawn: 0, deleted: 0 });
    expect(withdrawals).toEqual([]);
    expect(deletes).toEqual([]);
    await drainScheduled(t);
  });

  test("an offer eBay no longer has live is clean", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("gone"))] }];
    offers.set(sku("gone"), { offerId: "O-gone", status: "PUBLISHED" });
    withdrawAnswers = [Response.json({ errors: [{ errorId: 25713 }] }, { status: 404 })];
    const r = await clear(t);
    expect(r.ebay).toMatchObject({ outcome: "clean", items: 1, withdrawn: 1 });
    await drainScheduled(t);
  });

  test("a withdraw eBay refuses fails the job, naming it", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a")), item(sku("b"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    offers.set(sku("b"), { offerId: "O2", status: "PUBLISHED" });
    withdrawAnswers = [Response.json({ errors: [{ errorId: 25002 }] }, { status: 400 })];
    await expect(clear(t)).rejects.toThrow(/eBay: 1 of 2 items could not be checked or withdrawn.*400.*25002/);
    expect(deletes).toHaveLength(1);
    await drainScheduled(t);
  });

  test("eBay busy on a withdraw gets one more try", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    withdrawAnswers = [Response.json({ errors: [{ errorId: 25001 }] }, { status: 500 })];
    const r = await clear(t);
    expect(withdrawals).toEqual(["O1", "O1"]);
    expect(r.ebay.withdrawn).toBe(1);
    await drainScheduled(t);
  });
});

describe("BuySportsCards", () => {
  test("takes every row above 0 to 0, across conditions, and leaves rows at 0 out of the PUT", async () => {
    const t = await ready();
    sheet = [
      row("p1", "bsc-1", COND, 2),
      row("p2", "bsc-2", COND, 0),
      row("p3", "bsc-3", OTHER_COND, 1),
      { ...row("slab", "bsc-4", COND, 3), productType: "graded" },
    ];
    const r = await clear(t);
    expect(puts).toHaveLength(1);
    expect(puts[0].sellerId).toBe("seller-1");
    expect(puts[0].listings.map((l) => [l.productId, l.availableQuantity]).sort()).toEqual([["p1", 0], ["p3", 0]]);
    expect(r.bsc).toEqual({ outcome: "clean", rows: 3, unreadableRows: 0, listed: 2, zeroed: 2, twinKeys: 0, twinKeysRemaining: 0, skippedSets: 1 });
    expect(sheet.find((s) => s.productId === "slab")?.availableQuantity).toBe(3);
    await drainScheduled(t);
  });

  test("reads only the Base of the tested set, every condition of its era, one at a time, and reads back only what it touched", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    await clear(t);
    expect(maxReadsInFlight).toBe(1);
    expect(sheetReads.map((c) => c.condition)).toEqual([...ERA, COND]);
    const baseSlug = await t.run(async (ctx) => {
      const base = (await ctx.db.query("selectorOptions").collect()).filter((o) => o.level === "variantType" && o.value === "Base");
      const set = await Promise.all(base.map(async (o) => ({ o, parent: await ctx.db.get(o.parentId as Id<"selectorOptions">) })));
      return set.find((s) => s.parent?.value === "Topps")?.o.platformData?.bsc?.b0;
    });
    expect(baseSlug).toBeTruthy();
    for (const read of sheetReads) expect(read.filters.variant).toEqual([baseSlug]);
    await drainScheduled(t);
  });

  test("zeroes both copies of a twin like any other row: the planner's refusal never blocks this write", async () => {
    const t = await ready();
    sheet = [row("twin-a", "bsc-1", COND, 1), row("twin-b", "bsc-1", COND, 1), row("twin-c", "bsc-2", COND, 1), row("twin-d", "bsc-2", COND, 0)];
    const r = await clear(t);
    expect(puts[0].listings.map((l) => l.productId).sort()).toEqual(["twin-a", "twin-b", "twin-c"]);
    expect(r.bsc).toMatchObject({ outcome: "clean", listed: 3, zeroed: 3, twinKeys: 2 });
    await drainScheduled(t);
  });

  test("a twin BSC goes on showing at 0 is reported, not a failure", async () => {
    const t = await ready();
    sheet = [row("twin-a", "bsc-1", COND, 1), row("twin-b", "bsc-1", COND, 1)];
    const r = await clear(t);
    expect(sheet.map((s) => s.availableQuantity)).toEqual([0, 0]);
    expect(r.bsc).toMatchObject({ outcome: "clean", twinKeys: 1, twinKeysRemaining: 1 });
    await drainScheduled(t);
  });

  // Why the report above matters: zeroing both copies does not lift the refusal
  // while BSC still shows both. The planner keys on the pair, whatever the
  // quantity. If this goes red, the step's warning can go too.
  test("the listing planner still refuses a pair BSC shows twice at 0", () => {
    const plan = planBscSheet({
      sheetRows: [row("twin-a", "bsc-1", COND, 0), row("twin-b", "bsc-1", COND, 0)],
      conditionsRead: [COND],
      targets: [],
      cards: [],
    });
    expect(plan.problems).toEqual([{ reason: "duplicate_sheet_row", bscCardId: "bsc-1", bscCondition: COND }]);
  });

  test("a twin already at 0 sends no PUT and is still reported", async () => {
    const t = await ready();
    sheet = [row("twin-a", "bsc-1", OTHER_COND, 0), row("twin-b", "bsc-1", OTHER_COND, 0)];
    const r = await clear(t);
    expect(puts).toEqual([]);
    expect(r.bsc).toEqual({ outcome: "clean", rows: 2, unreadableRows: 0, listed: 0, zeroed: 0, twinKeys: 1, twinKeysRemaining: 1, skippedSets: 1 });
    await drainScheduled(t);
  });

  test("nothing listed is success with no PUT and no seller lookup", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 0)];
    const r = await clear(t);
    expect(puts).toEqual([]);
    expect(r.bsc).toMatchObject({ outcome: "clean", listed: 0, zeroed: 0 });
    await drainScheduled(t);
  });

  // NEO-458: 2026 Bowman Chrome is built by its own spec, in-flow, so the seller
  // jobs' start-clean pass meets a deployment that does not have it yet.
  test("a set its spec builds itself is skipped when this deployment has not built it, and the seed's set is still cleared", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    const r = await clear(t);
    expect(r.bsc).toMatchObject({ outcome: "clean", listed: 1, zeroed: 1, skippedSets: 1 });
    expect(sheetReads.map((c) => c.condition)).toEqual([...ERA, COND]);
    const absent = logged.filter((l) => l.includes("seller_cleanup_set_absent"));
    expect(absent).toHaveLength(1);
    expect(JSON.parse(absent[0])).toMatchObject({ set: "Football 2026 Bowman Bowman Chrome" });
    await drainScheduled(t);
  });

  describe("how far the spec's own set got", () => {
    /** As much of 2026 Bowman's chain as a test asks for, BSC slots on every row unless told. */
    const seedBowman = async (
      t: T,
      shape: { parallelType?: boolean; chromes?: number; chromeHasScope?: boolean; footballs?: number; otherParallels?: number },
    ) =>
      await t.run(async (ctx) => {
        const add = async (
          level: "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert",
          value: string,
          parentId?: Id<"selectorOptions">,
          facets?: Record<string, string>,
          noScope?: boolean,
        ) =>
          await ctx.db.insert("selectorOptions", {
            level,
            value,
            platformData: noScope ? {} : { bsc: { b0: `slug-${value}-${parentId ?? "root"}` } },
            ...(facets && !noScope ? { platformFacets: { bsc: facets } } : {}),
            isCustom: false,
            children: [],
            ...(parentId ? { parentId } : {}),
            lastUpdated: 0,
          } as never);
        const sport = await add("sport", "Football");
        for (let i = 1; i < (shape.footballs ?? 1); i++) await add("sport", "Football");
        const year = await add("year", "2026", sport);
        const brand = await add("manufacturer", "Bowman", year);
        const set = await add("setName", "Bowman", brand);
        await add("variantType", "Base", set, { b0: "variant" });
        if (!shape.parallelType) return;
        const parallels = await add("variantType", "Parallel", set, { b0: "variant" });
        for (let i = 0; i < (shape.otherParallels ?? 0); i++) await add("insert", `Other ${i}`, parallels, { b0: "variantName" });
        for (let i = 0; i < (shape.chromes ?? 0); i++) {
          await add("insert", "Chrome", parallels, { b0: "variantName" }, shape.chromeHasScope === false);
        }
      });
    const signedIn = () => browserCalls.some((c) => c.path === "/login/bsc");

    test("two Chrome rows fail the job before any sign-in: never skipped as absent, never one picked", async () => {
      const t = await ready();
      await seedBowman(t, { parallelType: true, chromes: 2 });
      pages = [{ inventoryItems: [item(sku("a"))] }];
      offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
      await expect(clear(t)).rejects.toThrow(/BuySportsCards: 2026 Bowman Bowman Chrome can't be told apart: its insert row/);
      expect(withdrawals).toEqual(["O1"]);
      expect(bscCalls).toBe(0);
      expect(signedIn()).toBe(false);
      expect(logged.filter((l) => l.includes("seller_cleanup_set_absent"))).toEqual([]);
      await drainScheduled(t);
    });

    test("two rows higher up the chain fail it too", async () => {
      const t = await ready();
      await seedBowman(t, { footballs: 2 });
      await expect(clear(t)).rejects.toThrow(/BuySportsCards: 2026 Bowman Bowman Chrome can't be told apart: its sport row/);
      expect(bscCalls).toBe(0);
      await drainScheduled(t);
    });

    test("a level read to the limit fails: a row past it could be Chrome, or a second one", async () => {
      const t = await ready();
      await seedBowman(t, { parallelType: true, otherParallels: MAX_CHAIN_SIBLINGS });
      await expect(clear(t)).rejects.toThrow(/BuySportsCards: 2026 Bowman Bowman Chrome can't be told apart: its insert row/);
      expect(bscCalls).toBe(0);
      await drainScheduled(t);
    });

    test("an absent Chrome is skipped and counted", async () => {
      const t = await ready();
      await seedBowman(t, { parallelType: true, chromes: 0 });
      sheet = [row("p1", "bsc-1", COND, 1)];
      const r = await clear(t);
      expect(r.bsc).toMatchObject({ outcome: "clean", zeroed: 1, skippedSets: 1 });
      await drainScheduled(t);
    });

    test("a partial chain, the set there and its Parallel type not yet, is skipped and counted", async () => {
      const t = await ready();
      await seedBowman(t, {});
      sheet = [row("p1", "bsc-1", COND, 1)];
      const r = await clear(t);
      expect(r.bsc).toMatchObject({ outcome: "clean", zeroed: 1, skippedSets: 1 });
      expect(logged.filter((l) => l.includes("seller_cleanup_set_absent"))).toHaveLength(1);
      await drainScheduled(t);
    });

    test("a Chrome row with no BSC scope fails the job, naming it", async () => {
      const t = await ready();
      await seedBowman(t, { parallelType: true, chromes: 1, chromeHasScope: false });
      await expect(clear(t)).rejects.toThrow(/BuySportsCards: 2026 Bowman Bowman Chrome has no BuySportsCards scope \(noScope\)/);
      expect(bscCalls).toBe(0);
      expect(signedIn()).toBe(false);
      await drainScheduled(t);
    });

    test("Chrome there: read, and nothing counted as skipped", async () => {
      const t = await ready();
      await seedBowman(t, { parallelType: true, chromes: 1 });
      const r = await clear(t);
      expect(r.bsc).toMatchObject({ outcome: "clean", skippedSets: 0 });
      expect(logged.filter((l) => l.includes("seller_cleanup_set_absent"))).toEqual([]);
      await drainScheduled(t);
    });

    test("paused BuySportsCards reads no set, so it counts none as skipped", async () => {
      vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
      const t = await ready();
      const r = await clear(t);
      expect(r.bsc).toMatchObject({ outcome: "paused", skippedSets: 0 });
      await drainScheduled(t);
    });

    test("the seller_cleanup log line carries the skipped count", async () => {
      const t = await ready();
      await clear(t);
      const line = logged.find((l) => l.includes('"seller_cleanup"') && l.includes('"bsc"'));
      expect(JSON.parse(line as string)).toMatchObject({ outcome: "clean", skippedSets: 1 });
      await drainScheduled(t);
    });
  });

  test("a built parallel's own row is read and zeroed, after the seed's Base, and never its sibling parallel", async () => {
    const t = await ready();
    const slugs = await t.run(async (ctx) => {
      const add = async (
        level: "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert",
        value: string,
        parentId?: Id<"selectorOptions">,
        facets?: Record<string, string>,
      ) =>
        await ctx.db.insert("selectorOptions", {
          level,
          value,
          platformData: { bsc: { b0: `slug-${value}-${parentId ?? "root"}` } },
          ...(facets ? { platformFacets: { bsc: facets } } : {}),
          isCustom: false,
          children: [],
          ...(parentId ? { parentId } : {}),
          lastUpdated: 0,
        } as never);
      const sport = await add("sport", "Football");
      const year = await add("year", "2026", sport);
      const brand = await add("manufacturer", "Bowman", year);
      const set = await add("setName", "Bowman", brand);
      await add("variantType", "Base", set, { b0: "variant" });
      const parallels = await add("variantType", "Parallel", set, { b0: "variant" });
      const chrome = await add("insert", "Chrome", parallels, { b0: "variantName" });
      await add("insert", "Chrome Aqua Refractor", parallels, { b0: "variantName" });
      return { chrome: `slug-Chrome-${parallels}`, other: `slug-Chrome Aqua Refractor-${parallels}`, chromeId: chrome };
    });
    sheet = [row("p1", "bsc-1", COND, 2)];
    const r = await clear(t);
    // Two sets read, each its own sheets one at a time; both zeroed (the stub's sheet answers every read).
    expect(maxReadsInFlight).toBe(1);
    expect(r.bsc).toMatchObject({ outcome: "clean", zeroed: 1, skippedSets: 0 });
    const chromeReads = sheetReads.filter((c) => c.filters.variantName?.[0] === slugs.chrome);
    expect(chromeReads.length).toBeGreaterThan(0);
    expect(sheetReads.filter((c) => c.filters.variantName?.[0] === slugs.other)).toEqual([]);
    expect(sheetReads.filter((c) => c.filters.variant !== undefined && c.filters.variantName === undefined).length).toBeGreaterThan(0);
    await drainScheduled(t);
  });

  test("a row BSC still shows above 0 after the PUT fails the job", async () => {
    const t = await ready();
    putTakes = false;
    sheet = [row("p1", "bsc-1", COND, 1)];
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: 1 rows are still above 0/);
    await drainScheduled(t);
  });

  test("a sheet BSC won't answer fails the job, and eBay's result is not lost to it", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    sheetAnswer = new Response("nope", { status: 500 });
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: could not read the sheets/);
    expect(withdrawals).toEqual(["O1"]);
    await drainScheduled(t);
  });

  test("a 503 on the first read gets one more try after the pause, and the job comes out clean", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    sheetScript = [503];
    const r = await clear(t);
    // One extra read, of the sheet that answered 503, then the usual reads and the read-back.
    expect(sheetReads.map((c) => c.condition)).toEqual([COND, ...ERA, COND]);
    expect(firstReadPauses).toEqual([1]);
    expect(maxReadsInFlight).toBe(1);
    expect(r.bsc).toEqual({ outcome: "clean", rows: 1, unreadableRows: 0, listed: 1, zeroed: 1, twinKeys: 0, twinKeysRemaining: 0, skippedSets: 1 });
    expect(sheet[0].availableQuantity).toBe(0);
    await drainScheduled(t);
  });

  test("a 503 part-way through the first read starts it again, and counts each row once", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1), row("p2", "bsc-2", OTHER_COND, 1)];
    sheetScript = [null, 503];
    const r = await clear(t);
    expect(sheetReads.map((c) => c.condition)).toEqual([COND, OTHER_COND, ...ERA, COND, OTHER_COND]);
    expect(firstReadPauses).toEqual([2]);
    expect(maxReadsInFlight).toBe(1);
    expect(r.bsc).toMatchObject({ outcome: "clean", rows: 2, listed: 2, zeroed: 2, twinKeys: 0 });
    await drainScheduled(t);
  });

  test("503 twice fails the job with the same words after exactly two reads, and eBay's result is not lost", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    sheet = [row("p1", "bsc-1", COND, 1)];
    // A third read would find the real sheet and the job would pass.
    sheetScript = [503, 503];
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: could not read the sheets: BuySportsCards answered 503 to sheetRead\./);
    expect(sheetReads.map((c) => c.condition)).toEqual([COND, COND]);
    expect(firstReadPauses).toEqual([1]);
    expect(puts).toEqual([]);
    expect(withdrawals).toEqual(["O1"]);
    expect(deletes).toEqual([sku("a")]);
    const line = logged.map((l) => /\{"msg":"seller_cleanup","platform":"ebay".*\}/.exec(l)?.[0]).find(Boolean);
    expect(JSON.parse(line as string)).toMatchObject({ outcome: "clean", items: 1, withdrawn: 1, deleted: 1 });
    await drainScheduled(t);
  });

  test.each([
    [500, /answered 500 to sheetRead/],
    [502, /answered 502 to sheetRead/],
    [504, /answered 504 to sheetRead/],
    ["network", /couldn't reach BuySportsCards/],
    ["timeout", /took too long to answer/],
  ] as const)("%s on the first read fails at once, with no pause and no second read", async (answer, words) => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    sheetScript = [answer];
    await expect(clear(t)).rejects.toThrow(words);
    expect(sheetReads).toHaveLength(1);
    expect(firstReadPauses).toEqual([]);
    await drainScheduled(t);
  });

  test("a 503 on the read-back gets no retry: only the first read has one", async () => {
    const t = await ready();
    sheet = [row("p1", "bsc-1", COND, 1)];
    sheetScript = [...ERA.map(() => null), 503];
    await expect(clear(t)).rejects.toThrow(/BuySportsCards: could not read the sheets back: BuySportsCards answered 503 to sheetRead\./);
    expect(sheetReads.map((c) => c.condition)).toEqual([...ERA, COND]);
    expect(firstReadPauses).toEqual([]);
    await drainScheduled(t);
  });
});

describe("what it leaves behind", () => {
  test("no session and no rows for its owner, and never a worker's or a token in a log", async () => {
    const t = await ready();
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", { userId: "user_worker8", siteCredentials: [{ site: "buysportscards", hasCredentials: true }] } as never);
    });
    pages = [{ inventoryItems: [item(sku("a"))] }];
    offers.set(sku("a"), { offerId: "O1", status: "PUBLISHED" });
    sheet = [row("p1", "bsc-1", COND, 1)];
    const r = await clear(t);
    const deletes = browserCalls.filter((c) => c.method === "DELETE").map((c) => c.path).sort();
    expect(deletes).toEqual([`/credentials/buysportscards-credentials-${OWNER}`, `/credentials/ebay-credentials-${OWNER}`]);
    expect(browserCalls.some((c) => c.path.includes("user_worker8"))).toBe(false);
    expect(await ownerRows(t)).toEqual({ profiles: 0, states: 0, settings: 0 });
    const worker = await t.run(async (ctx) => (await ctx.db.query("userProfiles").collect()).filter((p) => p.userId === "user_worker8"));
    expect(worker).toHaveLength(1);
    await drainScheduled(t);
    const text = [...logged, JSON.stringify(r)].join("\n");
    for (const secret of ["sandbox-refresh-token", "live-access-token", "bsc-password", "seller@example.com"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"msg":"seller_cleanup"');
  });

  test("a side that failed still removes its session and rows", async () => {
    const t = await ready();
    pages = [{ inventoryItems: [], next: "/x?limit=100" }];
    sheetAnswer = new Response("nope", { status: 500 });
    await expect(clear(t)).rejects.toThrow(/eBay:.*BuySportsCards:/);
    expect(browserCalls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    expect(await ownerRows(t)).toEqual({ profiles: 0, states: 0, settings: 0 });
    await drainScheduled(t);
  });

  test("a session that will not delete is a warning, not a failed job", async () => {
    const t = await ready();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response("no", { status: 500 });
      return await inner(url, init);
    }) as typeof fetch);
    const r = await clear(t);
    expect([r.ebay.outcome, r.bsc.outcome]).toEqual(["clean", "clean"]);
    expect(logged.join("\n")).toContain("seller_cleanup_session_left");
    await drainScheduled(t);
  });
});
