/**
 * NEO-415 — the eBay half of the listing drainer (`listingDrainEbay.ts`)
 * against a fake eBay.
 *
 * `fetch` is stubbed with an in-memory seller account (inventory items,
 * offers, published listings, a media store, the card category's aspects), so
 * the assertions are on what NB actually sent and what eBay would then hold.
 * The credentials layer is mocked at the two identity-less token entry
 * points. Photos come from an injected `fetchPhoto`. No test reaches a live
 * server.
 *
 * convex-test mints ids in its own format, which the real Convex id checks
 * (`convexIdCodec.tableNumberOf`) refuse, so that one check is relaxed here;
 * `lib/ebayListing.test.ts` pins the real SKU codec.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { drainOwnerImpl, type DrainCtx, type DrainReport } from "./listingDrain";
import { EBAY_SETUP_INCOMPLETE_ERROR } from "./listingDrain";
import { EBAY_CARD_REJECTED, EBAY_PUBLISH_CONCURRENCY, EBAY_STEP_SAYS, inPool } from "./listingDrainEbay";
import { EBAY_SANDBOX_TEST_PICTURE_URL } from "./lib/ebayEnv";
import { EBAY_PUBLISH_RETRY_PAUSE_MS } from "./adapters/ebaySeller";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const creds = vi.hoisted(() => ({
  token: "tok-1" as string | null,
  refreshed: true,
  refreshedToken: "tok-2",
  tokenCalls: 0,
  refreshCalls: 0,
}));

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => {
        creds.tokenCalls += 1;
        if (creds.refreshCalls > 0) return { token: creds.refreshedToken };
        return creds.token === null ? null : { token: creds.token };
      },
    }),
    refreshSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => {
        creds.refreshCalls += 1;
        return { refreshed: creds.refreshed };
      },
    }),
  };
});

vi.mock("./lib/convexIdCodec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/convexIdCodec")>();
  return { ...actual, tableNumberOf: (id: string) => (/^\d+[A-Za-z]+$/.test(id) ? 1 : null) };
});

const OWNER = "collector_ebay_001";
const OTHER = "collector_ebay_002";
const ME = { subject: OWNER };
const NOW = 1_700_000_000_000;
/**
 * The hosts the fake answers on: those of the eBay the env names. The suite
 * runs as production (where photos upload); the sandbox tests switch it.
 */
const ebayHosts = (): string[] =>
  process.env.EBAY_ENVIRONMENT === "sandbox"
    ? ["https://api.sandbox.ebay.com", "https://apim.sandbox.ebay.com"]
    : ["https://api.ebay.com", "https://apim.ebay.com"];

// ── A fake eBay seller ───────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  json: any;
  auth: string;
}

interface Offer {
  offerId: string;
  sku: string;
  status: "UNPUBLISHED" | "PUBLISHED";
  listingId?: string;
  body: any;
}

class FakeEbay {
  calls: Call[] = [];
  items = new Map<string, any>();
  offers = new Map<string, Offer>();
  media = 0;
  seq = 0;
  required: string[] = ["Sport", "Card Number"];
  rejectItemSkus = new Set<string>();
  /** The error a rejected item's entry carries. */
  itemRejection: Record<string, unknown> = { errorId: 25709, message: "RAW-EBAY-TEXT" };
  /** Answers every call 401 while > 0. */
  unauthorized = 0;
  onItems?: (skus: string[]) => Promise<void>;
  /** Awaited inside each publish call (the offer id): holds publishes open to measure how many run at once. */
  publishGate?: (offerId: string) => Promise<void>;
  publishing = 0;
  maxPublishing = 0;

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      json: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.Authorization ?? "",
    };
    this.calls.push(call);
    if (!ebayHosts().includes(u.origin)) throw new Error(`unexpected host ${u.origin}`);
    if (init?.redirect !== "error") throw new Error("an eBay call must refuse redirects");
    if (this.unauthorized > 0) {
      this.unauthorized -= 1;
      return new Response("", { status: 401 });
    }
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const p = call.path;
    if (p.endsWith("/get_item_aspects_for_category")) {
      return json({
        aspects: [
          ...this.required.map((n) => ({ localizedAspectName: n, aspectConstraint: { aspectRequired: true } })),
          { localizedAspectName: "Era", aspectConstraint: {} },
        ],
      });
    }
    if (p === "/commerce/media/v1_beta/image/create_image_from_file") {
      this.media += 1;
      return json({ imageUrl: `https://i.ebayimg.com/m${this.media}.jpg`, expirationDate: "2099-01-01T00:00:00.000Z" }, 201);
    }
    if (p === "/sell/inventory/v1/bulk_create_or_replace_inventory_item") {
      const reqs = call.json.requests as any[];
      await this.onItems?.(reqs.map((r) => r.sku));
      // eBay answers the whole call 400 when every entry failed.
      const allRejected = reqs.every((r) => this.rejectItemSkus.has(r.sku));
      return json(
        {
          responses: reqs.map((r) => {
            if (this.rejectItemSkus.has(r.sku)) {
              return { sku: r.sku, statusCode: 400, errors: [this.itemRejection] };
            }
            this.items.set(r.sku, r);
            return { sku: r.sku, statusCode: 200 };
          }),
        },
        allRejected ? 400 : 200,
      );
    }
    if (p === "/sell/inventory/v1/bulk_create_offer") {
      return json({
        responses: (call.json.requests as any[]).map((r) => {
          if ([...this.offers.values()].some((o) => o.sku === r.sku)) {
            return { sku: r.sku, statusCode: 400, errors: [{ errorId: 25002 }] };
          }
          const offerId = `O${++this.seq}`;
          this.offers.set(offerId, { offerId, sku: r.sku, status: "UNPUBLISHED", body: r });
          return { sku: r.sku, offerId, statusCode: 201 };
        }),
      });
    }
    const pub = /^\/sell\/inventory\/v1\/offer\/([^/]+)\/publish$/.exec(p);
    if (pub && call.method === "POST") {
      this.publishing += 1;
      this.maxPublishing = Math.max(this.maxPublishing, this.publishing);
      try {
        await this.publishGate?.(decodeURIComponent(pub[1]));
      } finally {
        this.publishing -= 1;
      }
      const offer = this.offers.get(decodeURIComponent(pub[1]));
      if (!offer) return json({ errors: [{ errorId: 25713 }] }, 404);
      offer.status = "PUBLISHED";
      offer.listingId ??= `L${++this.seq}`;
      return json({ listingId: offer.listingId, warnings: [] });
    }
    if (p === "/sell/inventory/v1/bulk_update_price_quantity") {
      return json({
        responses: (call.json.requests as any[]).map((r) => {
          const offer = this.offers.get(r.offers[0].offerId);
          if (offer) {
            offer.body = {
              ...offer.body,
              availableQuantity: r.offers[0].availableQuantity,
              pricingSummary: { price: r.offers[0].price },
            };
          }
          return { sku: r.sku, statusCode: 200 };
        }),
      });
    }
    if (p === "/sell/inventory/v1/offer" && call.method === "GET") {
      const sku = u.searchParams.get("sku");
      const found = [...this.offers.values()].filter((o) => o.sku === sku);
      return json(
        { offers: found.map((o) => ({ offerId: o.offerId, sku: o.sku, status: o.status, listing: o.listingId ? { listingId: o.listingId } : undefined })) },
      );
    }
    const put = /^\/sell\/inventory\/v1\/offer\/([^/]+)$/.exec(p);
    if (put && call.method === "PUT") {
      const offer = this.offers.get(decodeURIComponent(put[1]));
      if (!offer) return json({ errors: [{ errorId: 25713 }] }, 404);
      offer.body = { ...offer.body, ...call.json };
      return new Response(null, { status: 204 });
    }
    const wd = /^\/sell\/inventory\/v1\/offer\/([^/]+)\/withdraw$/.exec(p);
    if (wd) {
      const offer = this.offers.get(wd[1]);
      if (!offer) return json({ errors: [{ errorId: 25713 }] }, 404);
      offer.status = "UNPUBLISHED";
      const ended = offer.listingId;
      // eBay ends the listing: publishing the offer again makes a new one.
      delete offer.listingId;
      return json({ listingId: ended });
    }
    throw new Error(`unexpected eBay call ${call.method} ${p}`);
  }) as typeof fetch;

  to(path: string) {
    return this.calls.filter((c) => c.path === path);
  }
  /** Every single-offer publish call, in the order sent. */
  publishes() {
    return this.calls.filter((c) => c.method === "POST" && /^\/sell\/inventory\/v1\/offer\/[^/]+\/publish$/.test(c.path));
  }
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
  offerFor(sku: string) {
    return [...this.offers.values()].find((o) => o.sku === sku);
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

type T = ReturnType<typeof convexTest>;

async function seedVariant(t: T, opts: { name?: string; cards: Array<{ number: string }> }) {
  return t.run(async (ctx) => {
    const row = async (level: "sport" | "year" | "setName" | "variantType", value: string, parentId?: Id<"selectorOptions">) =>
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
    const set = await row("setName", opts.name ?? "Topps", year);
    const variant = await row("variantType", "Base", set);
    const cardIds: Array<Id<"cardChecklist">> = [];
    let i = 0;
    for (const c of opts.cards) {
      cardIds.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: variant,
          cardNumber: c.number,
          cardName: `Player ${c.number}`,
          listingTitle: `2021 Topps #${c.number}`,
          sportId: sport,
          platformData: {},
          isCustom: false,
          sortOrder: i++,
          lastUpdated: NOW,
        } as never),
      );
    }
    return { sportId: sport, variantId: variant, setId: set, cardIds };
  });
}

