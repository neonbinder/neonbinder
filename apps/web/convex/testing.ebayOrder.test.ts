/**
 * NEO-520 — `testing.seedMyTestEbayOrder`, the unmatched-eBay-sale spec's hop:
 * a raw Fulfillment order on the CALLER's account whose lines NeonBinder did
 * not list, run through the poll's own projection (`projectEbayOrder`, then
 * `projectEbayOrderForRecord` with no floor) and recorded and applied by the
 * poll's cores with only the poll gate skipped. Fails closed without
 * `TESTING_RESET_SECRET`; refuses a caller who pushes counts anywhere; reads
 * and writes only the caller's rows; a retry applies nothing twice; `ship`
 * takes the order off the Pick List and keeps the stored titles; nothing
 * reaches a marketplace (fetch is a spy that throws, the outbox stays empty).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { LISTED_TITLE_MAX } from "./lib/ebayListing";
import { TEST_SALE_ORDER_PREFIX } from "./lib/testSeedMarks";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = "user_ebayseed_aaaa";
const USER_B = "user_ebayseed_bbbb";
const NOW = 1_700_000_000_000;

let fetchCalls: string[];
beforeEach(() => {
  fetchCalls = [];
  vi.stubEnv("TESTING_RESET_SECRET", "test-enabled");
  vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    throw new Error(`the eBay order seed must not fetch ${String(url)}`);
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const user = async (subject: string) => {
    const me = t.withIdentity({ subject });
    await me.mutation(api.collectionContainers.ensureSystem, {});
    const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Ebay w1-abc" })).containerId;
    return { me, box };
  };
  const cardId = await t.run(async (ctx) => {
    const row = (level: string, value: string, parentId?: unknown) =>
      ctx.db.insert("selectorOptions", { level, value, platformData: {}, isCustom: false, children: [], ...(parentId ? { parentId } : {}), lastUpdated: NOW } as never);
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const set = await row("setName", "Topps Chrome", year);
    const variant = await row("variantType", "Base", set);
    return ctx.db.insert("cardChecklist", {
      selectorOptionId: variant,
      cardNumber: "901",
      cardName: "Player 901",
      listingTitle: "Card 901",
      sportId: sport,
      platformData: {},
      sortOrder: 0,
      lastUpdated: NOW,
    } as never);
  });
  const a = await user(USER_A);
  const b = await user(USER_B);
  // One copy of a card in the caller's box: the seed must leave it alone.
  await a.me.mutation(api.collection.addLineItem, { cardId, details: { homeId: a.box, quantity: 1, condition: "Near Mint" } as never });
  return { t, a, b, cardId };
}
type S = Awaited<ReturnType<typeof setup>>;

const seed = (s: S, args: Record<string, unknown>, who = s.a.me) =>
  who.mutation(api.testing.seedMyTestEbayOrder, { orderNo: "ebay1", lines: [{ title: "Vintage binder lot", quantity: 1 }], ...args } as never);

const sales = (s: S) => s.t.run(async (ctx) => await ctx.db.query("marketplaceSales").collect());
const quantity = (s: S) =>
  s.t.run(async (ctx) => (await ctx.db.query("collectionCopies").collect()).filter((c) => c.cardId !== undefined).reduce((n, c) => n + c.quantity, 0));
const openFor = (s: S, ownerId: string) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query("marketplaceSales")
        .withIndex("by_owner_pull_open", (q) => q.eq("ownerId", ownerId).eq("pullOpen", true))
        .collect()
    ).map((r) => r.orderId),
  );

describe("seedMyTestEbayOrder", () => {
  test("throws when TESTING_RESET_SECRET is unset, and writes nothing", async () => {
    const s = await setup();
    vi.stubEnv("TESTING_RESET_SECRET", "");
    await expect(seed(s, {})).rejects.toThrow(/not enabled/);
    expect(await sales(s)).toEqual([]);
  });

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.testing.seedMyTestEbayOrder, { orderNo: "ebay1", lines: [{ quantity: 1 }] })).rejects.toThrow(/Not authenticated/);
  });

  test("refuses a caller who pushes counts to any marketplace, and writes nothing", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: USER_A, platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
    });
    await expect(seed(s, {})).rejects.toThrow(/pushes to a marketplace/);
    expect(await sales(s)).toEqual([]);
  });

  test("a caller held off by the test marker is let through", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: USER_A, platform: "ebay", listingStartedAt: NOW, testListingOff: true, lastUpdated: NOW });
    });
    expect(await seed(s, {})).toMatchObject({ lines: 1, applied: 0 });
  });

  test("records the title through the real projection: an unmatched, unapplied eBay line, on the Pick List, touching no box", async () => {
    const s = await setup();
    const r = await seed(s, { lines: [{ title: "  Vintage binder lot ", quantity: 2 }] });
    expect(r).toMatchObject({ lines: 1, applied: 0 });
    const [stored] = await sales(s);
    expect(stored).toMatchObject({
      _id: r.saleId,
      ownerId: USER_A,
      platform: "ebay",
      orderId: `${TEST_SALE_ORDER_PREFIX}ebay1`,
      orderNo: "ebay1",
      status: "NOT_STARTED",
      pullOpen: true,
    });
    expect(stored.items).toEqual([
      expect.objectContaining({
        platformCardId: "nb-test-item-1",
        sellerSku: "nb-test-other-1",
        condition: "",
        quantity: 2,
        priceCents: 100,
        applied: false,
        problem: "unmatched",
        listed: { title: "Vintage binder lot" },
      }),
    ]);
    expect(stored.items[0].cardId).toBeUndefined();
    expect(await quantity(s)).toBe(1);
    expect(await openFor(s, USER_A)).toEqual([`${TEST_SALE_ORDER_PREFIX}ebay1`]);
  });

  test("up to three lines, numbered; a line with no title stores no listed", async () => {
    const s = await setup();
    await seed(s, { lines: [{ title: "One", quantity: 1 }, { quantity: 3 }, { title: "Three", quantity: 1 }] });
    const [stored] = await sales(s);
    expect(stored.items.map((i) => [i.platformCardId, i.sellerSku, i.listed?.title])).toEqual([
      ["nb-test-item-1", "nb-test-other-1", "One"],
      ["nb-test-item-2", "nb-test-other-2", undefined],
      ["nb-test-item-3", "nb-test-other-3", "Three"],
    ]);
    expect(stored.items[1].listed).toBeUndefined();
    expect(stored.totals).toMatchObject({ subtotalCents: 500, totalCents: 500 });
  });

  test("stores no buyer, ship-to or any key beyond the order the poll reads", async () => {
    const s = await setup();
    await seed(s, {});
    const text = JSON.stringify(await sales(s));
    for (const word of ["buyer", "shipTo", "fullName", "address"]) expect(text).not.toContain(word);
  });

  test("writes only the caller's rows", async () => {
    const s = await setup();
    await seed(s, {});
    expect((await sales(s)).map((r) => r.ownerId)).toEqual([USER_A]);
    expect(await openFor(s, USER_B)).toEqual([]);
    // The same orderNo for the other user is its own order.
    await seed(s, {}, s.b.me);
    expect((await sales(s)).map((r) => r.ownerId).sort()).toEqual([USER_A, USER_B]);
  });

  test("a retry with the same orderNo keeps the stored order as it is, whatever lines it names", async () => {
    const s = await setup();
    const first = await seed(s, { lines: [{ title: "First", quantity: 1 }] });
    const before = (await sales(s))[0];
    const again = await seed(s, { lines: [{ title: "Second", quantity: 5 }, { quantity: 1 }] });
    expect(again).toEqual({ saleId: first.saleId, lines: 1, applied: 0 });
    const all = await sales(s);
    expect(all).toHaveLength(1);
    expect(all[0].items.map((i) => [i.quantity, i.applied, i.problem])).toEqual(before.items.map((i) => [i.quantity, i.applied, i.problem]));
    expect(all[0].items[0].listed?.title).toBe("First");
    expect(await quantity(s)).toBe(1);
  });

  test("ship takes the order off the Pick List and keeps the title", async () => {
    const s = await setup();
    await seed(s, { lines: [{ title: "Keep me", quantity: 1 }] });
    const shipped = await seed(s, { ship: true, lines: undefined });
    expect(shipped.applied).toBe(0);
    const stored = (await sales(s))[0];
    expect(stored.status).toBe("FULFILLED");
    expect("pullOpen" in stored).toBe(false);
    expect(stored.items[0]).toMatchObject({ problem: "unmatched", listed: { title: "Keep me" } });
    expect(await openFor(s, USER_A)).toEqual([]);
  });

  test("a pulled mark survives the ship re-record", async () => {
    const s = await setup();
    await seed(s, {});
    const open = await s.a.me.query(api.pickList.open, {});
    await s.a.me.mutation(api.pickList.setPulled, { ids: [open.lines[0].id], pulled: true });
    const pulledAt = (await sales(s))[0].items[0].pulledAt;
    expect(pulledAt).toBeTypeOf("number");
    await seed(s, { ship: true });
    expect((await sales(s))[0].items[0].pulledAt).toBe(pulledAt);
  });

  test("ship with nothing seeded refuses", async () => {
    const s = await setup();
    await expect(seed(s, { ship: true })).rejects.toThrow(/No seeded eBay order/);
  });

  test.each([
    ["an orderNo that is not one token", { orderNo: "ebay 1" }, /one token/],
    ["no lines", { lines: [] }, /1-3 lines/],
    ["no lines argument", { lines: undefined }, /1-3 lines/],
    ["four lines", { lines: [1, 2, 3, 4].map(() => ({ quantity: 1 })) }, /1-3 lines/],
    // The quantity is bounded in the validator itself (whole numbers 1-10).
    ["a zero quantity", { lines: [{ quantity: 0 }] }, /Validator error/],
    ["a fractional quantity", { lines: [{ quantity: 1.5 }] }, /Validator error/],
    ["a quantity past the cap", { lines: [{ quantity: 11 }] }, /Validator error/],
    ["a blank title", { lines: [{ title: "   ", quantity: 1 }] }, /lines\[0\]\.title/],
    ["a title past the bound", { lines: [{ quantity: 1 }, { title: "t".repeat(LISTED_TITLE_MAX + 1), quantity: 1 }] }, /lines\[1\]\.title/],
    ["a title with a control character", { lines: [{ title: "bad\u0000title", quantity: 1 }] }, /lines\[0\]\.title/],
  ])("refuses %s, writing nothing", async (_name, args, err) => {
    const s = await setup();
    await expect(seed(s, args)).rejects.toThrow(err);
    expect(await sales(s)).toEqual([]);
  });

  test("every quantity from 1 to 10 passes the validator", async () => {
    const s = await setup();
    for (let q = 1; q <= 10; q += 1) {
      await expect(seed(s, { orderNo: `q${q}`, lines: [{ quantity: q }] })).resolves.toMatchObject({ lines: 1 });
    }
  });

  test("a retry or ship naming out-of-bounds lines is refused before anything is read or written", async () => {
    const s = await setup();
    await seed(s, {});
    const before = await sales(s);
    await expect(seed(s, { lines: [1, 2, 3, 4].map(() => ({ quantity: 1 })) })).rejects.toThrow(/1-3 lines/);
    await expect(seed(s, { ship: true, lines: [{ title: "t".repeat(LISTED_TITLE_MAX + 1), quantity: 1 }] })).rejects.toThrow(/lines\[0\]\.title/);
    await expect(seed(s, { ship: true, lines: [{ title: "bad\u202etitle", quantity: 1 }] })).rejects.toThrow(/lines\[0\]\.title/);
    expect(await sales(s)).toEqual(before);
  });

  test("calls no marketplace: no fetch, nothing queued for a drain, nothing scheduled", async () => {
    const s = await setup();
    const scheduledBefore = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    await seed(s, {});
    await seed(s, { ship: true });
    expect(fetchCalls).toEqual([]);
    expect(await s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect())).toEqual([]);
    const scheduled = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    expect(scheduled).toBe(scheduledBefore);
  });
});
