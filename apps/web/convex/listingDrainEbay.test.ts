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
const API = "https://api.sandbox.ebay.com";

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
  /** Answers every call 401 while > 0. */
  unauthorized = 0;
  onItems?: (skus: string[]) => Promise<void>;

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
    if (u.origin !== API && u.origin !== "https://apim.sandbox.ebay.com") throw new Error(`unexpected host ${u.origin}`);
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
      return json({
        responses: reqs.map((r) => {
          if (this.rejectItemSkus.has(r.sku)) {
            return { sku: r.sku, statusCode: 400, errors: [{ errorId: 25709, message: "RAW-EBAY-TEXT" }] };
          }
          this.items.set(r.sku, r);
          return { sku: r.sku, statusCode: 200 };
        }),
      });
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
    if (p === "/sell/inventory/v1/bulk_publish_offer") {
      return json({
        responses: (call.json.requests as any[]).map((r) => {
          const offer = this.offers.get(r.offerId);
          if (!offer) return { offerId: r.offerId, statusCode: 404, errors: [{ errorId: 25713 }] };
          offer.status = "PUBLISHED";
          offer.listingId ??= `L${++this.seq}`;
          return { offerId: r.offerId, statusCode: 200, listingId: offer.listingId };
        }),
      });
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

const drain = (s: S, extra: { fullVariantIds?: Array<Id<"selectorOptions">> } = {}): Promise<DrainReport> =>
  drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "ebay", ...extra }, { fetchPhoto });

let ebay: FakeEbay;

beforeEach(() => {
  creds.token = "tok-1";
  creds.refreshed = true;
  creds.tokenCalls = 0;
  creds.refreshCalls = 0;
  photoFetches = [];
  ebay = new FakeEbay();
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
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
    expect(pkg(0)).toMatchObject({ packageType: "LETTER", weight: { value: 1, unit: "OUNCE" } });
    expect(pkg(1)).toMatchObject({ packageType: "PADDED_BAGS", weight: { value: 6, unit: "OUNCE" } });
    // Calculated shipping wants dimensions on every item.
    for (const i of [0, 1]) {
      expect(pkg(i).dimensions).toMatchObject({ unit: "INCH", length: expect.any(Number), width: expect.any(Number), height: expect.any(Number) });
    }
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

  test("more than 25 listings go to eBay in chunks of 25", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: Array.from({ length: 26 }, (_, i) => ({ number: String(i + 1) })) });
    for (const cardId of v.cardIds) await addWithPhoto(s, cardId, { homeId: s.box, condition: "Near Mint", minPriceCents: 500 });
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));

    await drain(s);

    const sizes = (path: string) => ebay.to(path).map((c) => c.json.requests.length);
    expect(sizes("/sell/inventory/v1/bulk_create_or_replace_inventory_item")).toEqual([25, 1]);
    expect(sizes("/sell/inventory/v1/bulk_create_offer")).toEqual([25, 1]);
    expect(sizes("/sell/inventory/v1/bulk_publish_offer")).toEqual([25, 1]);
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
    expect(paths).toContain("POST /sell/inventory/v1/bulk_publish_offer");
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
  test("an item eBay refuses is rejected with its error id only, and the other card still lists", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1" }, { number: "2" }] });
    await addWithPhoto(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "a");
    await addWithPhoto(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 500 }, "b");
    await listOnEbay(s);
    await queue(s, v.cardIds.map((cardId) => ({ cardId, variantId: v.variantId })));
    ebay.rejectItemSkus.add(`NB2-${v.cardIds[0]}-NM`);

    await drain(s);

    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([
      { cardId: v.cardIds[0], reason: "rejected", detail: "eBay refused this listing (error 25709)." },
    ]);
    expect(JSON.stringify(rec)).not.toContain("RAW-EBAY-TEXT");
    expect(await linkOf(s, v.cardIds[0], "NM")).toBeNull();
    expect((await linkOf(s, v.cardIds[1], "NM"))?.status).toBe("live");
    expect(rec?.counts).toMatchObject({ listed: 1, skipped: 1 });
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
    expect(ebay.to("/sell/inventory/v1/bulk_publish_offer")).toHaveLength(0);
    expect(await linkOf(s, card, "NM")).toMatchObject({ offerId: "OLD", listingId: "LIVE9", status: "live" });
  });

  test("a publish eBay refuses leaves the offer linked as a draft and reports it", async () => {
    const s = await setup();
    const { v, card } = await oneCard(s);
    const real = ebay.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/bulk_publish_offer")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ responses: body.requests.map((r: any) => ({ offerId: r.offerId, statusCode: 400, errors: [{ errorId: 25007 }] })) });
      }
      return real(url, init);
    }) as typeof fetch);

    await drain(s);

    expect(await linkOf(s, card, "NM")).toMatchObject({ status: "draft" });
    expect((await linkOf(s, card, "NM"))?.listingId).toBeUndefined();
    expect((await record(s, v.variantId))?.problems[0]).toMatchObject({ reason: "rejected", detail: "eBay refused this listing (error 25007)." });
    expect((await record(s, v.variantId))?.counts.listed).toBe(0);
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