const COMPLETE_SETTINGS = {
  fulfillmentPolicyUnder20Id: "FP-ESE",
  fulfillmentPolicy20PlusId: "FP-TRACKED",
  paymentPolicyId: "PP-1",
  returnPolicyId: "RP-1",
  merchantLocationKey: "neonbinder-main",
  location: { postalCode: "53703", city: "Madison", stateOrProvince: "WI" },
};

async function setup(opts: { settings?: Record<string, unknown> | null } = {}) {
  const t = convexTest(schema, modules);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const inPerson = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "In person" })).containerId;
  await me.mutation(api.collectionContainers.setContainerListed, { containerId: inPerson, listed: false });
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: OWNER,
      marketplaceAccountIds: { ebayUserId: "EB-1" },
      siteCredentials: [{ site: "ebay", hasCredentials: true }],
    } as never);
    if (opts.settings !== null) {
      await ctx.db.insert("ebaySellerSettings", {
        ownerId: OWNER,
        ...COMPLETE_SETTINGS,
        ...(opts.settings ?? {}),
        lastUpdated: NOW,
      } as never);
    }
  });
  return { t, me, box, inPerson };
}
type S = Awaited<ReturnType<typeof setup>>;

async function listOnEbay(s: S, extra: Record<string, unknown> = {}) {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: OWNER,
      platform: "ebay",
      listingStartedAt: NOW,
      lastUpdated: NOW,
      ...extra,
    });
  });
}

const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });

/** Adds a copy and gives it a live front photo. */
async function addWithPhoto(s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>, token = `tok${cardId}`) {
  const r = await add(s, cardId, details);
  await s.t.run(async (ctx) => {
    await ctx.db.patch(r.copyId as Id<"collectionCopies">, { hasPhotos: true });
    await ctx.db.insert("collectionCopyPhotos", {
      ownerId: OWNER,
      copyId: r.copyId as Id<"collectionCopies">,
      side: "front",
      token,
      contentType: "image/jpeg",
      imageBytes: 1000,
      thumbBytes: 100,
      status: "live",
      since: NOW,
    });
  });
  return r;
}

async function queue(s: S, rows: Array<{ cardId: Id<"cardChecklist">; variantId: Id<"selectorOptions">; seq?: number }>) {
  return s.t.run(async (ctx) => {
    const ids: Array<Id<"listingOutbox">> = [];
    for (const r of rows) {
      const existing = await ctx.db
        .query("listingOutbox")
        .withIndex("by_owner_platform_card", (q) => q.eq("ownerId", OWNER).eq("platform", "ebay").eq("cardId", r.cardId))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { seq: r.seq ?? existing.seq, variantId: r.variantId });
        ids.push(existing._id);
      } else {
        ids.push(
          await ctx.db.insert("listingOutbox", {
            ownerId: OWNER,
            platform: "ebay",
            cardId: r.cardId,
            variantId: r.variantId,
            seq: r.seq ?? 1,
            changedAt: NOW,
          }),
        );
      }
    }
    return ids;
  });
}

const outbox = (s: S) => s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());
const links = (s: S) => s.t.run(async (ctx) => await ctx.db.query("marketplaceListingLinks").collect());
const linkOf = async (s: S, cardId: Id<"cardChecklist">, code: string) =>
  (await links(s)).find((l) => l.cardId === cardId && l.conditionCode === code) ?? null;
const record = (s: S, variantId: Id<"selectorOptions">) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) => q.eq("ownerId", OWNER).eq("variantId", variantId).eq("platform", "ebay"))
      .unique(),
  );
const state = (s: S) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", OWNER).eq("platform", "ebay"))
      .unique(),
  );

function stubCtx(t: T): DrainCtx {
  return {
    runQuery: ((ref: never, args: never) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runQuery"],
    runMutation: ((ref: never, args: never) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runMutation"],
    runAction: ((ref: never, args: never) => (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runAction"],
  };
}

let photoFetches: string[] = [];
const fetchPhoto = async (key: string): Promise<ArrayBuffer | null> => {
  photoFetches.push(key);
  return new ArrayBuffer(8);
};

/**
 * The wait before a busy publish's one retry: returns at once (no real
 * second), counting the waits and the time each asked for. A test that needs
 * the wait held open replaces `pause`.
 */
let pauses: number[] = [];
let pause = async (ms: number): Promise<void> => {
  pauses.push(ms);
};

const drain = (s: S, extra: { fullVariantIds?: Array<Id<"selectorOptions">> } = {}): Promise<DrainReport> =>
  drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "ebay", ...extra }, { fetchPhoto, pause: (ms) => pause(ms) });

let ebay: FakeEbay;

beforeEach(() => {
  creds.token = "tok-1";
  creds.refreshed = true;
  creds.tokenCalls = 0;
  creds.refreshCalls = 0;
  photoFetches = [];
  pauses = [];
  pause = async (ms: number): Promise<void> => {
    pauses.push(ms);
  };
  ebay = new FakeEbay();
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "production");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  vi.stubGlobal("fetch", ebay.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** One listed card: a Near Mint copy at `priceCents` with a photo, queued. */
async function oneCard(s: S, priceCents = 500, over: Record<string, unknown> = {}) {
  const v = await seedVariant(s.t, { cards: [{ number: "1" }] });
  const copy = await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: priceCents, ...over });
  await listOnEbay(s);
  await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
  return { v, card: v.cardIds[0], copy };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("eBay drain: the first sync", () => {
  test("creates the item, the offer and publishes; links the listing and counts it", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s, 500);

    const report = await drain(s);

    expect(report).toMatchObject({ claimed: true, stoppedFor: "done" });
    const sku = `NB2-${card}-NM`;
    const item = ebay.items.get(sku);
    expect(item).toMatchObject({
      sku,
      locale: "en_US",
      condition: "USED_VERY_GOOD",
      conditionDescriptors: [{ name: "40001", values: ["400010"] }],
      availability: { shipToLocationAvailability: { quantity: 1 } },
    });
    expect(item.product.title).toBe("2021 Topps #1");
    expect(item.product.imageUrls).toEqual(["https://i.ebayimg.com/m1.jpg"]);
    expect(item.product.aspects).toMatchObject({ Sport: ["Baseball"], "Card Number": ["1"], Graded: ["No"] });
    const offer = ebay.offerFor(sku);
    expect(offer?.status).toBe("PUBLISHED");
    expect(offer?.body).toMatchObject({
      availableQuantity: 1,
      categoryId: "261328",
      listingDuration: "GTC",
      merchantLocationKey: "neonbinder-main",
      pricingSummary: { price: { value: "5.00", currency: "USD" } },
      listingPolicies: {
        fulfillmentPolicyId: "FP-ESE",
        paymentPolicyId: "PP-1",
        returnPolicyId: "RP-1",
        bestOfferTerms: { bestOfferEnabled: true },
      },
    });
    const link = await linkOf(s, card, "NM");
    expect(link).toMatchObject({
      sku,
      status: "live",
      offerId: offer?.offerId,
      listingId: offer?.listingId,
      pushed: { quantity: 1, priceCents: 500, fulfillmentPolicyId: "FP-ESE" },
    });
    expect(await record(s, v.variantId)).toMatchObject({
      status: "idle",
      counts: { listed: 1, pushed: 1, zeroed: 0, skipped: 0 },
      problems: [],
    });
    expect(await outbox(s)).toHaveLength(0);
    expect((await state(s))?.platformAccountId).toBe("EB-1");
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    expect(ebay.calls.every((c) => c.auth === "Bearer tok-1")).toBe(true);
  });

  test("the price picks the shipping slot: $19.99 uses under-$20, $20.00 uses $20-and-up", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }, { number: "3" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 1999 });
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 2000 });
    await addWithPhoto(s, v.cardIds[2], { homeId: s.box, condition: "Near Mint", minPriceCents: 2001 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const slot = (i: number) => ebay.offerFor(`NB2-${v.cardIds[i]}-NM`)?.body.listingPolicies.fulfillmentPolicyId;
    expect([slot(0), slot(1), slot(2)]).toEqual(["FP-ESE", "FP-TRACKED", "FP-TRACKED"]);
  });

  test("the package follows the slot: a 1 oz letter under $20, a 6 oz padded mailer at $20.00 and up", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 1999 });
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 2000 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const pkg = (i: number) => ebay.items.get(`NB2-${v.cardIds[i]}-NM`).packageWeightAndSize;
    // No card weight saved: the letter weighs the default 1 oz, 6 x 4 x 1 in.
    expect(pkg(0)).toEqual({
      packageType: "LETTER",
      weight: { value: 1, unit: "OUNCE" },
      dimensions: { length: 6, width: 4, height: 1, unit: "INCH" },
    });
    expect(pkg(1)).toMatchObject({ packageType: "PADDED_BAGS", weight: { value: 6, unit: "OUNCE" } });
    // Calculated shipping wants dimensions on every item.
    for (const i of [0, 1]) {
      expect(pkg(i).dimensions).toMatchObject({ unit: "INCH", length: expect.any(Number), width: expect.any(Number), height: expect.any(Number) });
    }
  });

  test("the letter weighs the collector's card weight; the $20+ mailer stays 6 oz whatever it says", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").unique();
      await ctx.db.patch(row!._id, { cardWeightOz: 3 });
    });
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 1999 });
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 2000 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const pkg = (i: number) => ebay.items.get(`NB2-${v.cardIds[i]}-NM`).packageWeightAndSize;
    expect(pkg(0)).toMatchObject({ packageType: "LETTER", weight: { value: 3, unit: "OUNCE" } });
    expect(pkg(1)).toMatchObject({ packageType: "PADDED_BAGS", weight: { value: 6, unit: "OUNCE" } });
  });

  test("a floor under $0.99 lists at $0.99", async () => {
    const s = await setup();
    const { card } = await oneCard(s, 10);
    await drain(s);
    expect(ebay.offerFor(`NB2-${card}-NM`)?.body.pricingSummary.price.value).toBe("0.99");
  });

  test("copies fold by condition bucket: Mint + Near Mint is one NM listing, Good is a separate VG listing", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }] });
    const card = v.cardIds[0];
    await addWithPhoto(s, card, { homeId: s.box, condition: "Mint", minPriceCents: 300, acquiredOn: "2026-01-01" }, "tokA");
    await addWithPhoto(s, card, { homeId: s.box, condition: "Near Mint", minPriceCents: 800, quantity: 2, acquiredOn: "2026-02-01" }, "tokB");
    await addWithPhoto(s, card, { homeId: s.box, condition: "Good", minPriceCents: 100 }, "tokC");
    await listOnEbay(s);
    await queue(s, [{ cardId: card, variantId: v.variantId }]);

    await drain(s);

    expect(ebay.items.get(`NB2-${card}-NM`).availability.shipToLocationAvailability.quantity).toBe(3);
    expect(ebay.offerFor(`NB2-${card}-NM`)?.body.pricingSummary.price.value).toBe("8.00");
    expect(ebay.items.get(`NB2-${card}-VG`).conditionDescriptors[0].values).toEqual(["400012"]);
    expect(ebay.items.get(`NB2-${card}-VG`).availability.shipToLocationAvailability.quantity).toBe(1);
    expect((await record(s, v.variantId))?.counts).toMatchObject({ listed: 2, pushed: 2 });
  });

  test("a copy in an in-person box never lists", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.inPerson, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(ebay.writes()).toEqual([]);
    expect(await links(s)).toEqual([]);
    expect(await outbox(s)).toHaveLength(0);
  });

  test("more than 25 listings go to eBay in chunks of 25, and each offer is published on its own", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: Array.from({ length: 26 }, (_, i) => ({ number: String(i + 1) })) });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const sizes = (path: string) => ebay.to(path).map((c) => c.json.requests.length);
    expect(sizes("/sell/inventory/v1/bulk_create_or_replace_inventory_item")).toEqual([25, 1]);
    expect(sizes("/sell/inventory/v1/bulk_create_offer")).toEqual([25, 1]);
    expect(ebay.publishes()).toHaveLength(26);
    expect(ebay.maxPublishing).toBeLessThanOrEqual(EBAY_PUBLISH_CONCURRENCY);
    expect((await record(s, v.variantId))?.counts).toMatchObject({ listed: 26, pushed: 26 });
  });
});

