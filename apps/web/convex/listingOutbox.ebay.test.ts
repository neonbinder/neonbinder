/**
 * NEO-415 — the listing outbox generalised to eBay: eBay carries every
 * catalog card (NB makes the listing and keys it by its own SKU), a deployment
 * not wired to eBay (or one that paused it) does not reach it, the eBay seller
 * id is the one the connect recorded, and the three writers that move an
 * eBay listing without a copy count changing queue the card: attaching a
 * photo, removing or swapping one, and a change to the common price.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  LISTING_CREDENTIAL_SITE,
  LISTING_PLATFORMS,
  carriesPlatformRef,
  enqueueListingCards,
  kickOwnerDrains,
  listingCredentialOf,
  platformReachable,
  pushesCountsNow,
  sellerAccountHolder,
} from "./listingOutbox";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_outbox_001" };
const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  vi.stubEnv("TESTING_RESET_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  return { t, fx, me };
}
type S = Awaited<ReturnType<typeof setup>>;

async function listOn(s: S, platforms: Array<"bsc" | "ebay">) {
  await s.t.run(async (ctx) => {
    for (const platform of platforms) {
      await ctx.db.insert("marketplaceListingStates", { ownerId: ME.subject, platform, listingStartedAt: NOW, lastUpdated: NOW });
    }
  });
}
const outbox = (s: S) => s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());
const queuedFor = async (s: S, cardId: Id<"cardChecklist">) =>
  (await outbox(s)).filter((r) => r.cardId === cardId).map((r) => r.platform).sort();

describe("platforms and reachability", () => {
  test("eBay is a listing platform signed in under site ebay", () => {
    expect(LISTING_PLATFORMS).toEqual(["bsc", "ebay"]);
    expect(LISTING_CREDENTIAL_SITE).toEqual({ bsc: "buysportscards", ebay: "ebay" });
  });

  test("eBay is reachable only when wired and not paused; BSC ignores the eBay wiring", () => {
    expect(platformReachable("ebay")).toBe(true);
    vi.stubEnv("EBAY_CLIENT_ID", "");
    expect(platformReachable("ebay")).toBe(false);
    expect(platformReachable("bsc")).toBe(true);
    vi.stubEnv("EBAY_CLIENT_ID", "cid");
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    expect(platformReachable("ebay")).toBe(false);
    expect(platformReachable("bsc")).toBe(true);
  });

  test("an unwired eBay row does not push counts now, a wired one does", () => {
    const row = { platform: "ebay" as const, listingStartedAt: NOW, dormant: undefined, testListingOff: undefined };
    expect(pushesCountsNow(row)).toBe(true);
    vi.stubEnv("EBAY_ENVIRONMENT", "");
    expect(pushesCountsNow(row)).toBe(false);
  });
});

describe("eBay carries every catalog card", () => {
  test("a card with no marketplace ids is carried by eBay and not by BSC", () => {
    const bare = { platformData: {} };
    expect(carriesPlatformRef(bare, "ebay")).toBe(true);
    expect(carriesPlatformRef(bare, "bsc")).toBe(false);
    expect(carriesPlatformRef({ platformData: { bsc: { ref: "x", src: "b0" } } }, "bsc")).toBe(true);
  });

  test("queueing a card with no BSC id writes an eBay row and no BSC row", async () => {
    const s = await setup();
    await listOn(s, ["bsc", "ebay"]);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.fx.gooden1, { platformData: {} });
      await enqueueListingCards(ctx as never, { ownerId: ME.subject, cardIds: [s.fx.gooden1, s.fx.strawberry2] });
    });
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["ebay"]);
    expect(await queuedFor(s, s.fx.strawberry2)).toEqual(["bsc", "ebay"]);
  });

  test("an owner listing only on eBay is queued only for eBay", async () => {
    const s = await setup();
    await listOn(s, ["ebay"]);
    await s.t.run(async (ctx) => {
      await enqueueListingCards(ctx as never, { ownerId: ME.subject, cardIds: [s.fx.gooden1] });
    });
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["ebay"]);
  });

  test("a kick on an unwired deployment keeps the eBay queue and schedules no drain", async () => {
    const s = await setup();
    await listOn(s, ["ebay"]);
    await s.t.run(async (ctx) => {
      await enqueueListingCards(ctx as never, { ownerId: ME.subject, cardIds: [s.fx.gooden1] });
    });
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const kicks = await s.t.run(async (ctx) => await kickOwnerDrains(ctx as never, ME.subject));
    expect(JSON.stringify(kicks)).not.toContain("scheduled");
    expect(await outbox(s)).toHaveLength(1);
    const scheduled = await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("drainOwner"))).toEqual([]);
  });
});

describe("the eBay seller account", () => {
  test("listingCredentialOf reads the eBay user id as the seller id; BSC still reads its own", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: ME.subject,
        marketplaceAccountIds: { bscSellerId: "bsc-seller", ebayUserId: "EB-7" },
        siteCredentials: [{ site: "ebay", hasCredentials: true }],
      } as never);
    });
    const read = (platform: "bsc" | "ebay") => s.t.run(async (ctx) => await listingCredentialOf(ctx as never, ME.subject, platform));
    expect(await read("ebay")).toMatchObject({ hasCredentials: true, sellerId: "EB-7" });
    expect(await read("bsc")).toMatchObject({ hasCredentials: false, sellerId: "bsc-seller" });
  });

  test("another owner on the same eBay account is a conflict, except on a sandbox testing deployment", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: "other", platform: "ebay", listingStartedAt: NOW, platformAccountId: "EB-7", lastUpdated: NOW });
    });
    const holder = () => s.t.run(async (ctx) => await sellerAccountHolder(ctx as never, "ebay", "EB-7", ME.subject));
    expect((await holder())?.ownerId).toBe("other");
    vi.stubEnv("TESTING_RESET_SECRET", "s");
    expect(await holder()).toBeNull();
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    expect((await holder())?.ownerId).toBe("other");
  });
});

describe("photo changes queue the card", () => {
  async function copyOf(s: S) {
    const { copyId } = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1 } });
    return copyId;
  }
  const attach = async (s: S, copyId: Id<"collectionCopies">, side: "front" | "back" = "front") => {
    const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId,
      side,
      contentType: "image/jpeg",
      imageBytes: 1000,
      thumbBytes: 100,
    });
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
  };

  test("attaching a photo queues the card on every platform the owner lists on", async () => {
    const s = await setup();
    const copyId = await copyOf(s);
    await listOn(s, ["bsc", "ebay"]);
    expect(await outbox(s)).toEqual([]);
    await attach(s, copyId);
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["bsc", "ebay"]);
    await drainScheduled(s.t);
  });

  test("an owner who lists nowhere gets no rows from a photo", async () => {
    const s = await setup();
    const copyId = await copyOf(s);
    await attach(s, copyId);
    expect(await outbox(s)).toEqual([]);
  });

  test("replacing, swapping and removing a photo each queue the card again", async () => {
    const s = await setup();
    const copyId = await copyOf(s);
    await attach(s, copyId, "front");
    await listOn(s, ["ebay"]);
    const clear = () =>
      s.t.run(async (ctx) => {
        for (const r of await ctx.db.query("listingOutbox").collect()) await ctx.db.delete(r._id);
      });

    await s.me.mutation(api.copyPhotos.swap, { copyId });
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["ebay"]);
    await clear();
    await attach(s, copyId, "front");
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["ebay"]);
    await clear();
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "front" });
    expect(await queuedFor(s, s.fx.gooden1)).toEqual(["ebay"]);
    await clear();
    // The swap left a photo on the back; take it off, then there is nothing
    // left to remove or swap and nothing is queued.
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "back" });
    await clear();
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "back" });
    await s.me.mutation(api.copyPhotos.swap, { copyId });
    expect(await outbox(s)).toEqual([]);
    await drainScheduled(s.t);
  });
});

describe("a common price change queues the variant", () => {
  const rowsFor = async (s: S) => (await outbox(s)).map((r) => [r.platform, r.variantId]);

  test("setting, changing and clearing the price each queue one wake card per listing platform", async () => {
    const s = await setup();
    await listOn(s, ["bsc", "ebay"]);
    const clear = () =>
      s.t.run(async (ctx) => {
        for (const r of await ctx.db.query("listingOutbox").collect()) await ctx.db.delete(r._id);
      });

    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 25 });
    expect((await rowsFor(s)).sort()).toEqual([["bsc", s.fx.baseId], ["ebay", s.fx.baseId]].sort());
    await clear();
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 30 });
    expect(await outbox(s)).toHaveLength(2);
    await clear();
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: null });
    expect(await outbox(s)).toHaveLength(2);
    await drainScheduled(s.t);
  });

  test("setting the same price again, or clearing a price that was never set, queues nothing", async () => {
    const s = await setup();
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 25 });
    await listOn(s, ["bsc", "ebay"]);
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 25 });
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.goldId, priceCents: null });
    expect(await outbox(s)).toEqual([]);
  });

  test("an owner who lists nowhere queues nothing", async () => {
    const s = await setup();
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 25 });
    expect(await outbox(s)).toEqual([]);
  });

  test("the wake card of an eBay-only owner needs no BSC id", async () => {
    const s = await setup();
    await listOn(s, ["ebay"]);
    await s.t.run(async (ctx) => {
      for (const id of [s.fx.gooden1, s.fx.strawberry2, s.fx.gooden1Sliding]) await ctx.db.patch(id, { platformData: {} });
    });
    await s.me.mutation(api.commonPrices.set, { variantId: s.fx.baseId, priceCents: 25 });
    expect(await rowsFor(s)).toEqual([["ebay", s.fx.baseId]]);
  });
});
