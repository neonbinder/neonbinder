/**
 * NEO-509 — the one-time backfill of `marketplaceSales.items[].listed`
 * (`saleListedBackfill.ts`). `fetch` is stubbed with BSC order details; the
 * credentials layer is mocked at its identity-less entry points, and counts
 * its token reads so a dry run can be shown to contact nothing. No test
 * reaches a live server.
 */
import fs from "node:fs";
import path from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { saleLineKeys } from "./lib/pickLines";
import { TEST_SALE_ORDER_PREFIX } from "./lib/testSeedMarks";
import {
  ENV_FLAG,
  MAX_CONSECUTIVE_UNAVAILABLE,
  MAX_OPENS_PER_CALL,
  MAX_ORDERS_CAP,
  ORDER_SPACING_MS,
  OWNERS_PER_PAGE,
  READ_DEADLINE_MS,
  clampMaxOrders,
  fillMissingImpl,
  type BackfillArgs,
  type BackfillCtx,
  type BackfillDeps,
} from "./saleListedBackfill";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const tokenReads = vi.hoisted(() => ({ count: 0, fail: false }));

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
        tokenReads.count += 1;
        return tokenReads.fail ? null : { token: "tok-1" };
      },
    }),
    refreshSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => ({ refreshed: false }),
    }),
  };
});

const OWNER = "collector_backfill_001";
const OTHER = "collector_backfill_002";
const NOW = 1_700_000_000_000;
const BSC = "https://api-prod.buysportscards.com/";

type T = ReturnType<typeof convexTest>;
type Sale = Doc<"marketplaceSales">;
type SaleItem = Sale["items"][number];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  tokenReads.count = 0;
  tokenReads.fail = false;
});

function stubCtx(t: T): BackfillCtx {
  return {
    runQuery: ((ref: never, args: never) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as BackfillCtx["runQuery"],
    runMutation: ((ref: never, args: never) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as BackfillCtx["runMutation"],
    runAction: ((ref: never, args: never) => (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as BackfillCtx["runAction"],
  };
}

const pauses: number[] = [];
const run = (t: T, args: BackfillArgs, deps: BackfillDeps = {}) =>
  fillMissingImpl(stubCtx(t), args, { pause: async (ms) => void pauses.push(ms), ...deps });

/** The stored lines of an 80-line-style order before NEO-509: no `listed`, a mix of states. */
function storedItems(): SaleItem[] {
  return [
    // Matched and applied, already pulled.
    { platformCardId: "card-a", condition: "near_mint", quantity: 1, priceCents: 25, sellerSku: "NB1-a", applied: true, appliedAt: NOW, pulledAt: NOW + 5 },
    // Unmatched (an old platform's SKU): the line the Pick List cannot name.
    { platformCardId: "card-b", condition: "near_mint", quantity: 1, priceCents: 30, sellerSku: "303|TB2", applied: false, problem: "unmatched" },
    // Two lines with one key: matched by occurrence.
    { platformCardId: "card-c", condition: "excellent", quantity: 1, priceCents: 10, applied: false, problem: "unmatched" },
    { platformCardId: "card-c", condition: "excellent", quantity: 2, priceCents: 10, applied: false, problem: "unmatched" },
  ];
}

async function seed(
  t: T,
  over: Partial<Omit<Sale, "_id" | "_creationTime">> = {},
): Promise<Id<"marketplaceSales">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("marketplaceSales", {
      ownerId: OWNER,
      platform: "bsc",
      orderId: "order-1",
      orderNo: "NO-1",
      orderDate: NOW,
      status: "READY_TO_SHIP",
      totals: { subtotalCents: 75 },
      items: storedItems(),
      pullOpen: true,
      firstSeenAt: NOW,
      lastUpdated: NOW,
      ...over,
    }),
  );
}

async function seedWorld(t: T): Promise<Id<"selectorOptions">> {
  return await t.run(async (ctx) => {
    for (const ownerId of [OWNER, OTHER]) {
      await ctx.db.insert("marketplaceListingStates", { ownerId, platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
    }
    return await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Football",
      platformData: { bsc: { b0: "football" } },
      isCustom: false,
      children: [],
      lastUpdated: NOW,
    } as never);
  });
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "lib", "__fixtures__", "bsc-order-redacted.json"), "utf8"),
) as Record<string, unknown> & { orderItems: Array<Record<string, unknown>> };