describe("eBay drain: only what changed is sent", () => {
  test("a second run with nothing changed sends no write", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes()).toEqual([]);
    expect(await record(s, v.variantId)).toMatchObject({ status: "idle", counts: { listed: 1, pushed: 0, zeroed: 0 } });
    expect(await outbox(s)).toHaveLength(0);
  });

  test("a count change sends price and quantity only", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await addWithPhoto(s, card, { homeId: s.box, condition: "Near Mint", minPriceCents: 500, quantity: 2 }, "tokX");
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes().map((c) => c.path)).toEqual(["/sell/inventory/v1/bulk_update_price_quantity"]);
    expect(ebay.offerFor(`NB2-${card}-NM`)?.body.availableQuantity).toBe(3);
    expect((await linkOf(s, card, "NM"))?.pushed?.quantity).toBe(3);
  });

  test("a price crossing $20 swaps the offer's shipping policy and resends the item at the mailer weight", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s, 1999);
    await drain(s);
    const sku = `NB2-${card}-NM`;
    expect(ebay.items.get(sku).packageWeightAndSize.weight).toEqual({ value: 1, unit: "OUNCE" });
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { minPriceCents: 2000 });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    const paths = ebay.writes().map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      "POST /sell/inventory/v1/bulk_create_or_replace_inventory_item",
      `PUT /sell/inventory/v1/offer/${ebay.offerFor(sku)?.offerId}`,
    ]);
    expect(ebay.to("/commerce/media/v1_beta/image/create_image_from_file")).toHaveLength(0);
    expect(ebay.items.get(sku).packageWeightAndSize).toMatchObject({ packageType: "PADDED_BAGS", weight: { value: 6, unit: "OUNCE" } });
    expect(ebay.offerFor(sku)?.body.listingPolicies.fulfillmentPolicyId).toBe("FP-TRACKED");
    expect((await linkOf(s, card, "NM"))?.pushed).toMatchObject({ priceCents: 2000, fulfillmentPolicyId: "FP-TRACKED" });
  });

  test("a price falling back under $20 returns the item to the 1 oz letter and the envelope policy", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s, 2500);
    await drain(s);
    const sku = `NB2-${card}-NM`;
    expect(ebay.items.get(sku).packageWeightAndSize.weight).toEqual({ value: 6, unit: "OUNCE" });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { minPriceCents: 1500 });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.items.get(sku).packageWeightAndSize).toMatchObject({ packageType: "LETTER", weight: { value: 1, unit: "OUNCE" } });
    expect(ebay.offerFor(sku)?.body.listingPolicies.fulfillmentPolicyId).toBe("FP-ESE");
  });

  test("a price change inside one slot keeps the package, so the item is not resent", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s, 2500);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { minPriceCents: 3000 });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes().map((c) => c.path)).toEqual(["/sell/inventory/v1/bulk_update_price_quantity"]);
  });

  test("a changed card weight resends a live card under $20 at the new weight; nothing else is sent", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s, 1999);
    await drain(s);
    const sku = `NB2-${card}-NM`;
    expect(ebay.items.get(sku).packageWeightAndSize.weight).toEqual({ value: 1, unit: "OUNCE" });
    const before = (await linkOf(s, card, "NM"))?.pushed?.contentHash;
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").unique();
      await ctx.db.patch(row!._id, { cardWeightOz: 3 });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.to("/sell/inventory/v1/bulk_create_or_replace_inventory_item")).toHaveLength(1);
    expect(ebay.to("/commerce/media/v1_beta/image/create_image_from_file")).toHaveLength(0);
    expect(ebay.items.get(sku).packageWeightAndSize).toMatchObject({ packageType: "LETTER", weight: { value: 3, unit: "OUNCE" } });
    // The fingerprint covers the package, so the next run with the same weight sends nothing.
    const after = (await linkOf(s, card, "NM"))?.pushed?.contentHash;
    expect(after).not.toBe(before);
    ebay.calls = [];
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 3 }]);
    await drain(s);
    expect(ebay.writes()).toEqual([]);
  });

  test("a changed card weight sends nothing for a card at $20 and up (its mailer does not change)", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s, 2500);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").unique();
      await ctx.db.patch(row!._id, { cardWeightOz: 2 });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes()).toEqual([]);
  });

  test("a Best Offer change replaces the offer's terms", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").unique();
      await ctx.db.patch(row!._id, { bestOffer: false });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect(ebay.offerFor(`NB2-${card}-NM`)?.body.listingPolicies.bestOfferTerms).toEqual({ bestOfferEnabled: false });
  });

  test("changed listing text resends the item (and the photo is reused, not uploaded again)", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.patch(card, { listingTitle: "New title" });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.to("/sell/inventory/v1/bulk_create_or_replace_inventory_item")).toHaveLength(1);
    expect(ebay.to("/commerce/media/v1_beta/image/create_image_from_file")).toHaveLength(0);
    expect(ebay.items.get(`NB2-${card}-NM`).product.title).toBe("New title");
  });
});

describe("eBay drain: withdraw at zero and republish", () => {
  test("a count that goes to 0 withdraws the offer and the link goes ended; stock returning publishes again", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    const offerId = ebay.offerFor(`NB2-${card}-NM`)!.offerId;
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.delete(copy.copyId as Id<"collectionCopies">);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes().map((c) => c.path)).toEqual([`/sell/inventory/v1/offer/${offerId}/withdraw`]);
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "ended", offerId, pushed: { quantity: 0 } });
    expect(await record(s, v.variantId)).toMatchObject({ counts: { listed: 0, pushed: 1, zeroed: 1 } });

    // Stock returns.
    ebay.calls = [];
    await addWithPhoto(s, card, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "tokBack");
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 3 }]);
    await drain(s);

    const paths = ebay.writes().map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain(`POST /sell/inventory/v1/offer/${offerId}/publish`);
    expect(paths).toContain(`PUT /sell/inventory/v1/offer/${offerId}`);
    expect(paths).not.toContain("POST /sell/inventory/v1/bulk_create_offer");
    expect(ebay.offerFor(`NB2-${card}-NM`)?.status).toBe("PUBLISHED");
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "live", offerId, pushed: { quantity: 1 } });
  });

  test("a republish gets a new listing id and the link remembers the one it replaced, so a late sale on it still routes", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    const first = (await linkOf(s, card, "NM"))!.listingId;
    await s.t.run(async (ctx) => {
      await ctx.db.delete(copy.copyId as Id<"collectionCopies">);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    await addWithPhoto(s, card, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "tokAgain");
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 3 }]);
    await drain(s);

    const link = await linkOf(s, card, "NM");
    expect(link?.status).toBe("live");
    expect(link?.listingId).toBeTypeOf("string");
    expect(link?.listingId).not.toBe(first);
    expect(link?.previousListingIds).toEqual([first]);
  });

  test("an unlisted box (copy now in-person) withdraws a live listing", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { homeId: s.inPerson });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect((await linkOf(s, card, "NM"))?.status).toBe("ended");
  });

  test("a 404 on withdraw (eBay already ended it) still counts as zeroed", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    ebay.offers.clear();
    await s.t.run(async (ctx) => {
      await ctx.db.delete(copy.copyId as Id<"collectionCopies">);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect((await linkOf(s, card, "NM"))?.status).toBe("ended");
    expect((await record(s, v.variantId))?.counts.zeroed).toBe(1);
  });
});

