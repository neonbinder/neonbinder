/**
 * NEO-500 — `testing.seedMyTestPickOrder`, the Pick List spec's hop: a BSC
 * order on the CALLER's account, recorded and applied by the poll's own cores
 * with only the poll gate skipped. Fails closed without
 * `TESTING_RESET_SECRET`; refuses a caller who pushes counts anywhere; reads
 * and writes only the caller's rows; a retry applies nothing twice; `ship`
 * takes the order off the Pick List; nothing reaches a marketplace (fetch is
 * a spy that throws, and the outbox stays empty).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { TEST_SALE_ORDER_PREFIX } from "./lib/testSeedMarks";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

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

const USER_A = "user_pickseed_aaaa";
const USER_B = "user_pickseed_bbbb";
const NOW = 1_700_000_000_000;
const BOX = "Pick w1-abc";

let fetchCalls: string[];
beforeEach(() => {
  fetchCalls = [];
  vi.stubEnv("TESTING_RESET_SECRET", "test-enabled");
  vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    throw new Error(`the pick-order seed must not fetch ${String(url)}`);
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function catalog(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
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
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const set = await row("setName", "Topps Chrome", year);
    const variant = await row("variantType", "Base", set);
    const card = (n: string, ref?: string) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variant,
        cardNumber: n,
        cardName: `Player ${n}`,
        listingTitle: `Card ${n}`,
        sportId: sport,
        platformData: ref ? { bsc: { ref, src: "b0" } } : {},
        sortOrder: 0,
        lastUpdated: NOW,
      } as never);
    return { a: await card("901", "bsc-a"), b: await card("902", "bsc-b"), noRef: await card("903") };
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  const cards = await catalog(t);
  const user = async (subject: string) => {
    const me = t.withIdentity({ subject });
    await me.mutation(api.collectionContainers.ensureSystem, {});
    const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: BOX })).containerId;
    const add = async (cardId: Id<"cardChecklist">, quantity: number) =>
      (await me.mutation(api.collection.addLineItem, { cardId, details: { homeId: box, quantity, condition: "Near Mint" } as never }))
        .copyId as Id<"collectionCopies">;
    return { me, box, add };
  };
  const a = await user(USER_A);
  const b = await user(USER_B);
  return { t, cards, a, b };
}
type S = Awaited<ReturnType<typeof setup>>;

const seed = (s: S, args: Record<string, unknown>, who = s.a.me) =>
  who.mutation(api.testing.seedMyTestPickOrder, { orderNo: "pick1", boxName: BOX, ...args } as never);

const copies = (s: S, ownerId: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect())
      .filter((r) => r.ownerId === ownerId && r.cardId !== undefined)
      .map((r) => ({ cardId: r.cardId, quantity: r.quantity }))
      .sort((x, y) => String(x.cardId).localeCompare(String(y.cardId))),
  );
const sales = (s: S) => s.t.run(async (ctx) => await ctx.db.query("marketplaceSales").collect());
const openFor = (s: S, ownerId: string) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query("marketplaceSales")
        .withIndex("by_owner_pull_open", (q) => q.eq("ownerId", ownerId).eq("pullOpen", true))
        .collect()
    ).map((r) => r.orderId),
  );

describe("seedMyTestPickOrder", () => {
  test("throws when TESTING_RESET_SECRET is unset, and writes nothing", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    vi.stubEnv("TESTING_RESET_SECRET", "");
    await expect(seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] })).rejects.toThrow(/not enabled/);
    expect(await sales(s)).toEqual([]);
    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.a, quantity: 2 }]);
  });

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(
      s.t.mutation(api.testing.seedMyTestPickOrder, { orderNo: "pick1", boxName: BOX, cards: [{ cardNumber: "901", quantity: 1 }] }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("refuses a caller who pushes counts to any marketplace, and writes nothing", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: USER_A, platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    });
    await expect(seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] })).rejects.toThrow(/pushes to a marketplace/);
    expect(await sales(s)).toEqual([]);
    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.a, quantity: 2 }]);
  });

  test("a caller held off by the test marker is let through", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: USER_A,
        platform: "bsc",
        listingStartedAt: NOW,
        testListingOff: true,
        lastUpdated: NOW,
      });
    });
    expect(await seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] })).toMatchObject({ lines: 1, applied: 1 });
  });

  test("records and applies a READY_TO_SHIP order over the caller's box: from, lastOnes, Short N and a bad line", async () => {
    const s = await setup();
    const copyA = await s.a.add(s.cards.a, 1);
    await s.a.add(s.cards.b, 3);
    const r = await seed(s, {
      cards: [
        { cardNumber: "901", quantity: 2 },
        { cardNumber: "902", quantity: 1 },
      ],
      badLine: true,
    });
    expect(r).toMatchObject({ lines: 3, applied: 2 });

    const [stored] = await sales(s);
    expect(stored).toMatchObject({
      _id: r.saleId,
      ownerId: USER_A,
      platform: "bsc",
      orderId: `${TEST_SALE_ORDER_PREFIX}pick1`,
      orderNo: "pick1",
      status: "READY_TO_SHIP",
      pullOpen: true,
    });
    const [a, b, bad] = stored.items;
    expect(a).toMatchObject({ platformCardId: "bsc-a", applied: true, problem: "oversold", shortBy: 1, lastOnes: true, cardId: s.cards.a });
    expect(a.from).toEqual([{ homeId: s.a.box, copyId: copyA, quantity: 1, condition: "Near Mint" }]);
    expect(b).toMatchObject({ platformCardId: "bsc-b", applied: true, cardId: s.cards.b });
    expect(b.problem).toBeUndefined();
    expect(b.lastOnes).toBeUndefined();
    expect(bad).toMatchObject({ applied: false, problem: "unmatched" });

    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.b, quantity: 2 }]);
    expect(await openFor(s, USER_A)).toEqual([`${TEST_SALE_ORDER_PREFIX}pick1`]);
  });

  test("writes only the caller's rows: another user's box of the same name and same cards is untouched", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    await s.b.add(s.cards.a, 2);
    await seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] });
    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.a, quantity: 1 }]);
    expect(await copies(s, USER_B)).toEqual([{ cardId: s.cards.a, quantity: 2 }]);
    expect((await sales(s)).map((r) => r.ownerId)).toEqual([USER_A]);
    expect(await openFor(s, USER_B)).toEqual([]);
  });

  test("a card only another user's box holds is not found in the caller's", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 1);
    await s.b.add(s.cards.b, 1);
    await expect(seed(s, { cards: [{ cardNumber: "902", quantity: 1 }] })).rejects.toThrow(/found 0/);
    expect(await sales(s)).toEqual([]);
  });

  test("a retry with the same orderNo applies nothing twice and does not look at the box again", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 3);
    const first = await seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] });
    const before = (await sales(s))[0];
    const again = await seed(s, { cards: [{ cardNumber: "901", quantity: 2 }], boxName: "No such box" });
    expect(again).toEqual({ saleId: first.saleId, lines: 1, applied: 0 });
    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.a, quantity: 2 }]);
    const after = (await sales(s))[0];
    expect(after.items).toEqual(before.items);
    expect(after.pullOpen).toBe(true);
  });

  test("ship takes the order off the Pick List and keeps what the apply wrote", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 1);
    await seed(s, { cards: [{ cardNumber: "901", quantity: 1 }] });
    const from = (await sales(s))[0].items[0].from;
    const shipped = await seed(s, { ship: true });
    expect(shipped.applied).toBe(0);
    const stored = (await sales(s))[0];
    expect(stored.status).toBe("SHIPPED");
    expect("pullOpen" in stored).toBe(false);
    expect(stored.items[0].from).toEqual(from);
    expect(await openFor(s, USER_A)).toEqual([]);
  });

  test("ship with nothing seeded refuses", async () => {
    const s = await setup();
    await expect(seed(s, { ship: true })).rejects.toThrow(/No seeded order/);
  });

  test.each([
    ["an orderNo that is not one token", { orderNo: "pick 1", cards: [{ cardNumber: "901", quantity: 1 }] }, /one token/],
    ["no cards", { cards: [] }, /1-20 cards/],
    ["a quantity past the cap", { cards: [{ cardNumber: "901", quantity: 11 }] }, /quantity must be/],
    ["a box name that is not the caller's", { boxName: "Nope", cards: [{ cardNumber: "901", quantity: 1 }] }, /exactly one box/],
    ["a card with no BSC id", { cards: [{ cardNumber: "903", quantity: 1 }] }, /no BuySportsCards id/],
  ])("refuses %s", async (_name, args, err) => {
    const s = await setup();
    await s.a.add(s.cards.a, 1);
    await s.a.add(s.cards.noRef, 1);
    await expect(seed(s, args)).rejects.toThrow(err);
    expect(await sales(s)).toEqual([]);
  });

  test("calls no marketplace: no fetch, nothing queued for a drain, nothing scheduled", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    const scheduledBefore = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    await seed(s, { cards: [{ cardNumber: "901", quantity: 1 }], badLine: true });
    await seed(s, { ship: true });
    expect(fetchCalls).toEqual([]);
    expect(await s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect())).toEqual([]);
    const scheduled = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    expect(scheduled).toBe(scheduledBefore);
  });
});

describe("seedMyTestPickOrder — listedLine (NEO-509)", () => {
  test("adds one unmatched line described from the first card's set, its sport resolved by the sport row's BSC id", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    const result = await seed(s, {
      cards: [{ cardNumber: "901", quantity: 1 }],
      listedLine: { cardNumber: "208", players: "Listed Player" },
    });
    expect(result.lines).toBe(2);
    expect(result.applied).toBe(1);
    const [sale] = await sales(s);
    const line = sale.items[1];
    expect(line.problem).toBe("unmatched");
    expect(line.applied).toBe(false);
    const sport = await s.t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).find((r) => r.level === "sport"),
    );
    expect(line.listed).toEqual({
      sport: "Baseball",
      sportId: sport?._id,
      year: "2024",
      setName: "2024 Topps Chrome",
      players: "Listed Player",
      cardNo: "208",
      variant: "Base",
    });
    expect(sale.items[0].listed).toBeUndefined();
  });

  test("a retried hop keeps the stored description and applies nothing twice", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    const args = { cards: [{ cardNumber: "901", quantity: 1 }], listedLine: { cardNumber: "208", players: "Listed Player" } };
    await seed(s, args);
    const again = await seed(s, args);
    expect(again.applied).toBe(0);
    const [sale] = await sales(s);
    expect(sale.items).toHaveLength(2);
    expect(sale.items[1].listed?.players).toBe("Listed Player");
    expect(await copies(s, USER_A)).toEqual([{ cardId: s.cards.a, quantity: 1 }]);
  });

  test("refuses a blank card number or players", async () => {
    const s = await setup();
    await s.a.add(s.cards.a, 2);
    await expect(
      seed(s, { cards: [{ cardNumber: "901", quantity: 1 }], listedLine: { cardNumber: " ", players: "P" } }),
    ).rejects.toThrow(/listedLine/);
    expect(await sales(s)).toEqual([]);
  });
});