function bscLine(cardId: string, condition: string, sku: string | null, card: Record<string, unknown>, qty = 1) {
  return {
    ...fixture.orderItems[0],
    cardId,
    condition,
    orderQuantity: qty,
    sellerSku: sku,
    sportId: "football",
    card: { id: cardId, sport: "Football", year: "2021", setName: "2021 Score", variant: "Base", ...card },
  };
}

/** BSC's detail for a seeded order: every stored line, described. */
function detail(orderId: string, status = "READY_TO_SHIP") {
  return {
    ...fixture,
    orderId,
    orderStatus: status,
    orderItems: [
      bscLine("card-a", "near_mint", "NB1-a", { players: "Trevor Lawrence", cardNo: "1" }),
      bscLine("card-b", "near_mint", "303|TB2", { players: "Justin Fields", cardNo: "TB2", variant: "Insert", variantName: "1991 Throwback" }),
      bscLine("card-c", "excellent", null, { players: "First Copy", cardNo: "50" }),
      bscLine("card-c", "excellent", null, { players: "Second Copy", cardNo: "51" }, 2),
    ],
  };
}

/** Stubs BSC: `GET seller/order/<id>` answers from `answer`; every call is recorded. */
function stubBsc(answer: (orderId: string) => Response | null): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? "GET"} ${href.replace(BSC, "")}`);
    const m = /seller\/order\/([^/?]+)$/.exec(href);
    const res = m ? answer(decodeURIComponent(m[1])) : null;
    if (!res) throw new Error(`unexpected ${href}`);
    return res;
  }) as typeof fetch);
  return calls;
}

const getSale = (t: T, id: Id<"marketplaceSales">): Promise<Sale | null> => t.run(async (ctx) => ctx.db.get(id));
const arm = () => vi.stubEnv(ENV_FLAG, "1");

describe("dry run", () => {
  test("makes no BSC call (no token read either), writes nothing, and reports the candidates", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    const before = await getSale(t, saleId);
    const calls = stubBsc(() => Response.json(detail("order-1")));
    arm(); // armed deployment, but no confirm: still a dry run

    const report = await run(t, {});
    expect(report).toMatchObject({ mode: "dry_run", owners: 1, orders: 1, linesMissing: 4, ordersRead: 0, linesFilled: 0, complete: true, nextCursor: null });
    expect(report.byOwner).toEqual([expect.objectContaining({ ownerId: OWNER, orders: 1, linesMissing: 4 })]);
    expect(calls).toEqual([]);
    expect(tokenReads.count).toBe(0);
    expect(await getSale(t, saleId)).toEqual(before);
  });

  test("a confirm on an unarmed deployment is reported as refused, never thrown, and contacts nothing", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    const before = await getSale(t, saleId);
    const calls = stubBsc(() => Response.json(detail("order-1")));

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(report.mode).toBe("refused");
    expect(report.message).toMatch(/not armed/);
    expect(report).toMatchObject({ orders: 1, linesMissing: 4, ordersRead: 0, linesFilled: 0 });
    expect(calls).toEqual([]);
    expect(tokenReads.count).toBe(0);
    expect(await getSale(t, saleId)).toEqual(before);
  });

  test("fillListed called directly on an unarmed deployment writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    const before = await getSale(t, saleId);
    const r = await t.mutation(internal.saleListedBackfill.fillListed, {
      ownerId: OWNER,
      saleId,
      lines: [{ platformCardId: "card-b", condition: "near_mint", sellerSku: "303|TB2", listed: { players: "Anyone" } }],
    });
    expect(r).toEqual({ outcome: "notArmed", filled: 0, stillMissing: 0 });
    expect(await getSale(t, saleId)).toEqual(before);
  });
});

describe("armed run", () => {
  test("writes only `listed`, by key and occurrence, with NB's sport resolved by id; line ids do not move", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedWorld(t);
    const saleId = await seed(t);
    const before = (await getSale(t, saleId))!;
    const calls = stubBsc((id) => (id === "order-1" ? Response.json(detail("order-1")) : null));
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(report).toMatchObject({ mode: "armed", ordersRead: 1, linesFilled: 4, linesStillMissing: 0, ordersLeft: 0, complete: true });
    expect(calls).toEqual(["GET seller/order/order-1"]);

    const after = (await getSale(t, saleId))!;
    // Every field but `items` is untouched (status, pullOpen, totals, lastUpdated, ...).
    const { items: itemsAfter, ...restAfter } = after;
    const { items: itemsBefore, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    // Each line is its old self plus `listed`: applied, appliedAt, pulledAt, problem unchanged.
    expect(itemsAfter.map(({ listed: _l, ...rest }) => rest)).toEqual(itemsBefore);
    expect(itemsAfter.map((i) => i.listed)).toEqual([
      { sport: "Football", sportId, year: "2021", setName: "2021 Score", players: "Trevor Lawrence", cardNo: "1", variant: "Base" },
      { sport: "Football", sportId, year: "2021", setName: "2021 Score", players: "Justin Fields", cardNo: "TB2", variant: "Insert", variantName: "1991 Throwback" },
      expect.objectContaining({ players: "First Copy", cardNo: "50" }),
      expect.objectContaining({ players: "Second Copy", cardNo: "51" }),
    ]);
    expect(saleLineKeys(saleId, itemsAfter)).toEqual(saleLineKeys(saleId, itemsBefore));
  });

  test("a line that already holds a description keeps it; only absent ones are filled", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const items = storedItems();
    items[1] = { ...items[1], listed: { players: "Kept As Is", cardNo: "TB2" } };
    const saleId = await seed(t, { items });
    stubBsc(() => Response.json(detail("order-1")));
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(report).toMatchObject({ linesMissing: 3, linesFilled: 3 });
    const after = (await getSale(t, saleId))!;
    expect(after.items[1].listed).toEqual({ players: "Kept As Is", cardNo: "TB2" });
    expect(after.items.every((i) => i.listed !== undefined)).toBe(true);
  });

  test("is idempotent: a second run finds nothing and calls BSC no more", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    const calls = stubBsc(() => Response.json(detail("order-1")));
    arm();

    await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    const once = await getSale(t, saleId);
    const again = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(again).toMatchObject({ orders: 0, linesMissing: 0, ordersRead: 0, linesFilled: 0, complete: true });
    expect(calls).toHaveLength(1);
    expect(await getSale(t, saleId)).toEqual(once);
    // And a direct replay of the write changes nothing.
    const replay = await t.mutation(internal.saleListedBackfill.fillListed, {
      ownerId: OWNER,
      saleId,
      lines: [{ platformCardId: "card-b", condition: "near_mint", sellerSku: "303|TB2", listed: { players: "Different" } }],
    });
    expect(replay).toEqual({ outcome: "filled", filled: 0, stillMissing: 0 });
    expect(await getSale(t, saleId)).toEqual(once);
  });

  test("lines BSC no longer describes stay without one and are reported", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    const d = detail("order-1");
    d.orderItems = d.orderItems.slice(0, 2); // card-c lines gone from the read
    stubBsc(() => Response.json(d));
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(report).toMatchObject({ linesFilled: 2, linesStillMissing: 2 });
    const after = (await getSale(t, saleId))!;
    expect(after.items.map((i) => i.listed !== undefined)).toEqual([true, true, false, false]);
  });

  test("owner-scoped: another owner's sale is neither read nor written", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const mine = await seed(t);
    const theirs = await seed(t, { ownerId: OTHER, orderId: "order-2" });
    const theirsBefore = await getSale(t, theirs);
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(report.byOwner.map((r) => r.ownerId)).toEqual([OWNER]);
    expect(calls).toEqual(["GET seller/order/order-1"]);
    expect(tokenReads.count).toBe(1);
    expect((await getSale(t, mine))!.items.every((i) => i.listed !== undefined)).toBe(true);
    expect(await getSale(t, theirs)).toEqual(theirsBefore);
  });

  test("skips shipped, cancelled, other-platform and test-seed orders", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const skipped = [
      await seed(t, { orderId: "shipped", status: "SHIPPED", pullOpen: undefined }),
      await seed(t, { orderId: "cancelled", status: "CANCELLED", pullOpen: undefined }),
      await seed(t, { orderId: "ebay", platform: "ebay" }),
      await seed(t, { orderId: `${TEST_SALE_ORDER_PREFIX}abc` }),
    ];
    const befores = await Promise.all(skipped.map((id) => getSale(t, id)));
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();

    const dry = await run(t, { ownerId: OWNER });
    expect(dry).toMatchObject({ owners: 0, orders: 0, linesMissing: 0 });
    const armed = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(armed).toMatchObject({ orders: 0, ordersRead: 0 });
    expect(calls).toEqual([]);
    expect(tokenReads.count).toBe(0);
    expect(await Promise.all(skipped.map((id) => getSale(t, id)))).toEqual(befores);
  });

  test("an order that shipped between the read and the write is left alone", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const saleId = await seed(t);
    arm();
    await t.run(async (ctx) => ctx.db.patch(saleId, { status: "SHIPPED", pullOpen: undefined }));
    const before = await getSale(t, saleId);
    const r = await t.mutation(internal.saleListedBackfill.fillListed, {
      ownerId: OWNER,
      saleId,
      lines: [{ platformCardId: "card-b", condition: "near_mint", sellerSku: "303|TB2", listed: { players: "Late" } }],
    });
    expect(r.outcome).toBe("offList");
    expect(await getSale(t, saleId)).toEqual(before);
  });

  test("reads one order at a time, about a second apart, at most maxOrders per call", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 4; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();
    pauses.length = 0;

    const first = await run(t, { confirm: "BACKFILL", ownerId: OWNER, maxOrders: 3 });
    expect(calls).toEqual(["GET seller/order/o-0", "GET seller/order/o-1", "GET seller/order/o-2"]);
    expect(pauses).toEqual([ORDER_SPACING_MS, ORDER_SPACING_MS]);
    expect(first).toMatchObject({ orders: 4, ordersRead: 3, ordersLeft: 1, complete: false });
    expect(tokenReads.count).toBe(1); // one session for the owner

    const second = await run(t, { confirm: "BACKFILL", ownerId: OWNER, maxOrders: 3 });
    expect(second).toMatchObject({ orders: 1, ordersRead: 1, ordersLeft: 0, complete: true });
    expect(clampMaxOrders(500)).toBe(MAX_ORDERS_CAP);
    expect(clampMaxOrders(undefined)).toBe(5);
    expect(clampMaxOrders(0)).toBe(1);
  });

  test("stops the call on a 429: nothing more is read, the rest is left for a later run", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 3; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    await seed(t, { ownerId: OTHER, orderId: "theirs" });
    const calls = stubBsc(() => new Response("slow down", { status: 429 }));
    arm();

    const report = await run(t, { confirm: "BACKFILL" }); // walks every owner
    expect(calls).toEqual(["GET seller/order/o-0"]);
    expect(report).toMatchObject({ ordersRead: 1, linesFilled: 0, ordersLeft: 3, complete: false, nextCursor: null });
    expect(report.byOwner.find((r) => r.ownerId === OWNER)?.stopped).toBe("rate_limited");
    expect(tokenReads.count).toBe(1); // the other owner's session was never opened
  });

  test("an owner BSC has signed out is skipped after the first refused read", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 2; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    const calls = stubBsc(() => new Response("", { status: 401 }));
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(calls).toEqual(["GET seller/order/o-0"]);
    expect(report).toMatchObject({ ordersRead: 1, ordersLeft: 1, complete: false });
    expect(report.byOwner[0].stopped).toBe("signed_out");
  });
});

/** Listing states (BSC, listing) and one candidate order each for `ownerIds`. */
async function seedOwners(t: T, ownerIds: string[]): Promise<void> {
  await t.run(async (ctx) => {
    for (const ownerId of ownerIds) {
      await ctx.db.insert("marketplaceListingStates", { ownerId, platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
    }
  });
  for (const ownerId of ownerIds) await seed(t, { ownerId, orderId: `order-${ownerId}` });
}

describe("bounded BSC contact (security audit)", () => {
  test("every session open attempt is charged, a failed one too: no open past the budget", async () => {
    const t = convexTest(schema, modules);
    const owners = ["owner_a", "owner_b", "owner_c"];
    await seedOwners(t, owners);
    const calls = stubBsc((id) => Response.json(detail(id)));
    tokenReads.fail = true; // every open fails (no token)
    arm();

    const report = await run(t, { confirm: "BACKFILL" }, { maxOpens: 2 });
    expect(tokenReads.count).toBe(2);
    expect(report).toMatchObject({ sessionOpens: 2, ordersRead: 0, ordersLeft: 3, complete: false });
    expect(report.byOwner.map((r) => r.stopped)).toEqual(["no_token", "no_token", undefined]);
    expect(calls).toEqual([]);
  });

  test("a walk page never needs more opens than a call has, so failing opens still move the walk on", async () => {
    expect(OWNERS_PER_PAGE).toBeLessThanOrEqual(MAX_OPENS_PER_CALL);
    const t = convexTest(schema, modules);
    const owners = Array.from({ length: MAX_OPENS_PER_CALL + 2 }, (_, i) => `owner_${String(i).padStart(2, "0")}`);
    await seedOwners(t, owners);
    stubBsc((id) => Response.json(detail(id)));
    tokenReads.fail = true;
    arm();

    const first = await run(t, { confirm: "BACKFILL" });
    expect(first.sessionOpens).toBe(MAX_OPENS_PER_CALL);
    expect(tokenReads.count).toBe(MAX_OPENS_PER_CALL);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).not.toBeNull();

    const second = await run(t, { confirm: "BACKFILL", cursor: first.nextCursor! });
    expect(second.sessionOpens).toBe(2);
    expect(tokenReads.count).toBe(MAX_OPENS_PER_CALL + 2);
    expect(second).toMatchObject({ complete: true, nextCursor: null });
  });

  test(`an owner stops after ${MAX_CONSECUTIVE_UNAVAILABLE} timeout/network/5xx reads in a row; a good read resets the run`, async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 5; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    // o-0 503, o-1 fine, o-2 network error, o-3 503: stop; o-4 is never read.
    const calls = stubBsc((id) =>
      id === "o-1" ? Response.json(detail(id)) : id === "o-2" ? null : new Response("busy", { status: 503 }),
    );
    arm();

    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(calls).toEqual(["GET seller/order/o-0", "GET seller/order/o-1", "GET seller/order/o-2", "GET seller/order/o-3"]);
    expect(report).toMatchObject({ ordersRead: 4, linesFilled: 4, ordersLeft: 1, complete: false });
    expect(report.byOwner[0]).toMatchObject({ stopped: "unavailable", ordersFailed: 3 });
  });

  test("no read starts and no session opens once the deadline has passed; the rest is left for the next call", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 3; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    await seed(t, { ownerId: OTHER, orderId: "theirs" });
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();
    const clock = { t: NOW };
    const step = Math.ceil(READ_DEADLINE_MS * 0.6);

    // Each spacing pause moves the clock on: o-0 at 0, o-1 at 0.6, o-2 would start at 1.2 deadlines.
    const report = await run(t, { confirm: "BACKFILL" }, {
      now: () => clock.t,
      pause: async () => {
        clock.t += step;
      },
    });
    expect(calls).toEqual(["GET seller/order/o-0", "GET seller/order/o-1"]);
    expect(tokenReads.count).toBe(1); // the other owner's session is never opened
    expect(report).toMatchObject({ sessionOpens: 1, ordersRead: 2, ordersLeft: 2, complete: false, nextCursor: null });
    expect(report.byOwner.every((r) => r.stopped === undefined)).toBe(true);
  });

  test("a session open that runs past the deadline starts no read", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    for (let i = 0; i < 2; i += 1) await seed(t, { orderId: `o-${i}`, orderDate: NOW + i });
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();

    // The token read (a BSC sign-in at worst) is what moves the clock past the deadline.
    const report = await run(t, { confirm: "BACKFILL", ownerId: OWNER }, {
      now: () => NOW + (tokenReads.count > 0 ? READ_DEADLINE_MS : 0),
    });
    expect(tokenReads.count).toBe(1);
    expect(calls).toEqual([]);
    expect(report).toMatchObject({ sessionOpens: 1, ordersRead: 0, ordersLeft: 2, complete: false });
  });
});

describe("the poll's owner gate (listingOutbox.pollsSales)", () => {
  const notPolled: Array<[string, Record<string, unknown> | null]> = [
    ["dormant (no credentials)", { listingStartedAt: NOW, dormant: "noCredentials" }],
    ["dormant (seller conflict)", { listingStartedAt: NOW, dormant: "sellerConflict" }],
    ["held off by the E2E marker", { listingStartedAt: NOW, testListingOff: true }],
    ["never started", {}],
    ["no BSC listing state", null],
  ];

  test.each(notPolled)("ownerId path: an owner %s is neither counted nor read, dry run or armed", async (_label, state) => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      if (state !== null) {
        await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "bsc", lastUpdated: NOW, ...state } as never);
      }
      // An eBay state that does list never opens the BSC gate.
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    });
    const saleId = await seed(t);
    const before = await getSale(t, saleId);
    const calls = stubBsc((id) => Response.json(detail(id)));
    arm();

    const dry = await run(t, { ownerId: OWNER });
    expect(dry).toMatchObject({ owners: 0, ownersNotPolled: 1, orders: 0, linesMissing: 0 });
    const armed = await run(t, { confirm: "BACKFILL", ownerId: OWNER });
    expect(armed).toMatchObject({ owners: 0, ownersNotPolled: 1, orders: 0, sessionOpens: 0, ordersRead: 0 });
    expect(calls).toEqual([]);
    expect(tokenReads.count).toBe(0);
    expect(await getSale(t, saleId)).toEqual(before);
  });

  test("the walk lists only owners the poll polls on BSC", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: "a_listing", platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
      await ctx.db.insert("marketplaceListingStates", { ownerId: "b_dormant", platform: "bsc", listingStartedAt: NOW, dormant: "noCredentials", lastUpdated: NOW });
      await ctx.db.insert("marketplaceListingStates", { ownerId: "c_e2e", platform: "bsc", listingStartedAt: NOW, testListingOff: true, lastUpdated: NOW });
      await ctx.db.insert("marketplaceListingStates", { ownerId: "d_unstarted", platform: "bsc", lastUpdated: NOW });
      await ctx.db.insert("marketplaceListingStates", { ownerId: "e_ebay", platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    });
    const page = await t.query(internal.saleListedBackfill.ownersPage, { cursor: null });
    expect(page.ownerIds).toEqual(["a_listing"]);
  });
});

describe("declarations", () => {
  test("every function is internal (run from the CLI without --identity)", () => {
    const src = fs.readFileSync(path.join(__dirname, "saleListedBackfill.ts"), "utf8");
    for (const [fn, kind] of [
      ["fillMissing", "internalAction"],
      ["fillListed", "internalMutation"],
      ["ownerCandidates", "internalQuery"],
      ["ownersPage", "internalQuery"],
    ] as const) {
      expect(src).toContain(`export const ${fn} = ${kind}({`);
    }
    expect(src).not.toMatch(/export const \w+ = (query|mutation|action)\(/);
  });
});