describe("eBay drain: held-back cards", () => {
  async function holdFixture() {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }, { number: "5" }] });
    const [graded, noCond, noPrice, noPhoto, ok] = v.cardIds;
    await addWithPhoto(s, graded, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "t1");
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("collectionCopies").collect()).find((c) => c.cardId === graded)!;
      await ctx.db.patch(row._id, { grading: { grader: "PSA", grade: "9" } } as never);
    });
    await addWithPhoto(s, noCond, { homeId: s.box, minPriceCents: 500 }, "t2");
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("collectionCopies").collect()).find((c) => c.cardId === noCond)!;
      await ctx.db.patch(row._id, { condition: undefined });
    });
    await addWithPhoto(s, noPrice, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "t3");
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("collectionCopies").collect()).find((c) => c.cardId === noPrice)!;
      await ctx.db.patch(row._id, { minPriceCents: undefined });
    });
    await add(s, noPhoto, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await addWithPhoto(s, ok, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "t5");
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    return { s, v, graded, noCond, noPrice, noPhoto, ok };
  }

  test("graded, noCondition, noPrice and noPhoto are held back with a reason; the ready card lists", async () => {
    const { s, v, graded, noCond, noPrice, noPhoto, ok } = await holdFixture();
    await drain(s);
    const rec = await record(s, v.variantId);
    const reasons = new Map(rec!.problems.map((p) => [p.cardId, p.reason]));
    expect(reasons.get(graded)).toBe("graded");
    expect(reasons.get(noCond)).toBe("noCondition");
    expect(reasons.get(noPrice)).toBe("noPrice");
    expect(reasons.get(noPhoto)).toBe("noPhoto");
    expect(reasons.has(ok)).toBe(false);
    expect(rec?.counts).toMatchObject({ listed: 1, pushed: 1, skipped: 4 });
    expect([...ebay.items.keys()]).toEqual([`NB2-${ok}-NM`]);
  });

  test("a required aspect NB cannot fill holds the card back, naming the aspect", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    ebay.required = ["Sport", "Team"];
    await drain(s);
    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([expect.objectContaining({ cardId: card, reason: "missingAspect", detail: "Team" })]);
    expect(ebay.writes()).toEqual([]);
  });

  test("a held card with a live listing is left alone, never read as zero", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { minPriceCents: undefined });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes()).toEqual([]);
    expect((await linkOf(s, card, "NM"))?.status).toBe("live");
    expect((await record(s, v.variantId))?.problems[0]).toMatchObject({ reason: "noPrice" });
  });

  test("NEO-427: the oldest copy with photos supplies them when the oldest copy has none", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }] });
    const card = v.cardIds[0];
    const details = { homeId: s.box, condition: "Near Mint", minPriceCents: 500 };
    await add(s, card, { ...details, acquiredOn: "2020-01-01" });
    await addWithPhoto(s, card, { ...details, acquiredOn: "2021-01-01" }, "tmiddle");
    await addWithPhoto(s, card, { ...details, acquiredOn: "2022-01-01" }, "tnewest");
    await listOnEbay(s);
    await queue(s, [{ cardId: card, variantId: v.variantId }]);

    await drain(s);

    expect((await record(s, v.variantId))?.problems).toEqual([]);
    expect(ebay.items.has(`NB2-${card}-NM`)).toBe(true);
    expect(photoFetches).toEqual(["copy-photos/tmiddle/image.jpg"]);
  });

  test("NEO-427: a group held noPhoto is one where no copy has a photo", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }] });
    const card = v.cardIds[0];
    const details = { homeId: s.box, minPriceCents: 500 };
    await add(s, card, { ...details, condition: "Near Mint", acquiredOn: "2020-01-01" });
    await add(s, card, { ...details, condition: "Near Mint", acquiredOn: "2021-01-01" });
    // The photo is on a copy in another condition, so it is another listing's.
    await addWithPhoto(s, card, { ...details, condition: "Good" }, "tgood");
    await listOnEbay(s);
    await queue(s, [{ cardId: card, variantId: v.variantId }]);

    await drain(s);

    expect((await record(s, v.variantId))?.problems).toEqual([
      expect.objectContaining({ cardId: card, reason: "noPhoto" }),
    ]);
    expect(ebay.items.has(`NB2-${card}-NM`)).toBe(false);
    expect(photoFetches).toEqual(["copy-photos/tgood/image.jpg"]);
  });

  test("a card whose photo is oversized is held back noPhoto", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    await s.t.run(async (ctx) => {
      const photo = (await ctx.db.query("collectionCopyPhotos").collect())[0];
      await ctx.db.patch(photo._id, { imageBytes: 10 * 1024 * 1024 });
    });
    await drain(s);
    expect((await record(s, v.variantId))?.problems[0]).toMatchObject({ reason: "noPhoto" });
    expect(ebay.writes()).toEqual([]);
  });
});

describe("eBay drain: the setup gate and configuration", () => {
  test("incomplete settings refuse the claim, send nothing, keep the queue, and mark the variant", async () => {
    const s = await setup({ settings: { fulfillmentPolicy20PlusId: undefined } });
    const { v } = await oneCard(s);

    const report = await drain(s);

    expect(report).toMatchObject({ claimed: false, stoppedFor: "setupIncomplete" });
    expect(ebay.calls).toEqual([]);
    expect(await outbox(s)).toHaveLength(1);
    expect(await record(s, v.variantId)).toMatchObject({
      status: "error",
      lastError: EBAY_SETUP_INCOMPLETE_ERROR,
      problems: [{ reason: "setupIncomplete" }],
    });
  });

  test("no settings row at all is also setupIncomplete", async () => {
    const s = await setup({ settings: null });
    await oneCard(s);
    expect(await drain(s)).toMatchObject({ claimed: false, stoppedFor: "setupIncomplete" });
    expect(ebay.calls).toEqual([]);
  });

  test("a deployment not wired to eBay drains nothing and stays quiet", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const s = await setup();
    await oneCard(s);
    const report = await drain(s);
    expect(report.claimed).toBe(false);
    expect(ebay.calls).toEqual([]);
    expect(await outbox(s)).toHaveLength(1);
  });

  test("the public drain action dispatches an eBay owner to the eBay drain", async () => {
    const s = await setup({ settings: null });
    await oneCard(s);
    await s.t.action(internal.listingDrain.drainOwner, { ownerId: OWNER, platform: "ebay" });
    expect((await outbox(s)).length).toBe(1);
    await drainScheduled(s.t);
    expect(ebay.calls).toEqual([]);
  });

  test("no eBay token stops the drain and keeps the queue", async () => {
    const s = await setup();
    await oneCard(s);
    creds.token = null;
    const report = await drain(s);
    expect(report.stoppedFor).toBe("noToken");
    expect(await outbox(s)).toHaveLength(1);
  });

  test("the sentences that send a seller to their eBay settings name Profile → Credentials → eBay", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    creds.token = null;
    await drain(s);
    expect((await record(s, v.variantId))?.lastError).toBe(
      "NeonBinder couldn't reach your eBay account. Connect eBay again in Profile → Credentials → eBay.",
    );
    ebay.unauthorized = 99;
    creds.token = "tok-1";
    await drain(s);
    expect((await record(s, v.variantId))?.lastError).toBe(
      "eBay signed NeonBinder out. Connect eBay again in Profile → Credentials → eBay.",
    );
    expect(EBAY_SETUP_INCOMPLETE_ERROR).toBe(
      "Finish your eBay setup (shipping, payment, returns and ship-from) in Profile → Credentials → eBay, and these cards go up.",
    );
    expect(EBAY_STEP_SAYS.offers.refused).toBe(
      "eBay turned down this set's prices and policies. Check your shipping, payment and returns picks in Profile → Credentials → eBay, then press Sync.",
    );
    expect(EBAY_CARD_REJECTED.offers).toBe(
      "Its price or your eBay shipping, payment and returns picks didn't pass. Check them in Profile → Credentials → eBay, then press Sync.",
    );
    const all = [...Object.values(EBAY_STEP_SAYS).flatMap((x) => [x.refused, x.busy]), ...Object.values(EBAY_CARD_REJECTED)];
    expect(all.filter((line) => line.includes("Profile") && !line.includes("Profile → Credentials → eBay"))).toEqual([]);
    // A card's detail is stored capped at 160 characters: every one fits whole.
    expect(Object.values(EBAY_CARD_REJECTED).every((line) => line.length <= 160)).toBe(true);
  });

  test("a seller account NB cannot name sends them to Credentials → eBay", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    await s.t.run(async (ctx) => {
      const profile = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(profile!._id, { marketplaceAccountIds: {} } as never);
    });
    await drain(s);
    expect((await record(s, v.variantId))?.lastError).toBe(
      "NeonBinder doesn't know which eBay account this is. Connect eBay again in Profile → Credentials → eBay.",
    );
  });

  test("a paused eBay stops the drain before any call", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    const s = await setup();
    await oneCard(s);
    const report = await drain(s);
    expect(report).toMatchObject({ claimed: true, stoppedFor: "paused" });
    expect(ebay.calls).toEqual([]);
    expect(await outbox(s)).toHaveLength(1);
  });

  test("a second 401 after a refresh signs the drain out and keeps the queue", async () => {
    const s = await setup();
    await oneCard(s);
    ebay.unauthorized = 99;
    const report = await drain(s);
    expect(report.stoppedFor).toBe("signedOut");
    expect(creds.refreshCalls).toBe(1);
    expect(await outbox(s)).toHaveLength(1);
    expect(await links(s)).toEqual([]);
  });

  test("another NB owner holding the same eBay account stops this one", async () => {
    const s = await setup();
    await oneCard(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: OTHER,
        platform: "ebay",
        listingStartedAt: NOW,
        platformAccountId: "EB-1",
        lastUpdated: NOW,
      });
    });
    const report = await drain(s);
    expect(report.stoppedFor).toBe("sellerConflict");
    expect(ebay.writes()).toEqual([]);
    expect((await state(s))?.dormant).toBe("sellerConflict");
  });
});

describe("eBay drain: eBay's answers", () => {
  test("an item eBay refuses is rejected in NB's words (its error id only in the log), and the other card still lists", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "a");
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "b");
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    ebay.rejectItemSkus.add(`NB2-${v.cardIds[0]}-NM`);

    const logs = vi.spyOn(console, "log");
    await drain(s);

    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([{ cardId: v.cardIds[0], reason: "rejected", detail: EBAY_CARD_REJECTED.items }]);
    expect(JSON.stringify(rec)).not.toContain("RAW-EBAY-TEXT");
    expect(JSON.stringify(rec)).not.toContain("25709");
    // eBay's id goes to the structured log line, with the step it hit.
    const rejected = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ebay_listing_rejected"));
    expect(rejected.map((l) => JSON.parse(l))).toEqual([
      {
        msg: "ebay_listing_rejected",
        platform: "ebay",
        operation: "items",
        errorIds: [25709],
        errors: [{ errorId: 25709, message: "RAW-EBAY-TEXT" }],
      },
    ]);
    logs.mockRestore();
    expect(await linkOf(s, v.cardIds[0], "NM")).toBeNull();
    expect((await linkOf(s, v.cardIds[1], "NM"))?.status).toBe("live");
    expect(rec?.counts).toMatchObject({ listed: 1, skipped: 1 });
  });

  test("a bulk item call eBay answers 400 logs each entry's message and parameters, and the record keeps NB's words", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const sku = `NB2-${card}-NM`;
    ebay.rejectItemSkus.add(sku);
    ebay.itemRejection = {
      errorId: 25717,
      domain: "API_INVENTORY",
      category: "REQUEST",
      message: "RAW-EBAY-TEXT about an aspect",
      longMessage: "RAW-EBAY-LONG the value of Card Number is too long",
      parameters: [
        { name: "aspectName", value: "Card Number" },
        { name: "field", value: "product.aspects.Card Number" },
      ],
    };

    const logs = vi.spyOn(console, "log");
    await drain(s);

    const rejected = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ebay_listing_rejected"));
    logs.mockRestore();
    expect(rejected.map((l) => JSON.parse(l))).toEqual([
      {
        msg: "ebay_listing_rejected",
        platform: "ebay",
        operation: "items",
        errorIds: [25717],
        errors: [
          {
            errorId: 25717,
            message: "RAW-EBAY-TEXT about an aspect",
            longMessage: "RAW-EBAY-LONG the value of Card Number is too long",
            parameters: [
              { name: "aspectName", value: "Card Number" },
              { name: "field", value: "product.aspects.Card Number" },
            ],
          },
        ],
      },
    ]);
    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([{ cardId: card, reason: "rejected", detail: EBAY_CARD_REJECTED.items }]);
    expect(JSON.stringify(rec)).not.toContain("RAW-EBAY");
    expect(JSON.stringify(rec)).not.toContain("25717");
  });

  test("an offer eBay already holds for the SKU (25002) is adopted and brought to NB's values", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s, 700);
    const sku = `NB2-${card}-NM`;
    ebay.offers.set("OLD", { offerId: "OLD", sku, status: "UNPUBLISHED", body: { pricingSummary: { price: { value: "1.00" } } } });

    await drain(s);

    expect(ebay.offers.size).toBe(1);
    expect(ebay.offers.get("OLD")).toMatchObject({ status: "PUBLISHED" });
    expect(ebay.offers.get("OLD")?.body.pricingSummary.price.value).toBe("7.00");
    expect(await linkOf(s, card, "NM")).toMatchObject({ offerId: "OLD", status: "live" });
    expect((await record(s, v.variantId))?.problems).toEqual([]);
  });

  test("an adopted offer that is already published is not published again", async () => {
    const s = await setup();
    const { card } = await oneCard(s, 700);
    const sku = `NB2-${card}-NM`;
    ebay.offers.set("OLD", { offerId: "OLD", sku, status: "PUBLISHED", listingId: "LIVE9", body: {} });
    await drain(s);
    expect(ebay.publishes()).toHaveLength(0);
    expect(await linkOf(s, card, "NM")).toMatchObject({ offerId: "OLD", listingId: "LIVE9", status: "live" });
  });

  /** Twelve cards in one variant, each with a photo, listed and queued. */
  async function twelveCards(s: S) {
    const v = await seedVariant(s.t, { cards: Array.from({ length: 12 }, (_, i) => ({ number: String(i + 1) })) });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    return v;
  }

  test("offers are published side by side, never more than EBAY_PUBLISH_CONCURRENCY at once", async () => {
    const s = await setup();
    const v = await twelveCards(s);
    ebay.publishGate = () => new Promise((r) => setTimeout(r, 10));
    await drain(s);
    expect(EBAY_PUBLISH_CONCURRENCY).toBe(10);
    expect(ebay.publishes()).toHaveLength(12);
    // All ten start before any answers: wall clock is the slowest publish, not their sum.
    expect(ebay.maxPublishing).toBe(EBAY_PUBLISH_CONCURRENCY);
    for (const cardId of v.cardIds) expect(await linkOf(s, cardId, "NM")).toMatchObject({ status: "live", listingId: expect.any(String) });
    expect((await record(s, v.variantId))?.counts).toMatchObject({ listed: 12, pushed: 12 });
  });

  test("eBay refusing one offer's publish rejects that card only; the others go live", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    const [refused, fine] = v.cardIds;
    const real = ebay.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const m = /\/offer\/([^/]+)\/publish$/.exec(new URL(String(url)).pathname);
      if (m && ebay.offers.get(decodeURIComponent(m[1]))?.sku === `NB2-${refused}-NM`) {
        return Response.json({ errors: [{ errorId: 25007, message: "RAW-EBAY-TEXT" }] }, { status: 400 });
      }
      return real(url, init);
    }) as typeof fetch);
    const logs = vi.spyOn(console, "log");
    await drain(s);
    const rejected = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ebay_listing_rejected"));
    logs.mockRestore();
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0])).toMatchObject({ operation: "publish", errorIds: [25007] });
    expect(await linkOf(s, refused, "NM")).toMatchObject({ status: "draft" });
    expect(await linkOf(s, fine, "NM")).toMatchObject({ status: "live", listingId: expect.any(String) });
    const rec = await record(s, v.variantId);
    expect(rec?.status).not.toBe("error");
    expect(rec?.problems).toEqual([expect.objectContaining({ cardId: refused, reason: "rejected", detail: EBAY_CARD_REJECTED.publish })]);
    expect(JSON.stringify(rec)).not.toContain("RAW-EBAY-TEXT");
  });

  test("a publish that fails outright starts no further publish and stops the run once those in flight are back", async () => {
    const s = await setup();
    const v = await twelveCards(s);
    ebay.publishGate = () => new Promise((r) => setTimeout(r, 10));
    const real = ebay.fetch;
    let publishCalls = 0;
    let busyOffer: string | null = null;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const m = /\/offer\/([^/]+)\/publish$/.exec(new URL(String(url)).pathname);
      if (m) {
        publishCalls += 1;
        busyOffer ??= m[1];
        // eBay stays busy for this offer: its one retry fails too.
        if (m[1] === busyOffer) return Response.json({ errors: [{ errorId: 1 }] }, { status: 503 });
      }
      return real(url, init);
    }) as typeof fetch);
    await drain(s);
    // The first ten started together, plus the busy one's single retry; none started after it failed.
    expect(publishCalls).toBe(EBAY_PUBLISH_CONCURRENCY + 1);
    expect(pauses).toHaveLength(1);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.busy);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: failed"]);
  });

  test("a publish that fails outright still records every listing that went live before the run stopped", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }, { number: "3" }] });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    // The other two are still in flight when the first one fails.
    ebay.publishGate = () => new Promise((r) => setTimeout(r, 10));
    const real = ebay.fetch;
    let failedOffer: string | null = null;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const m = /\/offer\/([^/]+)\/publish$/.exec(new URL(String(url)).pathname);
      if (m) failedOffer ??= decodeURIComponent(m[1]);
      // Busy for that one offer, its retry included.
      if (m && decodeURIComponent(m[1]) === failedOffer) {
        return Response.json({ errors: [{ errorId: 1 }] }, { status: 503 });
      }
      return real(url, init);
    }) as typeof fetch);

    await drain(s);

    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.busy);
    const failedSku = ebay.offers.get(failedOffer as unknown as string)?.sku;
    let live = 0;
    for (const cardId of v.cardIds) {
      const link = await linkOf(s, cardId, "NM");
      const offer = ebay.offerFor(`NB2-${cardId}-NM`);
      if (offer?.sku === failedSku) {
        expect(link).toMatchObject({ status: "draft" });
        expect(link?.listingId).toBeUndefined();
      } else {
        // Live on eBay, and NB knows it: the listing id is linked now, not on the next run.
        expect(offer?.status).toBe("PUBLISHED");
        expect(link).toMatchObject({ status: "live", listingId: offer?.listingId, pushed: { quantity: 1, priceCents: 500 } });
        live += 1;
      }
    }
    expect(live).toBe(2);
  });

  test("a publish eBay refuses leaves the offer linked as a draft and reports it", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const real = ebay.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith("/publish")) {
        return Response.json({ errors: [{ errorId: 25007 }] }, { status: 400 });
      }
      return real(url, init);
    }) as typeof fetch);

    const logs = vi.spyOn(console, "log");
    await drain(s);

    // The log line names the offer's fulfillment policy (a 25007 is about that policy).
    const rejected = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ebay_listing_rejected"));
    logs.mockRestore();
    expect(rejected.map((l) => JSON.parse(l))).toEqual([
      { msg: "ebay_listing_rejected", platform: "ebay", operation: "publish", errorIds: [25007], fulfillmentPolicyId: "FP-ESE" },
    ]);
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "draft" });
    expect((await linkOf(s, card, "NM"))?.listingId).toBeUndefined();
    expect((await record(s, v.variantId))?.problems[0]).toMatchObject({ reason: "rejected", detail: EBAY_CARD_REJECTED.publish });
    expect((await record(s, v.variantId))?.counts.listed).toBe(0);
  });
});

// ── NEO-415: one retry when eBay answers a publish busy (5xx or 429) ────────

/**
 * Answers each publish through `answer(sku, nth)` (nth = that offer's 1-based
 * publish count): a status gets an error body, null goes to the fake eBay.
 * Returns the SKUs published, in the order sent.
 */
function publishAnswers(answer: (sku: string, nth: number) => number | null): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const real = ebay.fetch;
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const m = /\/offer\/([^/]+)\/publish$/.exec(new URL(String(url)).pathname);
    if (m) {
      const sku = ebay.offers.get(decodeURIComponent(m[1]))?.sku ?? "?";
      const nth = (counts.get(sku) ?? 0) + 1;
      counts.set(sku, nth);
      order.push(sku);
      const status = answer(sku, nth);
      if (status !== null) return Response.json({ errors: [{ errorId: 25001, message: "RAW-EBAY-TEXT" }] }, { status });
    }
    return real(url, init);
  }) as typeof fetch);
  return order;
}

const publishCallLines = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.operation === "publishOffer");

describe("eBay drain: a busy publish is tried once more", () => {
  test.each([500, 429])("eBay busy (%i) then fine: the one retry goes live and the run carries on", async (status) => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const order = publishAnswers((_sku, nth) => (nth === 1 ? status : null));
    const log = vi.spyOn(console, "log");

    await drain(s);

    const lines = publishCallLines(log);
    log.mockRestore();
    expect(order).toHaveLength(2);
    expect(pauses).toEqual([EBAY_PUBLISH_RETRY_PAUSE_MS]);
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "live", listingId: expect.any(String) });
    const rec = await record(s, v.variantId);
    expect(rec?.lastError).toBeUndefined();
    expect(rec?.counts).toMatchObject({ listed: 1, pushed: 1 });
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: done"]);
    // Each try has its own call line; the retry's says so. eBay's text stays out of the call lines.
    const calls = lines.filter((l) => l.msg === "ebay_seller_call");
    expect(calls).toEqual([
      expect.objectContaining({ outcome: "http_error", httpStatus: status }),
      expect.objectContaining({ outcome: "ok", httpStatus: 200, attempt: 2 }),
    ]);
    expect(calls[0]).not.toHaveProperty("attempt");
    expect(lines.filter((l) => l.msg === "ebay_seller_error")).toEqual([expect.objectContaining({ httpStatus: status, errorIds: [25001] })]);
  });

  test("eBay busy twice: the run stops as eBay busy, as before", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const order = publishAnswers(() => 500);
    const log = vi.spyOn(console, "log");

    await drain(s);

    const errors = publishCallLines(log).filter((l) => l.msg === "ebay_seller_error");
    log.mockRestore();
    expect(order).toHaveLength(2);
    expect(pauses).toHaveLength(1);
    expect(errors).toEqual([
      expect.not.objectContaining({ attempt: expect.anything() }),
      expect.objectContaining({ httpStatus: 500, attempt: 2 }),
    ]);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.busy);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: failed"]);
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "draft" });
  });

  test("eBay refusing the offer (400) is not retried: that card is rejected", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const order = publishAnswers(() => 400);
    await drain(s);
    expect(order).toHaveLength(1);
    expect(pauses).toEqual([]);
    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "draft" });
    expect((await record(s, v.variantId))?.problems[0]).toMatchObject({ reason: "rejected", detail: EBAY_CARD_REJECTED.publish });
  });

  test("eBay refusing the seller (403) is not retried: the run stops", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    const order = publishAnswers(() => 403);
    await drain(s);
    expect(order).toHaveLength(1);
    expect(pauses).toEqual([]);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.refused);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: failed"]);
  });

  test("a retry waiting out its pause counts as in flight: another publish stopping the run still records the retry's listing", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    const [retried, stopper] = v.cardIds;
    const retriedSku = `NB2-${retried}-NM`;
    let stopperAnswered!: () => void;
    const stopperBack = new Promise<void>((r) => (stopperAnswered = r));
    const order = publishAnswers((sku, nth) => {
      if (sku === retriedSku) return nth === 1 ? 503 : null;
      stopperAnswered();
      return 403;
    });
    // Hold the retry until the other publish has failed outright and halted the pool.
    pause = async (ms) => {
      pauses.push(ms);
      await stopperBack;
      await new Promise((r) => setTimeout(r, 5));
    };

    await drain(s);

    expect(order).toEqual([retriedSku, `NB2-${stopper}-NM`, retriedSku]);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.refused);
    // Live on eBay through the retry, and linked in this run: no lost link.
    const offer = ebay.offerFor(retriedSku);
    expect(offer?.status).toBe("PUBLISHED");
    expect(await linkOf(s, retried, "NM")).toMatchObject({ status: "live", listingId: offer?.listingId });
    expect(await linkOf(s, stopper, "NM")).toMatchObject({ status: "draft" });
  });
});

describe("eBay drain: the outbox rows", () => {
  test("a row whose seq moved during the push survives; the others are cleared", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "a");
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "b");
    await listOnEbay(s);
    const [row1, row2] = await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    ebay.onItems = async () => {
      await s.t.run(async (ctx) => {
        await ctx.db.patch(row2, { seq: 2 });
      });
    };

    await drain(s);

    const left = await outbox(s);
    expect(left.map((r) => r._id)).toEqual([row2]);
    expect(left.some((r) => r._id === row1)).toBe(false);
  });

  test("a deleted card's row is cleared and a re-homed card's row follows it to its new variant", async () => {
    const s = await setup();
    const a = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }, { number: "3" }] });
    const b = await seedVariant(s.t, { name: "Other", cards: [] });
    await listOnEbay(s);
    const [, movedRow, goneRow] = await queue(s, a.cardIds.map((cardId) => ({ cardId, variantId: a.variantId })));
    await s.t.run(async (ctx) => {
      await ctx.db.patch(a.cardIds[1], { selectorOptionId: b.variantId });
      await ctx.db.delete(a.cardIds[2]);
    });

    await drain(s);

    // The deleted card's row is gone; the moved card's row was re-pointed to
    // B and settled there by the same run (B has no stock for it).
    expect(await outbox(s)).toEqual([]);
    expect(await record(s, b.variantId)).not.toBeNull();
    expect(movedRow).not.toBe(goneRow);
    expect(ebay.calls).toEqual([]);
  });

  test("a re-homed card's live listing is not withdrawn by its old variant's run", async () => {
    const s = await setup();
    const a = await seedVariant(s.t, { cards: [{ number: "1" }] });
    const b = await seedVariant(s.t, { name: "Other", cards: [] });
    const copy = await addWithPhoto(s, a.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, [{ cardId: a.cardIds[0], variantId: a.variantId }]);
    await drain(s);
    ebay.calls = [];
    // The card is re-homed to variant B; its copy no longer sits under A.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(a.cardIds[0], { selectorOptionId: b.variantId });
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { variantId: b.variantId, setId: b.setId } as never);
    });
    await queue(s, [{ cardId: a.cardIds[0], variantId: a.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.calls.filter((c) => c.path.endsWith("/withdraw"))).toEqual([]);
    expect((await linkOf(s, a.cardIds[0], "NM"))?.status).toBe("live");
  });

  test("a link row whose card was deleted stays put and does not break the run", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingLinks", {
        ownerId: OWNER,
        platform: "ebay",
        cardId: v.cardIds[1],
        conditionCode: "NM",
        sku: `NB2-${v.cardIds[1]}-NM`,
        offerId: "ZZ",
        listingId: "LZ",
        status: "live",
        lastUpdated: NOW,
      });
      await ctx.db.delete(v.cardIds[1]);
    });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drain(s, { fullVariantIds: [v.variantId] });

    expect(report.stoppedFor).toBe("done");
    expect(await links(s)).toHaveLength(2);
    expect((await linkOf(s, v.cardIds[0], "NM"))?.status).toBe("live");
    expect(ebay.calls.filter((c) => c.path.endsWith("/withdraw"))).toEqual([]);
  });

  test("a full read finds a live listing for a card that has no queued row and withdraws it when its stock is gone", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingLinks", {
        ownerId: OWNER,
        platform: "ebay",
        cardId: v.cardIds[1],
        conditionCode: "NM",
        sku: `NB2-${v.cardIds[1]}-NM`,
        offerId: "OZ",
        listingId: "LZ",
        status: "live",
        lastUpdated: NOW,
      });
    });
    ebay.offers.set("OZ", { offerId: "OZ", sku: `NB2-${v.cardIds[1]}-NM`, status: "PUBLISHED", listingId: "LZ", body: {} });

    await drain(s, { fullVariantIds: [v.variantId] });

    expect((await linkOf(s, v.cardIds[1], "NM"))?.status).toBe("ended");
    expect(ebay.offers.get("OZ")?.status).toBe("UNPUBLISHED");
  });
});

describe("eBay drain: a card or variant that left the catalog", () => {
  test("a deleted card's queued row takes its live listing down, records it ended and clears the row", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    const offerId = ebay.offerFor(`NB2-${card}-NM`)!.offerId;
    ebay.calls = [];
    // A card a collector holds a copy of cannot be deleted, so the copy goes first.
    await s.t.run(async (ctx) => {
      await ctx.db.delete(copy.copyId as Id<"collectionCopies">);
      await ctx.db.delete(card);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes().map((c) => c.path)).toEqual([`/sell/inventory/v1/offer/${offerId}/withdraw`]);
    expect((await linkOf(s, card, "NM"))?.status).toBe("ended");
    expect(await outbox(s)).toEqual([]);
  });

  test("if eBay will not end a deleted card's listing, its row stays queued for the next run and the link stays live", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    await s.t.run(async (ctx) => {
      await ctx.db.delete(copy.copyId as Id<"collectionCopies">);
      await ctx.db.delete(card);
    });
    const [rowId] = await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    const real = ebay.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/withdraw") ? Response.json({ errors: [{ errorId: 1 }] }, { status: 500 }) : real(url, init)) as typeof fetch);

    await drain(s);

    expect((await outbox(s)).map((r) => r._id)).toEqual([rowId]);
    expect((await linkOf(s, card, "NM"))?.status).toBe("live");
  });

  test("a deleted variant's queued cards have their live listings taken down", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      await ctx.db.delete(v.variantId);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.calls.filter((c) => c.path.endsWith("/withdraw"))).toHaveLength(1);
    expect((await linkOf(s, card, "NM"))?.status).toBe("ended");
  });
});

// ── NEO-415: the run's steps on the sync record, and the step's own words ──

/** A record's ledger, compact: "kind: status". */
const stepsOf = async (s: S, variantId: Id<"selectorOptions">): Promise<string[] | null> => {
  const rec = await record(s, variantId);
  return rec?.progress?.steps.map((x) => `${x.kind}: ${x.status}`) ?? null;
};

/** Answers one eBay path with `status` (an error body carrying `errorId`), every other call as the fake does. */
function failPath(suffix: string, status: number, errorId = 25001) {
  const real = ebay.fetch;
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname.endsWith(suffix)) {
      return Response.json({ errors: [{ errorId, message: "RAW-EBAY-TEXT" }] }, { status });
    }
    return real(url, init);
  }) as typeof fetch);
}

describe("eBay drain: the run's steps (NEO-415)", () => {
  test("a first listing ticks off photos, items, offers and publish in order, one at a time", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    const seen: Array<string[] | null> = [];
    ebay.onItems = async () => {
      seen.push(await stepsOf(s, v.variantId));
    };

    await drain(s);

    // While the items went up: the compare and photos done, items working, the rest waiting.
    expect(seen).toEqual([["check: done", "photos: done", "items: working", "offers: waiting", "publish: waiting"]]);
    const rec = await record(s, v.variantId);
    expect(rec?.progress?.steps.map((x) => `${x.kind}: ${x.status}`)).toEqual([
      "check: done",
      "photos: done",
      "items: done",
      "offers: done",
      "publish: done",
    ]);
    expect(rec?.progress?.steps.every((x) => typeof x.finishedAt === "number" && x.condition === undefined)).toBe(true);
    expect(rec?.progress?.runStartedAt).toBe(rec?.lastRunAt);
  });

  test("a live card's price and quantity update goes out before a new card is published, and the ledger reads offers then publish", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    const [live, fresh] = v.cardIds;
    await addWithPhoto(s, live, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, [{ cardId: live, variantId: v.variantId }]);
    await drain(s);
    // The live card's count changes and a new card arrives, in one run.
    await addWithPhoto(s, live, { homeId: s.box, condition: "Near Mint", minPriceCents: 500, quantity: 2 }, "tokLive2");
    await addWithPhoto(s, fresh, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await queue(s, [
      { cardId: live, variantId: v.variantId, seq: 2 },
      { cardId: fresh, variantId: v.variantId },
    ]);
    ebay.calls = [];

    await drain(s);

    const order = ebay.writes().map((c) => c.path);
    const update = order.indexOf("/sell/inventory/v1/bulk_update_price_quantity");
    const publish = order.findIndex((path) => path.endsWith("/publish"));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(update);
    expect(ebay.offerFor(`NB2-${live}-NM`)?.body.availableQuantity).toBe(3);
    expect(ebay.offerFor(`NB2-${fresh}-NM`)?.status).toBe("PUBLISHED");
    const steps = await stepsOf(s, v.variantId);
    expect(steps).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: done"]);
  });

  test("only the steps the run takes: a count change is one offers step; a count at 0 is one withdraw step", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    await addWithPhoto(s, card, { homeId: s.box, condition: "Near Mint", minPriceCents: 500, quantity: 2 }, "tokX");
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "offers: done"]);

    await s.t.run(async (ctx) => {
      const copies = await ctx.db.query("collectionCopies").collect();
      for (const c of copies) await ctx.db.delete(c._id);
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 3 }]);
    await drain(s);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "withdraw: done"]);
  });

  test("nothing to send ends on the compare step alone and replaces the last run's steps", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    expect(await stepsOf(s, v.variantId)).toHaveLength(5);
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done"]);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("idle");
    expect(rec?.lastError).toBeUndefined();
    expect(rec?.progress?.steps.every((x) => typeof x.finishedAt === "number")).toBe(true);
    expect(rec?.counts?.pushed).toBe(0);
  });

  test("a first run where no card is priced and none is live ends on the compare step alone", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await s.t.run(async (ctx) => {
      const copies = await ctx.db.query("collectionCopies").collect();
      for (const c of copies) await ctx.db.patch(c._id, { minPriceCents: undefined });
    });

    await drain(s);

    expect(await stepsOf(s, v.variantId)).toEqual(["check: done"]);
    expect((await record(s, v.variantId))?.problems).toEqual([expect.objectContaining({ cardId: card, reason: "noPrice" })]);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("idle");
    expect(rec?.lastError).toBeUndefined();
    expect(rec?.counts?.pushed).toBe(0);
    expect(ebay.writes()).toHaveLength(0);
  });

  test("eBay refusing the items marks that step failed, drops the later steps, and says so in NB words", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    failPath("/bulk_create_or_replace_inventory_item", 400, 25709);

    await drain(s);

    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toBe(EBAY_STEP_SAYS.items.refused);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: failed"]);
    const json = JSON.stringify(rec);
    expect(json).not.toContain("25709");
    expect(json).not.toContain("RAW-EBAY-TEXT");
    expect(json).not.toContain("turned that one down");
  });

  test("eBay busy on the publish names the publish step and the way forward", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    failPath("/publish", 503);

    await drain(s);

    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.publish.busy);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: failed"]);
  });

  test("eBay refusing the offers says which step and what to check", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    failPath("/bulk_create_offer", 400);
    await drain(s);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.offers.refused);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: failed"]);
  });

  test("eBay refusing the category read (before any listing step) says so in NB words and fails the compare step", async () => {
    const s = await setup();
    const { v } = await oneCard(s);
    failPath("/get_item_aspects_for_category", 400);
    await drain(s);
    expect((await record(s, v.variantId))?.lastError).toBe(EBAY_STEP_SAYS.aspects.refused);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: failed"]);
  });

  test("a withdraw eBay refuses: the step finishes (the run goes on), the card says so in NB words", async () => {
    const s = await setup();
    const { v, card, copy } = await oneCard(s);
    await drain(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(copy.copyId as Id<"collectionCopies">, { homeId: s.inPerson });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    failPath("/withdraw", 400, 25013);
    await drain(s);
    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([expect.objectContaining({ reason: "rejected", detail: EBAY_CARD_REJECTED.withdraw })]);
    expect(JSON.stringify(rec)).not.toContain("25013");
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "withdraw: done"]);
  });

  test("an unfinished-setup mark clears the last run's steps (no run happened)", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    expect(await stepsOf(s, v.variantId)).toHaveLength(5);
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").first();
      await ctx.db.patch(row!._id, { paymentPolicyId: undefined });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect(await record(s, v.variantId)).toMatchObject({ lastError: EBAY_SETUP_INCOMPLETE_ERROR });
    expect(await stepsOf(s, v.variantId)).toBeNull();
  });
});

// ── Photo uploads eBay will not take ─────────────────────────────────────────

const MEDIA_CREATE = "/commerce/media/v1_beta/image/create_image_from_file";

/**
 * Answers the next uploads from `answers` (a status and eBay error id each;
 * `null` lets the fake take it), then the fake answers as usual. Counts every
 * upload attempt in `uploads`.
 */
function mediaAnswers(answers: Array<{ status: number; errorId: number } | null>) {
  const real = ebay.fetch;
  const seen = { uploads: 0 };
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname === MEDIA_CREATE) {
      seen.uploads += 1;
      const next = answers.shift();
      if (next) {
        ebay.calls.push({ method: "POST", path: MEDIA_CREATE, query: new URLSearchParams(), json: undefined, auth: "" });
        return Response.json(
          { errors: [{ errorId: next.errorId, domain: "API_MEDIA", category: "APPLICATION", message: "RAW-EBAY-TEXT" }] },
          { status: next.status },
        );
      }
    }
    return real(url, init);
  }) as typeof fetch);
  return seen;
}

/** Two listed cards with photos, queued. */
async function twoCards(s: S) {
  const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
  for (const cardId of v.cardIds) {
    await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
  }
  await listOnEbay(s);
  await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
  return v;
}

describe("eBay drain: photo uploads eBay will not take", () => {
  test("eBay's upload failing (500, its 190000) stops the uploads, fails the photos step in NB words and keeps every card queued", async () => {
    const s = await setup();
    const v = await twoCards(s);
    const media = mediaAnswers([{ status: 500, errorId: 190000 }, { status: 500, errorId: 190000 }]);

    const report = await drain(s);

    // One upload, then no more this run: eBay is not hammered card by card.
    expect(media.uploads).toBe(1);
    expect(ebay.writes().filter((c) => c.path !== MEDIA_CREATE)).toEqual([]);
    expect(report.variants).toEqual([{ variantId: v.variantId, result: "error" }]);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toBe(EBAY_STEP_SAYS.photos.busy);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: failed"]);
    const json = JSON.stringify(rec);
    expect(json).not.toContain("190000");
    expect(json).not.toContain("RAW-EBAY-TEXT");
    // Not lost: both cards wait for the next run.
    expect((await outbox(s)).map((r) => r.cardId).sort()).toEqual([...v.cardIds].sort());
    expect(await links(s)).toEqual([]);
  });

  test("the next run, with eBay's upload back, lists the cards the failed run kept queued", async () => {
    const s = await setup();
    const v = await twoCards(s);
    mediaAnswers([{ status: 500, errorId: 190000 }]);
    await drain(s);

    await drain(s);

    for (const cardId of v.cardIds) {
      expect(ebay.offerFor(`NB2-${cardId}-NM`)?.status).toBe("PUBLISHED");
    }
    const rec = await record(s, v.variantId);
    expect(rec).toMatchObject({ status: "idle", counts: { listed: 2, pushed: 2, zeroed: 0, skipped: 0 } });
    expect(rec?.lastError).toBeUndefined();
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: done"]);
    expect(await outbox(s)).toHaveLength(0);
  });

  test("an upload that fails after another landed: the first card lists, the second stays queued, the run says photos", async () => {
    const s = await setup();
    const v = await twoCards(s);
    const media = mediaAnswers([null, { status: 503, errorId: 190000 }]);

    await drain(s);

    expect(media.uploads).toBe(2);
    const published = v.cardIds.filter((cardId) => ebay.offerFor(`NB2-${cardId}-NM`)?.status === "PUBLISHED");
    expect(published).toHaveLength(1);
    const waiting = v.cardIds.filter((cardId) => !published.includes(cardId));
    expect((await outbox(s)).map((r) => r.cardId)).toEqual(waiting);
    expect(await linkOf(s, published[0], "NM")).toMatchObject({ status: "live" });
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toBe(EBAY_STEP_SAYS.photos.busy);
    expect(rec?.conditionsPushed).toEqual(["NM"]);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: failed", "items: done", "offers: done", "publish: done"]);
  });

  test("a picture eBay refuses (400) is that card's problem in NB words; the other card lists and the run is ok", async () => {
    const s = await setup();
    const v = await twoCards(s);
    const media = mediaAnswers([{ status: 400, errorId: 190203 }]);

    await drain(s);

    expect(media.uploads).toBe(2);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("idle");
    expect(rec?.problems).toEqual([expect.objectContaining({ reason: "rejected", detail: EBAY_CARD_REJECTED.photos })]);
    const refusedCard = rec?.problems[0].cardId;
    const other = v.cardIds.find((cardId) => cardId !== refusedCard);
    expect(ebay.offerFor(`NB2-${other}-NM`)?.status).toBe("PUBLISHED");
    expect(ebay.offerFor(`NB2-${refusedCard}-NM`)).toBeUndefined();
    expect(JSON.stringify(rec)).not.toContain("190203");
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: done"]);
    // A refused picture is not retried every run: its row clears with the rest.
    expect(await outbox(s)).toHaveLength(0);
  });
});

describe("eBay drain: the sandbox has no picture upload", () => {
  // eBay's Media API reference, Input on createImageFromFile and
  // createImageFromUrl: "This method is not supported in Sandbox environment."
  // Yet the sandbox refuses an item with no picture (errorId 25717), so each
  // item carries NB's fixed sandbox test picture instead.

  test("on the sandbox nothing is uploaded: no photos step, items carry NB's test picture, nothing is stored as one", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    const s = await setup();
    const { v, card } = await oneCard(s, 500);
    const media = mediaAnswers([]);

    const report = await drain(s);

    expect(report).toMatchObject({ claimed: true, stoppedFor: "done" });
    expect(media.uploads).toBe(0);
    expect(ebay.to(MEDIA_CREATE)).toHaveLength(0);
    expect(photoFetches).toEqual([]);
    const sku = `NB2-${card}-NM`;
    expect(ebay.items.get(sku)?.product.imageUrls).toEqual([EBAY_SANDBOX_TEST_PICTURE_URL]);
    expect(ebay.offerFor(sku)?.status).toBe("PUBLISHED");
    const link = await linkOf(s, card, "NM");
    expect(link).toMatchObject({ sku, status: "live" });
    expect(link?.images ?? []).toEqual([]);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "items: done", "offers: done", "publish: done"]);
    expect(await record(s, v.variantId)).toMatchObject({ status: "idle", counts: { listed: 1, pushed: 1, zeroed: 0, skipped: 0 } });
    expect(await outbox(s)).toHaveLength(0);
  });

  test("on the sandbox a card whose copy has no photo is still held back noPhoto; the card with one lists", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    const [noPhoto, ok] = v.cardIds;
    await add(s, noPhoto, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await addWithPhoto(s, ok, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([expect.objectContaining({ cardId: noPhoto, reason: "noPhoto" })]);
    expect([...ebay.items.keys()]).toEqual([`NB2-${ok}-NM`]);
    expect(ebay.items.get(`NB2-${ok}-NM`)?.product.imageUrls).toEqual([EBAY_SANDBOX_TEST_PICTURE_URL]);
    expect(ebay.to(MEDIA_CREATE)).toHaveLength(0);
  });

  test("on the sandbox a second run with nothing changed sends no write (the test picture never moves the fingerprint)", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.writes()).toEqual([]);
    expect(await record(s, v.variantId)).toMatchObject({ status: "idle", counts: { listed: 1, pushed: 0, zeroed: 0 } });
    expect(await outbox(s)).toHaveLength(0);
  });

  test("on the sandbox a changed photo still resends the item, with the same test picture and no upload", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    const s = await setup();
    const { v, card } = await oneCard(s);
    await drain(s);
    ebay.calls = [];
    await s.t.run(async (ctx) => {
      const photo = (await ctx.db.query("collectionCopyPhotos").collect())[0];
      await ctx.db.patch(photo._id, { token: "tokRetaken" });
    });
    await queue(s, [{ cardId: card, variantId: v.variantId, seq: 2 }]);

    await drain(s);

    expect(ebay.to("/sell/inventory/v1/bulk_create_or_replace_inventory_item")).toHaveLength(1);
    expect(ebay.to(MEDIA_CREATE)).toHaveLength(0);
    expect(ebay.items.get(`NB2-${card}-NM`)?.product.imageUrls).toEqual([EBAY_SANDBOX_TEST_PICTURE_URL]);
  });

  test("on production the same card's photo is uploaded and its picture sent and stored", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s, 500);

    await drain(s);

    expect(ebay.to(MEDIA_CREATE)).toHaveLength(1);
    expect(photoFetches).toHaveLength(1);
    const sku = `NB2-${card}-NM`;
    expect(ebay.items.get(sku)?.product.imageUrls).toEqual(["https://i.ebayimg.com/m1.jpg"]);
    expect((await linkOf(s, card, "NM"))?.images).toEqual([
      expect.objectContaining({ url: "https://i.ebayimg.com/m1.jpg" }),
    ]);
    expect(await stepsOf(s, v.variantId)).toEqual(["check: done", "photos: done", "items: done", "offers: done", "publish: done"]);
  });
});

describe("inPool", () => {
  test("runs every item with at most `limit` in flight, starting them in order", async () => {
    let inFlight = 0;
    let most = 0;
    const started: number[] = [];
    await inPool(
      Array.from({ length: 7 }, (_, i) => i),
      3,
      async (i) => {
        started.push(i);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(most).toBe(3);
  });

  test("starts nothing once halted; an empty list or a zero limit is fine", async () => {
    const started: number[] = [];
    let halt = false;
    await inPool(
      [0, 1, 2, 3, 4],
      2,
      async (i) => {
        started.push(i);
        if (i === 1) halt = true;
      },
      () => halt,
    );
    expect(started).toEqual([0, 1]);
    await inPool([], 10, async () => {
      throw new Error("never");
    });
    const one: number[] = [];
    await inPool([9], 0, async (i) => void one.push(i));
    expect(one).toEqual([9]);
  });
});
