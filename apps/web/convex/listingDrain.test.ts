/**
 * NEO-370 — the listing drainer (`listingDrain.ts`) against a fake BSC.
 *
 * `fetch` is stubbed with an in-memory seller sheet (one row per BSC card per
 * condition, a blank template at 0 until something lists it), so these tests
 * assert on what NB actually sent and what BSC would then show. The
 * credentials layer is mocked at the two identity-less entry points the
 * seller client calls. No test reaches a live server.
 *
 * Covered: the first sync reads every condition of the era and corrects the
 * whole variant (old-platform rows NB does not hold go to 0); a later sync
 * reads only the targets' conditions plus the ones NB pushed before; an
 * outbox row whose `seq` moved mid-push survives; a moved card's row is
 * re-pointed and a deleted card's row cleared; the owner lease; a variant
 * with no BSC scope; a sign-in BSC refuses after a refresh stops the drain;
 * the time budget hands the rest to a rescheduled run. NEO-370 round 3: no
 * timer (a row landing mid-run waits for the next kick unless a kick asked
 * for another run), the credential gate (no credentials → dormant, a session
 * that needs a fresh sign-in is not logged into), one NB owner per seller
 * account, listing stopped under a run (the sign-in removed) stops the push
 * but keeps the state row, and every BSC call refuses redirects. Revision 4:
 * a copy in an in-person box (`listedOnMarketplaces: false`) counts 0, and
 * the first run after a Sync press reads every condition.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  DRAIN_DEATH_GRACE_MS,
  DRAIN_LEASE_MS,
  DRAIN_WATCH_TICK_MS,
  drainOwnerImpl,
  MAX_PROGRESS_STEPS,
  ProgressLedger,
  rejectedPushDetail,
  settleSteps,
  type DrainCtx,
} from "./listingDrain";
import { kickOwnerDrains } from "./listingOutbox";
import { BSC_SELLER_TIMEOUTS_MS } from "./adapters/bscSeller";
import { EBAY_TIMEOUTS_MS } from "./adapters/ebaySeller";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** What the mocked credentials layer answers; reset per test. */
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

/**
 * convex-test mints ids in its own format ("…0010cardChecklist"), not the
 * real backend's checksummed base32, so the real SKU codec (which checks the
 * Convex id checksum; `lib/listingSku.test.ts` pins it) refuses them. These
 * tests swap in the same SKU shape without the checksum.
 */
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

const OWNER = "collector_listing_001";
const ME = { subject: OWNER };
const NOW = 1_700_000_000_000;

// ── A fake BSC seller ────────────────────────────────────────────────────────

type SheetRow = {
  productId: string;
  productType: "raw";
  cardId: string;
  price: string | number;
  condition: string;
  availableQuantity: number;
  sellerSku?: string;
  sellerImgFront?: string;
  sellerImgBack?: string;
  card: { id: string; cardNo: string };
};

class FakeBsc {
  rows = new Map<string, SheetRow>();
  sheetReads: Array<{ condition: string; filters: Record<string, string[]> }> = [];
  puts: Array<{ sellerId: string; listings: SheetRow[] }> = [];
  authHeaders: string[] = [];
  /** Answers the next N calls with 401. */
  unauthorized = 0;
  onPut?: () => Promise<void>;
  onSheetRead?: () => Promise<void>;

  constructor(
    readonly universe: Array<{ bscCardId: string; cardNo: string }>,
    readonly conditions: readonly string[],
  ) {
    for (const c of universe) {
      for (const condition of conditions) {
        this.rows.set(`${c.bscCardId}|${condition}`, {
          productId: `p-${c.bscCardId}-${condition}`,
          productType: "raw",
          cardId: c.bscCardId,
          price: "0",
          condition,
          availableQuantity: 0,
          card: { id: c.bscCardId, cardNo: c.cardNo },
        });
      }
    }
  }

  set(bscCardId: string, condition: string, over: Partial<SheetRow>) {
    const key = `${bscCardId}|${condition}`;
    const row = this.rows.get(key);
    if (!row) throw new Error(`no row ${key}`);
    this.rows.set(key, { ...row, ...over });
  }

  qty(bscCardId: string, condition: string): number {
    return this.rows.get(`${bscCardId}|${condition}`)?.availableQuantity ?? -1;
  }

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.authHeaders.push(headers.authorization ?? "");
    if (!href.startsWith("https://api-prod.buysportscards.com/")) {
      throw new Error(`unexpected fetch ${href}`);
    }
    if (headers.assumedrole !== "sellers") throw new Error("missing assumedrole");
    // The bearer token must never follow a redirect off BSC's API host.
    if (init?.redirect !== "error") throw new Error("a BSC call must refuse redirects");
    if (this.unauthorized > 0) {
      this.unauthorized -= 1;
      return new Response("", { status: 401 });
    }
    const path = href.slice("https://api-prod.buysportscards.com/".length);
    if (path === "seller/bulk-upload/results" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { condition: string; filters: Record<string, string[]> };
      this.sheetReads.push({ condition: body.condition, filters: body.filters });
      await this.onSheetRead?.();
      return Response.json([...this.rows.values()].filter((r) => r.condition === body.condition));
    }
    if (path === "seller/bulk-upload" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { sellerId: string; listings: SheetRow[] };
      this.puts.push(body);
      await this.onPut?.();
      for (const l of body.listings) {
        const key = `${l.card.id}|${l.condition}`;
        const row = this.rows.get(key);
        if (row) {
          this.rows.set(key, {
            ...row,
            availableQuantity: l.availableQuantity,
            price: l.price,
            ...(l.sellerSku !== undefined ? { sellerSku: l.sellerSku } : {}),
          });
        }
      }
      return Response.json(body.listings.map((l) => ({ productId: l.productId })));
    }
    if (path === "marketplace/user/profile") {
      return Response.json({ sellerProfile: { sellerId: "seller-from-profile" } });
    }
    throw new Error(`unexpected BSC path ${path}`);
  }) as typeof fetch;
}

const MODERN = ["near_mint", "excellent", "very_good", "poor"];

// ── Seeding ──────────────────────────────────────────────────────────────────

type T = ReturnType<typeof convexTest>;

async function seedVariant(
  t: T,
  opts: { year?: string; name?: string; bsc?: boolean; cards: Array<{ number: string; ref: string | null }> },
) {
  return t.run(async (ctx) => {
    const withBsc = opts.bsc !== false;
    const row = async (
      level: "sport" | "year" | "setName" | "variantType",
      value: string,
      parentId?: Id<"selectorOptions">,
      facets?: Record<string, string>,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: withBsc ? { bsc: { b0: `slug-${level}-${value}` } } : {},
        ...(withBsc && facets ? { platformFacets: { bsc: facets } } : {}),
        isCustom: false,
        children: [],
        ...(parentId ? { parentId } : {}),
        lastUpdated: NOW,
      } as never);
    const sport = await row("sport", "Baseball");
    const year = await row("year", opts.year ?? "2021", sport);
    const set = await row("setName", opts.name ?? "Topps", year);
    const variant = await row("variantType", "Base", set, { b0: "variant" });
    const cardIds: Array<Id<"cardChecklist">> = [];
    let i = 0;
    for (const c of opts.cards) {
      cardIds.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: variant,
          cardNumber: c.number,
          cardName: `Player ${c.number}`,
          listingTitle: `Card ${c.number}`,
          sportId: sport,
          platformData: c.ref ? { bsc: { ref: c.ref, src: "b0" } } : {},
          isCustom: false,
          sortOrder: i++,
          lastUpdated: NOW,
        } as never),
      );
    }
    return { variantId: variant, setId: set, cardIds };
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
  const box2 = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Box B" })).containerId;
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "Binder" })).containerId;
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: OWNER,
      marketplaceAccountIds: { bscSellerId: "seller-1" },
      siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
    } as never);
  });
  return { t, me, box, box2, binder };
}
type S = Awaited<ReturnType<typeof setup>>;

async function listOnBsc(s: S, extra: Record<string, unknown> = {}) {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: OWNER,
      platform: "bsc",
      listingStartedAt: NOW,
      lastUpdated: NOW,
      ...extra,
    });
  });
}

const pendingDrains = (s: S) =>
  s.t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (f) => f.name.includes("listingDrain") && f.state.kind === "pending",
    ),
  );

const add = (s: S, cardId: Id<"cardChecklist">, details: Record<string, unknown>) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, ...details } as never });

async function queue(s: S, rows: Array<{ cardId: Id<"cardChecklist">; variantId: Id<"selectorOptions">; seq?: number }>) {
  return s.t.run(async (ctx) => {
    const ids: Array<Id<"listingOutbox">> = [];
    for (const r of rows) {
      const existing = await ctx.db
        .query("listingOutbox")
        .withIndex("by_owner_platform_card", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc").eq("cardId", r.cardId))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { seq: r.seq ?? existing.seq, variantId: r.variantId });
        ids.push(existing._id);
      } else {
        ids.push(
          await ctx.db.insert("listingOutbox", {
            ownerId: OWNER,
            platform: "bsc",
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
const state = (s: S) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc"))
      .unique(),
  );
const record = (s: S, variantId: Id<"selectorOptions">) =>
  s.t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", OWNER).eq("variantId", variantId).eq("platform", "bsc"),
      )
      .unique(),
  );

const drain = (s: S, extra: Record<string, unknown> = {}) =>
  s.t.action(internal.listingDrain.drainOwner, { ownerId: OWNER, platform: "bsc", ...extra });

/** The drain's ctx as a forwarding stub, so a test can set the clock and budget. */
function stubCtx(t: T): DrainCtx {
  return {
    runQuery: ((ref: never, args: never) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runQuery"],
    runMutation: ((ref: never, args: never) => (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runMutation"],
    runAction: ((ref: never, args: never) => (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args)) as DrainCtx["runAction"],
  };
}

beforeEach(() => {
  creds.token = "tok-1";
  creds.refreshed = true;
  creds.tokenCalls = 0;
  creds.refreshCalls = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("drainOwner: the first sync of a variant", () => {
  test("reads every modern condition, lists NB's box counts and zeroes what NB does not hold", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, {
      cards: [
        { number: "1", ref: "bsc-1" },
        { number: "2", ref: "bsc-2" },
        { number: "3", ref: "bsc-3" },
      ],
    });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
        { bscCardId: "bsc-3", cardNo: "3" },
      ],
      MODERN,
    );
    // The old platform listed #3 under near_mint; NB holds none of it.
    bsc.set("bsc-3", "near_mint", { availableQuantity: 5, price: "1.00", sellerSku: "303|3" });
    vi.stubGlobal("fetch", bsc.fetch);

    // Two Near Mint copies of #1 in two boxes (they fold into one BSC row),
    // one Excellent #2, and a binder copy of #2 that is never for sale.
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50, acquiredOn: "2026-01-01" });
    await add(s, v.cardIds[0], { homeId: s.box2, condition: "Mint", minPriceCents: 80, acquiredOn: "2026-02-01" });
    await add(s, v.cardIds[1], { homeId: s.box, condition: "Excellent", minPriceCents: 30 });
    await add(s, v.cardIds[1], { homeId: s.binder, condition: "Excellent", minPriceCents: 30 });
    await listOnBsc(s);
    await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId },
      { cardId: v.cardIds[1], variantId: v.variantId },
    ]);

    await drain(s);

    // Every modern condition read once (first sync), with the slot-id filters.
    expect(bsc.sheetReads.slice(0, 4).map((r) => r.condition).sort()).toEqual([...MODERN].sort());
    expect(bsc.sheetReads[0].filters).toEqual({
      sport: ["slug-sport-Baseball"],
      year: ["slug-year-2021"],
      setName: ["slug-setName-Topps"],
      variant: ["slug-variantType-Base"],
    });
    expect(bsc.puts).toHaveLength(1);
    expect(bsc.puts[0].sellerId).toBe("seller-1");
    // NB's truth on BSC: 2 NM of #1 at the highest floor, 1 EX of #2, #3 zeroed.
    expect(bsc.qty("bsc-1", "near_mint")).toBe(2);
    expect(bsc.rows.get("bsc-1|near_mint")?.price).toBe(0.8);
    expect(bsc.rows.get("bsc-1|near_mint")?.sellerSku).toMatch(/^NB1-/);
    expect(bsc.qty("bsc-2", "excellent")).toBe(1);
    expect(bsc.qty("bsc-3", "near_mint")).toBe(0);

    const rec = await record(s, v.variantId);
    expect(rec).toMatchObject({
      status: "idle",
      counts: { listed: 2, pushed: 3, zeroed: 1, skipped: 0 },
      problems: [],
      problemsTotal: 0,
    });
    expect(rec?.leaseToken).toBeUndefined();
    expect([...(rec?.conditionsPushed ?? [])].sort()).toEqual(["excellent", "near_mint"]);
    expect(rec?.lastSuccessAt).toBeTypeOf("number");

    // Rows cleared, lease released, nothing left to schedule.
    expect(await outbox(s)).toHaveLength(0);
    const st = await state(s);
    expect(st?.drainLeaseToken).toBeUndefined();
    expect(st?.drainScheduledAt).toBeUndefined();
    expect(st?.lastDrainAt).toBeTypeOf("number");
    // The seller account the PUT named is now this owner's.
    expect(st?.platformAccountId).toBe("seller-1");
  });

  // NEO-415: four concurrent sheet reads per seller made BSC answer with two
  // rows for one card in one condition, and every card was held back
  // (`duplicate_sheet_row`). The drain reads BSC's sheet one request at a time.
  test("never has two sheet reads in flight at once", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, {
      cards: [
        { number: "1", ref: "bsc-1" },
        { number: "2", ref: "bsc-2" },
      ],
    });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
      ],
      MODERN,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    bsc.onSheetRead = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold each answer long enough for an overlapping read to start.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await add(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId },
      { cardId: v.cardIds[1], variantId: v.variantId },
    ]);

    await drain(s);

    // The full read (every modern condition) plus the read-back, one by one.
    expect(bsc.sheetReads.length).toBeGreaterThan(MODERN.length);
    expect(maxInFlight).toBe(1);
    expect(await record(s, v.variantId)).toMatchObject({ status: "idle", counts: { listed: 2, skipped: 0 } });
  });

  test("a later sync reads only the targets' conditions and the ones NB pushed before", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    const added = await add(s, v.cardIds[0], { homeId: s.box, condition: "Excellent", minPriceCents: 40 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(bsc.qty("bsc-1", "excellent")).toBe(1);

    // The copy is regraded to Very Good: the EX row must go to 0, VG to 1.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(added.copyId as Id<"collectionCopies">, { condition: "Very Good" });
    });
    bsc.sheetReads = [];
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 2 }]);
    await drain(s);

    const firstPass = bsc.sheetReads.filter((r, i, all) => all.findIndex((x) => x.condition === r.condition) === i);
    expect(firstPass.map((r) => r.condition).sort()).toEqual(["excellent", "very_good"]);
    expect(bsc.qty("bsc-1", "excellent")).toBe(0);
    expect(bsc.qty("bsc-1", "very_good")).toBe(1);
  });
});

describe("drainOwner: the outbox rows", () => {
  test("a row whose seq moved during the push is kept for the next kick: no timer schedules a run", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, {
      cards: [
        { number: "1", ref: "bsc-1" },
        { number: "2", ref: "bsc-2" },
      ],
    });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
      ],
      MODERN,
    );
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await add(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    const [row1, row2] = await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId },
      { cardId: v.cardIds[1], variantId: v.variantId },
    ]);
    // A box write lands while the PUT is in flight: #2's row is bumped.
    bsc.onPut = async () => {
      await s.t.run(async (ctx) => {
        await ctx.db.patch(row2, { seq: 2 });
      });
    };

    await drain(s);

    const left = await outbox(s);
    expect(left.map((r) => r._id)).toEqual([row2]);
    expect(left[0].seq).toBe(2);
    expect(left.some((r) => r._id === row1)).toBe(false);
    const st = await state(s);
    expect(st?.drainScheduledAt).toBeUndefined();
    expect(st?.drainLeaseToken).toBeUndefined();
    expect(await pendingDrains(s)).toEqual([]);
  });

  test("a kick that lands while the run is under way runs the next drain at once on release", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, {
      cards: [
        { number: "1", ref: "bsc-1" },
        { number: "2", ref: "bsc-2" },
      ],
    });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
      ],
      MODERN,
    );
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[1], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    const [, row2] = await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId },
      { cardId: v.cardIds[1], variantId: v.variantId },
    ]);
    // A box write and a kick (a Sync press, a finished intake), mid-push.
    bsc.onPut = async () => {
      await s.t.run(async (ctx) => {
        await ctx.db.patch(row2, { seq: 2 });
      });
      await s.t.run(async (ctx) => {
        await kickOwnerDrains(ctx as never, OWNER);
      });
    };

    await drain(s);

    expect((await outbox(s)).map((r) => r._id)).toEqual([row2]);
    const st = await state(s);
    expect(st?.drainRequested).toBeUndefined();
    expect(st?.drainScheduledAt).toBeTypeOf("number");
    const next = await pendingDrains(s);
    expect(next).toHaveLength(1);
    expect(next[0].args[0]).toEqual({ ownerId: OWNER, platform: "bsc", kickToken: expect.any(String) });
    // The rescheduled run fires 1 s later on the real clock, after this test
    // unstubs fetch: cancel it so it never reaches the network guard (NEO-188).
    await cancelScheduled(s.t);
  });

  test("a deleted card's row is cleared and a moved card's row follows it to its new variant", async () => {
    const s = await setup();
    const a = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }, { number: "2", ref: "bsc-2" }] });
    const b = await seedVariant(s.t, { name: "Other", cards: [] });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
      ],
      MODERN,
    );
    vi.stubGlobal("fetch", bsc.fetch);
    await listOnBsc(s);
    const [gone, moved] = await queue(s, [
      { cardId: a.cardIds[0], variantId: a.variantId },
      { cardId: a.cardIds[1], variantId: a.variantId },
    ]);
    await s.t.run(async (ctx) => {
      await ctx.db.delete(a.cardIds[0]);
      await ctx.db.patch(a.cardIds[1], { selectorOptionId: b.variantId });
    });

    // A budget of 0 settles nothing; run with a real budget but only variant A
    // is in the outbox when the run starts.
    await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" }, { budgetMs: 60_000 });

    const left = await outbox(s);
    expect(left.some((r) => r._id === gone)).toBe(false);
    // Re-pointed, then drained under B in the same run (it sorts after A, or
    // is picked up next run): either way it is not left under A.
    expect(left.filter((r) => r.variantId === a.variantId)).toHaveLength(0);
    expect(moved).toBeDefined();
  });
});

describe("drainOwner: the owner lease", () => {
  test("a live lease held by another run stands this one down and drops the latch", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, {
        drainLeaseToken: "someone-else",
        drainLeaseExpiresAt: Date.now() + 60_000,
        drainScheduledAt: Date.now(),
      });
    });

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report).toMatchObject({ claimed: false, stoppedFor: "notClaimed" });
    expect(bsc.sheetReads).toHaveLength(0);
    const st = await state(s);
    expect(st?.drainLeaseToken).toBe("someone-else");
    expect(st?.drainScheduledAt).toBeUndefined();
    // The live run is asked to run once more when it releases.
    expect(st?.drainRequested).toBe(true);
    expect(await outbox(s)).toHaveLength(1);
  });

  test("an expired lease is reclaimed, and claiming clears the schedule latch", async () => {
    const s = await setup();
    await listOnBsc(s);
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, {
        drainLeaseToken: "dead-run",
        drainLeaseExpiresAt: Date.now() - 1,
        drainScheduledAt: Date.now(),
      });
    });
    const claim = await s.t.mutation(internal.listingDrain.claimDrain, {
      ownerId: OWNER,
      platform: "bsc",
      leaseToken: "mine",
    });
    expect(claim).toEqual({ claimed: true });
    const st = await state(s);
    expect(st?.drainLeaseToken).toBe("mine");
    expect(st?.drainScheduledAt).toBeUndefined();
  });

  test("no state row: the owner does not list on the platform, nothing runs", async () => {
    const s = await setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.claimed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("drainOwner: per-variant failures", () => {
  test("a variant with no BSC scope records an error, clears its rows and calls nothing", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { bsc: false, cards: [{ number: "1", ref: "bsc-1" }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await record(s, v.variantId)).toMatchObject({ status: "error" });
    expect((await record(s, v.variantId))?.lastError).toMatch(/isn't linked to BuySportsCards/);
    expect(await outbox(s)).toHaveLength(0);
  });

  test("a 401 refreshes once and retries with the new token", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    bsc.unauthorized = 1;
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(creds.refreshCalls).toBe(1);
    expect(bsc.authHeaders[0]).toBe("Bearer tok-1");
    expect(bsc.authHeaders.at(-1)).toBe("Bearer tok-2");
    expect(bsc.qty("bsc-1", "near_mint")).toBe(1);
    expect(await outbox(s)).toHaveLength(0);
  });

  test("a sign-in BSC refuses after a refresh stops the drain and keeps the rows for the cron's next kick", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    bsc.unauthorized = 99;
    creds.refreshed = false;
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report.stoppedFor).toBe("signedOut");
    expect(creds.refreshCalls).toBe(1);
    // Exactly one request went out: the refresh failed, nothing was retried.
    expect(bsc.authHeaders).toHaveLength(1);
    expect(await record(s, v.variantId)).toMatchObject({ status: "error" });
    expect(await outbox(s)).toHaveLength(1);
    const st = await state(s);
    expect(st?.drainLeaseToken).toBeUndefined();
    // No retry timer: a dead session is not hammered; the cron kicks again.
    expect(st?.drainScheduledAt).toBeUndefined();
    expect(await pendingDrains(s)).toEqual([]);
  });

  test("a guarded card is left alone on BSC and reported (card number disagrees)", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1A" }], MODERN);
    bsc.set("bsc-1", "near_mint", { availableQuantity: 3 });
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(bsc.puts).toHaveLength(0);
    expect(bsc.qty("bsc-1", "near_mint")).toBe(3);
    const rec = await record(s, v.variantId);
    expect(rec?.problems).toEqual([
      { cardId: v.cardIds[0], platformCardId: "bsc-1", reason: "numberMismatch", detail: "NB #1" },
    ]);
    expect(rec?.counts?.skipped).toBe(1);
  });
});

describe("drainOwner: a push BSC did not take", () => {
  test("is reported as rejected with an NB-only detail: NB's condition and quantity, never BSC's", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    // The read-back after the PUT shows BSC kept its old count.
    bsc.onSheetRead = async () => {
      if (bsc.puts.length > 0) bsc.set("bsc-1", "near_mint", { availableQuantity: 7 });
    };
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", quantity: 2, minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(bsc.puts).toHaveLength(1);
    const rec = await record(s, v.variantId);
    const rejected = rec?.problems.filter((p) => p.reason === "rejected") ?? [];
    expect(rejected).toEqual([
      {
        cardId: v.cardIds[0],
        platformCardId: "bsc-1",
        reason: "rejected",
        detail: "NeonBinder sent 2 for Mint / Near Mint, but the listing didn't take it.",
      },
    ]);
    expect(rejected[0].detail).not.toContain("near_mint");
    expect(rejected[0].detail).not.toContain("7");
    // And the public status carries the same NB-only words, without the BSC id.
    const status = await s.me.query(api.listingSync.syncSetProblems, { variantId: v.variantId, platform: "bsc" });
    expect(status.problems).toContainEqual({ cardNo: "1", cardLabel: "Player 1", reason: "rejected", detail: rejected[0].detail });
    expect(JSON.stringify(status)).not.toContain("near_mint");
    expect(JSON.stringify(status)).not.toContain("bsc-1");
  });

  test("rejectedPushDetail names NB's conditions for the era, and none for a condition NB has no name for", () => {
    expect(rejectedPushDetail(0, "vg", "vintage")).toBe("NeonBinder sent 0 for Very Good, but the listing didn't take it.");
    expect(rejectedPushDetail(3, "very_good", "modern")).toBe(
      "NeonBinder sent 3 for Very Good / Good, but the listing didn't take it.",
    );
    expect(rejectedPushDetail(1, "weird_bsc_condition", "modern")).toBe(
      "NeonBinder sent 1, but the listing didn't take it.",
    );
  });
});

describe("drainOwner: the time budget", () => {
  test("stops starting variants once the budget is spent and reschedules the rest", async () => {
    const s = await setup();
    const a = await seedVariant(s.t, { name: "A", cards: [{ number: "1", ref: "bsc-a1" }] });
    const b = await seedVariant(s.t, { name: "B", cards: [{ number: "1", ref: "bsc-b1" }] });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-a1", cardNo: "1" },
        { bscCardId: "bsc-b1", cardNo: "1" },
      ],
      MODERN,
    );
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, a.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await add(s, b.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [
      { cardId: a.cardIds[0], variantId: a.variantId },
      { cardId: b.cardIds[0], variantId: b.variantId },
    ]);
    // The clock jumps past the budget as soon as the first sheet is read.
    let clock = 0;
    bsc.onSheetRead = async () => {
      clock = 10_000;
    };

    const report = await drainOwnerImpl(
      stubCtx(s.t),
      { ownerId: OWNER, platform: "bsc" },
      { budgetMs: 5_000, now: () => clock },
    );

    expect(report.stoppedFor).toBe("budget");
    expect(report.variants).toHaveLength(1);
    const left = await outbox(s);
    expect(left).toHaveLength(1);
    const first = report.variants[0].variantId;
    expect(left[0].variantId).toBe(first === a.variantId ? b.variantId : a.variantId);
    const st = await state(s);
    expect(st?.drainLeaseToken).toBeUndefined();
    expect(st?.drainScheduledAt).toBeTypeOf("number");
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((f) => f.name.includes("listingDrain") && f.state.kind === "pending")).toBe(true);
    // The rescheduled run fires 1 s later on the real clock, after this test
    // unstubs fetch: cancel it so it never reaches the network guard (NEO-188).
    await cancelScheduled(s.t);
  });
});

describe("drainOwner: a variant NB no longer holds anything in", () => {
  test("a later sync with zero targets still reads the conditions NB pushed and zeroes them", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    const added = await add(s, v.cardIds[0], { homeId: s.box, condition: "Excellent", minPriceCents: 40 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(bsc.qty("bsc-1", "excellent")).toBe(1);

    // The last copy leaves (sold, moved to a binder, deleted): no targets.
    await s.t.run(async (ctx) => {
      await ctx.db.delete(added.copyId as Id<"collectionCopies">);
    });
    bsc.sheetReads = [];
    bsc.puts = [];
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 2 }]);
    await drain(s);

    expect([...new Set(bsc.sheetReads.map((r) => r.condition))]).toEqual(["excellent"]);
    expect(bsc.puts).toHaveLength(1);
    expect(bsc.qty("bsc-1", "excellent")).toBe(0);
    expect(await record(s, v.variantId)).toMatchObject({
      status: "idle",
      counts: { listed: 0, pushed: 1, zeroed: 1, skipped: 0 },
    });
    expect(await outbox(s)).toHaveLength(0);
  });

  test("a Sync of an empty variant (pressed after its last run) reads every condition and zeroes all of them", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    const added = await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 40 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s);
    expect(bsc.qty("bsc-1", "near_mint")).toBe(1);

    await s.t.run(async (ctx) => {
      await ctx.db.delete(added.copyId as Id<"collectionCopies">);
    });
    // Something NB never pushed sits under another condition on BSC.
    bsc.set("bsc-1", "very_good", { availableQuantity: 3, price: "1.00", sellerSku: "303|1" });
    // What `listingSync.syncVariant` does to an empty variant: stamp the
    // press (later than the last run), queue one BSC-linked card so the run
    // happens. The last clean run is kept.
    const rec = await record(s, v.variantId);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(rec!._id, { resyncRequestedAt: (rec!.lastRunAt ?? 0) + 1 });
    });
    bsc.sheetReads = [];
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 2 }]);
    await drain(s);

    expect([...new Set(bsc.sheetReads.map((r) => r.condition))].sort()).toEqual([...MODERN].sort());
    expect(bsc.qty("bsc-1", "near_mint")).toBe(0);
    expect(bsc.qty("bsc-1", "very_good")).toBe(0);
    expect((await record(s, v.variantId))?.counts).toMatchObject({ listed: 0, zeroed: 2 });
  });
});

describe("drainOwner: an in-person box (Revision 4)", () => {
  test("its copies count 0 on BSC; a listed box's copies of the same card still count", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, {
      cards: [
        { number: "1", ref: "bsc-1" },
        { number: "2", ref: "bsc-2" },
      ],
    });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-1", cardNo: "1" },
        { bscCardId: "bsc-2", cardNo: "2" },
      ],
      MODERN,
    );
    // BSC still shows what NB pushed before box B went in-person.
    bsc.set("bsc-2", "near_mint", { availableQuantity: 2, price: "1.00", sellerSku: "303|2" });
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await add(s, v.cardIds[0], { homeId: s.box2, condition: "Near Mint", minPriceCents: 50 });
    await add(s, v.cardIds[1], { homeId: s.box2, condition: "Near Mint", quantity: 2, minPriceCents: 50 });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.box2, { listedOnMarketplaces: false });
    });
    await listOnBsc(s);
    await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId },
      { cardId: v.cardIds[1], variantId: v.variantId },
    ]);

    await drain(s);

    // Box A's one copy of #1 lists; box B (in-person) adds nothing to it and
    // takes #2 down to 0.
    expect(bsc.qty("bsc-1", "near_mint")).toBe(1);
    expect(bsc.qty("bsc-2", "near_mint")).toBe(0);
    expect(await record(s, v.variantId)).toMatchObject({ status: "idle", counts: { listed: 1 } });
  });
});

describe("drainOwner: a Sync press reads every condition once", () => {
  test("the run after the press reads them all; the run after that reads only what it needs", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 40 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await drain(s); // the first sync: every condition
    const first = await record(s, v.variantId);

    await s.t.run(async (ctx) => {
      await ctx.db.patch(first!._id, { resyncRequestedAt: (first!.lastRunAt ?? 0) + 1 });
    });
    bsc.sheetReads = [];
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 2 }]);
    await drain(s);
    expect([...new Set(bsc.sheetReads.map((r) => r.condition))].sort()).toEqual([...MODERN].sort());
    // The press is spent: the last clean run is kept, the stamp is behind it.
    const after = await record(s, v.variantId);
    expect(after?.lastSuccessAt).toBeTypeOf("number");
    // Equal is spent too (the drain re-reads only on `resyncRequestedAt >
    // lastRunAt`), and the run can land in the stamp's own millisecond.
    expect(after!.lastRunAt!).toBeGreaterThanOrEqual(after!.resyncRequestedAt!);

    bsc.sheetReads = [];
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 3 }]);
    await drain(s);
    expect([...new Set(bsc.sheetReads.map((r) => r.condition))]).toEqual(["near_mint"]);
  });
});

describe("drainOwner: listing stopped under a run", () => {
  // What removing the BSC sign-in does to the row
  // (`listingOutbox.stopListingForSite`).
  const deleteState = (s: S) =>
    s.t.run(async (ctx) => {
      const row = await ctx.db
        .query("marketplaceListingStates")
        .withIndex("by_owner_platform", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc"))
        .unique();
      if (row) await ctx.db.patch(row._id, { listingStartedAt: undefined, dormant: "noCredentials" });
    });

  test("between variants: the next variant is never claimed, and nothing is recreated or rescheduled", async () => {
    const s = await setup();
    const a = await seedVariant(s.t, { name: "A", cards: [{ number: "1", ref: "bsc-a1" }] });
    const b = await seedVariant(s.t, { name: "B", cards: [{ number: "1", ref: "bsc-b1" }] });
    const bsc = new FakeBsc(
      [
        { bscCardId: "bsc-a1", cardNo: "1" },
        { bscCardId: "bsc-b1", cardNo: "1" },
      ],
      MODERN,
    );
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, a.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await add(s, b.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [
      { cardId: a.cardIds[0], variantId: a.variantId },
      { cardId: b.cardIds[0], variantId: b.variantId },
    ]);
    // The collector removes their sign-in while the first variant's push is
    // in flight (the outbox clear has not reached the second row yet).
    bsc.onPut = async () => {
      await deleteState(s);
    };

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report.stoppedFor).toBe("listingOff");
    expect(report.variants).toHaveLength(2);
    expect(bsc.puts).toHaveLength(1);
    const [first, second] = report.variants;
    expect(first.result).toBe("ok");
    expect(second.result).toBe("off");
    expect(await record(s, second.variantId)).toBeNull();
    // Kept, stopped (its order cursor and sales stay).
    expect(await state(s)).toMatchObject({ dormant: "noCredentials" });
    expect((await state(s))?.listingStartedAt).toBeUndefined();
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    const scheduled = await s.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("listingDrain"))).toHaveLength(0);
  });

  test("before a PUT: nothing is pushed, the variant's record is closed, and the rows are left to the clear", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    bsc.onSheetRead = async () => {
      await deleteState(s);
    };

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report.stoppedFor).toBe("listingOff");
    expect(bsc.puts).toHaveLength(0);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toMatch(/stopped part-way/);
    expect(rec?.leaseToken).toBeUndefined();
    expect(await outbox(s)).toHaveLength(1);
    expect(await state(s)).toMatchObject({ dormant: "noCredentials" });
  });
});

describe("drainOwner: the credential gate", () => {
  const setCredential = (s: S, entry: Record<string, unknown> | null) =>
    s.t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", OWNER))
        .unique();
      await ctx.db.patch(profile!._id, {
        siteCredentials: entry ? [{ site: "buysportscards", ...entry }] : [],
      } as never);
    });

  test("no saved credentials: nothing is fetched, the state goes dormant and the rows wait", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await setCredential(s, null);
    await listOnBsc(s, { drainScheduledAt: Date.now() });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report).toMatchObject({ claimed: false, stoppedFor: "noCredentials" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(creds.tokenCalls).toBe(0);
    const st = await state(s);
    expect(st?.dormant).toBe("noCredentials");
    // Stopped like a removed sign-in: saving it again starts it again.
    expect(st?.listingStartedAt).toBeUndefined();
    expect(st?.drainScheduledAt).toBeUndefined();
    expect(st?.drainLeaseToken).toBeUndefined();
    expect(await outbox(s)).toHaveLength(1);
  });

  test("a state row that was never started (Revision 3's `enabled` only) is not drained", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await listOnBsc(s, { listingStartedAt: undefined, enabled: true });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report).toMatchObject({ claimed: false, stoppedFor: "notClaimed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a session that needs a fresh sign-in is never logged into by a drain", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await setCredential(s, { hasCredentials: true, needsReauth: true });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report).toMatchObject({ claimed: false, stoppedFor: "needsReauth" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(creds.tokenCalls).toBe(0);
    expect(creds.refreshCalls).toBe(0);
    expect((await state(s))?.dormant).toBeUndefined();
    expect(await outbox(s)).toHaveLength(1);
  });

  test("a dormant row is never drained", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await listOnBsc(s, { dormant: "sellerConflict" });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });
    expect(report).toMatchObject({ claimed: false, stoppedFor: "notClaimed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("drainOwner: one NB owner per seller account", () => {
  test("a seller account another owner already lists from: nothing is pushed, the row goes dormant", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "someone_else",
        platform: "bsc",
        platformAccountId: "seller-1",
        listingStartedAt: NOW,
        lastUpdated: NOW,
      });
    });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report.stoppedFor).toBe("sellerConflict");
    expect(bsc.puts).toHaveLength(0);
    expect(bsc.qty("bsc-1", "near_mint")).toBe(0);
    const st = await state(s);
    expect(st?.dormant).toBe("sellerConflict");
    expect(st?.platformAccountId).toBeUndefined();
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toMatch(/another NeonBinder account/);
    expect(await outbox(s)).toHaveLength(1);
    expect(await pendingDrains(s)).toEqual([]);
  });

  test("an owner who stopped (sign-in removed) or is held back holds the account against nobody: the drain binds and pushes", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
    await listOnBsc(s);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "stopped_owner",
        platform: "bsc",
        platformAccountId: "seller-1",
        dormant: "noCredentials",
        lastUpdated: NOW,
      });
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: "conflicted_owner",
        platform: "bsc",
        platformAccountId: "seller-1",
        listingStartedAt: NOW,
        dormant: "sellerConflict",
        lastUpdated: NOW,
      });
    });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);

    const report = await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" });

    expect(report.stoppedFor).not.toBe("sellerConflict");
    expect(bsc.qty("bsc-1", "near_mint")).toBe(1);
    const st = await state(s);
    expect(st?.dormant).toBeUndefined();
    expect(st?.platformAccountId).toBe("seller-1");
  });
});

// ── NEO-415: the run's steps on the sync record ─────────────────────────────

/** A record's ledger, compact: "kind Cond/Cond: status" (NB condition names only). */
const stepsOf = async (s: S, variantId: Id<"selectorOptions">): Promise<string[] | null> => {
  const rec = await record(s, variantId);
  return (
    rec?.progress?.steps.map((x) => `${x.kind}${x.conditions ? ` ${x.conditions.join("/")}` : ""}: ${x.status}`) ?? null
  );
};

/** Two cards: a Near Mint #1 and an Excellent #2, both in a listed box, queued. */
async function twoCards(s: S, opts: { year?: string; conditions?: readonly string[] } = {}) {
  const v = await seedVariant(s.t, {
    ...(opts.year ? { year: opts.year } : {}),
    cards: [
      { number: "1", ref: "bsc-1" },
      { number: "2", ref: "bsc-2" },
    ],
  });
  const bsc = new FakeBsc(
    [
      { bscCardId: "bsc-1", cardNo: "1" },
      { bscCardId: "bsc-2", cardNo: "2" },
    ],
    opts.conditions ?? MODERN,
  );
  vi.stubGlobal("fetch", bsc.fetch);
  const first = await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 50 });
  await add(s, v.cardIds[1], { homeId: s.box, condition: "Excellent", minPriceCents: 50 });
  await listOnBsc(s);
  await queue(s, [
    { cardId: v.cardIds[0], variantId: v.variantId },
    { cardId: v.cardIds[1], variantId: v.variantId },
  ]);
  return { v, bsc, first };
}

describe("drainOwner: the run's steps (NEO-415)", () => {
  test("one read per condition sheet, the send, a confirm per condition sent: each flips as it happens", async () => {
    const s = await setup();
    const { v, bsc } = await twoCards(s);
    const seen: Array<string[] | null> = [];
    bsc.onSheetRead = async () => {
      seen.push(await stepsOf(s, v.variantId));
    };
    bsc.onPut = async () => {
      seen.push(await stepsOf(s, v.variantId));
    };

    await drain(s);

    const plan = ["read Mint/Near Mint", "read Excellent", "read Very Good/Good", "read Poor", "send"];
    const at = (working: number, labels: string[]) =>
      labels.map((l, i) => `${l}: ${i < working ? "done" : i === working ? "working" : "waiting"}`);
    const confirms = ["confirm Mint/Near Mint", "confirm Excellent"];
    expect(seen).toEqual([
      // The four reads, one at a time.
      at(0, plan),
      at(1, plan),
      at(2, plan),
      at(3, plan),
      // The PUT: every read done, the confirms known now and waiting.
      at(4, [...plan, ...confirms]),
      // The read-back, condition by condition.
      at(5, [...plan, ...confirms]),
      at(6, [...plan, ...confirms]),
    ]);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("idle");
    expect(await stepsOf(s, v.variantId)).toEqual([...plan, ...confirms].map((l) => `${l}: done`));
    expect(rec?.progress?.steps.every((x) => typeof x.finishedAt === "number")).toBe(true);
    // A read names its NB conditions, best first; `condition` is the first.
    expect(rec?.progress?.steps[0]).toMatchObject({ kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"] });
    expect(rec?.progress?.runStartedAt).toBe(rec?.lastRunAt);
    // Never a BSC condition key.
    expect(JSON.stringify(rec?.progress)).not.toMatch(/near_mint|very_good|excellent|poor"/);
  });

  test("a run with nothing to send drops the send: no step is left waiting", async () => {
    const s = await setup();
    const { v } = await twoCards(s);
    await drain(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId, seq: 2 }]);

    await drain(s);

    // The later run reads the targets' conditions and the ones pushed before; nothing changed.
    expect(await stepsOf(s, v.variantId)).toEqual(["read Mint/Near Mint: done", "read Excellent: done"]);
  });

  test("a read BSC fails marks that read failed and drops every later step", async () => {
    const s = await setup();
    const { v, bsc } = await twoCards(s);
    let reads = 0;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("seller/bulk-upload/results") && ++reads === 2) return new Response("", { status: 500 });
      return bsc.fetch(url, init);
    }) as typeof fetch);

    await drain(s);

    expect((await record(s, v.variantId))?.status).toBe("error");
    expect(await stepsOf(s, v.variantId)).toEqual(["read Mint/Near Mint: done", "read Excellent: failed"]);
    expect(bsc.puts).toEqual([]);
  });

  test("a PUT BSC refuses marks the send failed; the read-back still runs and its confirms finish", async () => {
    const s = await setup();
    const { v, bsc } = await twoCards(s);
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("seller/bulk-upload") && init?.method === "PUT") return new Response("", { status: 400 });
      return bsc.fetch(url, init);
    }) as typeof fetch);

    await drain(s);

    expect((await record(s, v.variantId))?.status).toBe("error");
    expect(await stepsOf(s, v.variantId)).toEqual([
      "read Mint/Near Mint: done",
      "read Excellent: done",
      "read Very Good/Good: done",
      "read Poor: done",
      "send: failed",
      "confirm Mint/Near Mint: done",
      "confirm Excellent: done",
    ]);
  });

  test("vintage: one read per NB condition, the sheets NB lists nothing under read last as one step", async () => {
    const s = await setup();
    const VINTAGE = ["mint", "nm-mt", "nm", "ex-mt", "ex", "vg-ex", "vg", "good", "fair", "poor-v"];
    const { v, bsc } = await twoCards(s, { year: "1975", conditions: VINTAGE });

    await drain(s);

    expect(await stepsOf(s, v.variantId)).toEqual([
      "read Mint: done",
      "read Near Mint: done",
      "read Excellent: done",
      "read Very Good: done",
      "read Good: done",
      "read Poor: done",
      "read: done",
      "send: done",
      "confirm Near Mint: done",
      "confirm Excellent: done",
    ]);
    // Still every sheet, still one at a time; NB's named sheets first.
    expect(bsc.sheetReads.slice(0, VINTAGE.length).map((r) => r.condition)).toEqual([
      "mint",
      "nm",
      "ex",
      "vg",
      "good",
      "poor-v",
      "nm-mt",
      "ex-mt",
      "vg-ex",
      "fair",
    ]);
    expect(JSON.stringify((await record(s, v.variantId))?.progress)).not.toMatch(/nm-mt|ex-mt|vg-ex|fair|poor-v/);
  });

  test("seller photos are a step of their own, between the reads and the send", async () => {
    const s = await setup();
    const { v, bsc, first } = await twoCards(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(first.copyId as Id<"collectionCopies">, { hasPhotos: true });
      await ctx.db.insert("collectionCopyPhotos", {
        ownerId: OWNER,
        copyId: first.copyId as Id<"collectionCopies">,
        side: "front",
        token: "tokfront",
        contentType: "image/jpeg",
        imageBytes: 1000,
        thumbBytes: 100,
        status: "live",
        since: NOW,
      });
    });
    const seen: Array<string[] | null> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/attachment")) {
        seen.push(await stepsOf(s, v.variantId));
        return Response.json({ objectKey: "seller/photo-1.jpg" });
      }
      return bsc.fetch(url, init);
    }) as typeof fetch);

    await drainOwnerImpl(stubCtx(s.t), { ownerId: OWNER, platform: "bsc" }, { fetchPhoto: async () => new ArrayBuffer(8) });

    expect(seen[0]).toEqual([
      "read Mint/Near Mint: done",
      "read Excellent: done",
      "read Very Good/Good: done",
      "read Poor: done",
      "photos: working",
      "send: waiting",
    ]);
    expect(await stepsOf(s, v.variantId)).toEqual([
      "read Mint/Near Mint: done",
      "read Excellent: done",
      "read Very Good/Good: done",
      "read Poor: done",
      "photos: done",
      "send: done",
      "confirm Mint/Near Mint: done",
      "confirm Excellent: done",
    ]);
  });

  test("NEO-427: a row's seller photo comes from the oldest copy with one, not the oldest copy", async () => {
    const s = await setup();
    const { v, bsc, first } = await twoCards(s);
    // `first` is the older line and has no photo; a newer line of the same card and condition does.
    const newer = await add(s, v.cardIds[0], {
      homeId: s.box,
      condition: "Near Mint",
      minPriceCents: 50,
      notes: "the scanned one",
    });
    expect(newer.copyId).not.toBe(first.copyId);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(newer.copyId as Id<"collectionCopies">, { hasPhotos: true });
      await ctx.db.insert("collectionCopyPhotos", {
        ownerId: OWNER,
        copyId: newer.copyId as Id<"collectionCopies">,
        side: "front",
        token: "toknewer",
        contentType: "image/jpeg",
        imageBytes: 1000,
        thumbBytes: 100,
        status: "live",
        since: NOW,
      });
    });
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/attachment")) return Response.json({ objectKey: "seller/photo-1.jpg" });
      return bsc.fetch(url, init);
    }) as typeof fetch);
    const fetched: string[] = [];

    await drainOwnerImpl(
      stubCtx(s.t),
      { ownerId: OWNER, platform: "bsc" },
      {
        fetchPhoto: async (key) => {
          fetched.push(key);
          return new ArrayBuffer(8);
        },
      },
    );

    expect(fetched).toEqual(["copy-photos/toknewer/image.jpg"]);
  });

  test("a sign-in BSC refuses on the first read fails that read and leaves nothing waiting", async () => {
    const s = await setup();
    const { v, bsc } = await twoCards(s);
    bsc.unauthorized = 99;
    creds.refreshed = false;
    await drain(s);
    expect((await record(s, v.variantId))?.status).toBe("error");
    expect(await stepsOf(s, v.variantId)).toEqual(["read Mint/Near Mint: failed"]);
  });
});

describe("claimVariant: a new run's ledger", () => {
  test("the claim replaces the last run's steps with an empty ledger stamped with the run's start", async () => {
    const s = await setup();
    const { v } = await twoCards(s);
    await drain(s);
    expect((await stepsOf(s, v.variantId))?.length).toBeGreaterThan(0);
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { drainLeaseToken: "lease-2", drainLeaseExpiresAt: Date.now() + 60_000 });
    });
    const claim = await s.t.mutation(internal.listingDrain.claimVariant, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: v.variantId,
      leaseToken: "lease-2",
    });
    expect(claim.claimed).toBe(true);
    const rec = await record(s, v.variantId);
    expect(rec?.progress).toEqual({ runStartedAt: rec?.lastRunAt, steps: [] });
  });
});

describe("a BSC run with nothing to read or send (NEO-433)", () => {
  test("it replaces the last run's steps with the compare step alone, done, and pushes nothing", async () => {
    const s = await setup();
    const { v } = await twoCards(s);
    await drain(s);
    expect((await stepsOf(s, v.variantId))?.length).toBeGreaterThan(1);
    // Nothing held any more, and no condition NB pushed before: nothing to read.
    await s.t.run(async (ctx) => {
      for (const c of await ctx.db.query("collectionCopies").collect()) await ctx.db.delete(c._id);
      const rec = await ctx.db.query("marketplaceListingSyncs").first();
      await ctx.db.patch(rec!._id, { conditionsPushed: [] });
    });
    await queue(s, [
      { cardId: v.cardIds[0], variantId: v.variantId, seq: 2 },
      { cardId: v.cardIds[1], variantId: v.variantId, seq: 2 },
    ]);

    await drain(s);

    expect(await stepsOf(s, v.variantId)).toEqual(["check: done"]);
    const rec = await record(s, v.variantId);
    expect(rec?.status).toBe("idle");
    expect(rec?.counts?.pushed).toBe(0);
    expect(rec?.progress?.steps[0].finishedAt).toBeTypeOf("number");
  });
});

describe("settleSteps", () => {
  const step = (status: "waiting" | "working" | "done" | "failed") => ({ kind: "read" as const, status });
  test("drops waiting steps; a working step ends done on ok and failed on error", () => {
    const steps = [step("done"), step("working"), step("waiting")];
    expect(settleSteps(steps, "ok", 5)).toEqual([step("done"), { ...step("done"), finishedAt: 5 }]);
    expect(settleSteps(steps, "error", 5)).toEqual([step("done"), { ...step("failed"), finishedAt: 5 }]);
  });
});

describe("writeProgress: the lease guard", () => {
  const waiting = (n: number) => Array.from({ length: n }, () => ({ kind: "read" as const, status: "waiting" as const }));

  /** A variant whose record is `running` under lease-2 (the drain lease is held by the same token). */
  async function running() {
    const s = await setup();
    const { v } = await twoCards(s);
    await drain(s);
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { drainLeaseToken: "lease-2", drainLeaseExpiresAt: Date.now() + 60_000 });
    });
    await s.t.mutation(internal.listingDrain.claimVariant, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: v.variantId,
      leaseToken: "lease-2",
    });
    return { s, v };
  }
  const write = (s: S, variantId: Id<"selectorOptions">, leaseToken: string, steps: ReturnType<typeof waiting>) =>
    s.t.mutation(internal.listingDrain.writeProgress, { ownerId: OWNER, platform: "bsc", variantId, leaseToken, steps });

  test("a matching lease token writes the steps and returns true", async () => {
    const { s, v } = await running();
    expect(await write(s, v.variantId, "lease-2", waiting(2))).toBe(true);
    expect((await record(s, v.variantId))?.progress?.steps).toEqual(waiting(2));
  });

  test("a wrong lease token returns false and leaves the stored steps alone", async () => {
    const { s, v } = await running();
    await write(s, v.variantId, "lease-2", waiting(2));
    expect(await write(s, v.variantId, "someone-else", waiting(5))).toBe(false);
    expect((await record(s, v.variantId))?.progress?.steps).toEqual(waiting(2));
  });

  test("a record no longer running returns false and leaves the stored steps alone", async () => {
    const { s, v } = await running();
    await write(s, v.variantId, "lease-2", waiting(2));
    await s.t.run(async (ctx) => {
      const rec = await ctx.db.query("marketplaceListingSyncs").first();
      await ctx.db.patch(rec!._id, { status: "idle" });
    });
    expect(await write(s, v.variantId, "lease-2", waiting(5))).toBe(false);
    expect((await record(s, v.variantId))?.progress?.steps).toEqual(waiting(2));
  });

  test("more than MAX_PROGRESS_STEPS steps are cut to the limit", async () => {
    const { s, v } = await running();
    expect(await write(s, v.variantId, "lease-2", waiting(MAX_PROGRESS_STEPS + 7))).toBe(true);
    expect((await record(s, v.variantId))?.progress?.steps).toHaveLength(MAX_PROGRESS_STEPS);
  });
});

describe("ProgressLedger", () => {
  const ids = { ownerId: OWNER, platform: "bsc" as const, variantId: "v1" as Id<"selectorOptions">, leaseToken: "l" };
  function ledger() {
    const runMutation = vi.fn(async () => true);
    const l = new ProgressLedger({ runMutation } as unknown as DrainCtx, ids, () => 7);
    return { l, runMutation };
  }
  const kinds = (l: ProgressLedger) => l.steps().map((x) => `${x.kind}:${x.status}`);

  test("add with a beforeKey inserts ahead of that step; an unknown beforeKey appends", () => {
    const { l } = ledger();
    l.plan([{ key: "a", kind: "read" }, { key: "c", kind: "send" }]);
    l.add([{ key: "b", kind: "confirm" }], "c");
    expect(kinds(l)).toEqual(["read:waiting", "confirm:waiting", "send:waiting"]);
    l.add([{ key: "z", kind: "photos" }], "nope");
    expect(kinds(l).at(-1)).toBe("photos:waiting");
  });

  test("add skips a key the ledger already has", () => {
    const { l } = ledger();
    l.plan([{ key: "a", kind: "read" }]);
    l.add([{ key: "a", kind: "send" }]);
    expect(kinds(l)).toEqual(["read:waiting"]);
  });

  test("start on a step already working, or on an unknown key, writes nothing", async () => {
    const { l, runMutation } = ledger();
    l.plan([{ key: "a", kind: "read" }]);
    await l.start("a");
    expect(runMutation).toHaveBeenCalledTimes(1);
    await l.start("a");
    await l.start("missing");
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(kinds(l)).toEqual(["read:working"]);
  });

  test("start ends the working step done and starts the next in one write", async () => {
    const { l, runMutation } = ledger();
    l.plan([{ key: "a", kind: "read" }, { key: "b", kind: "send" }]);
    await l.start("a");
    await l.start("b");
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(kinds(l)).toEqual(["read:done", "send:working"]);
    expect(l.steps()[0].finishedAt).toBe(7);
  });

  test("fail on an unknown key changes nothing", () => {
    const { l } = ledger();
    l.plan([{ key: "a", kind: "read" }]);
    l.fail("missing");
    expect(kinds(l)).toEqual(["read:waiting"]);
    l.fail("a");
    expect(kinds(l)).toEqual(["read:failed"]);
  });
});

describe("finishVariant: progress", () => {
  test("with progress omitted it keeps the stored steps and settles them", async () => {
    const s = await setup();
    const { v } = await twoCards(s);
    await drain(s);
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { drainLeaseToken: "lease-2", drainLeaseExpiresAt: Date.now() + 60_000 });
    });
    await s.t.mutation(internal.listingDrain.claimVariant, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: v.variantId,
      leaseToken: "lease-2",
    });
    const steps = [
      { kind: "read" as const, status: "done" as const, finishedAt: 1 },
      { kind: "send" as const, status: "working" as const },
      { kind: "confirm" as const, status: "waiting" as const },
    ];
    await s.t.mutation(internal.listingDrain.writeProgress, {
      ownerId: OWNER, platform: "bsc", variantId: v.variantId, leaseToken: "lease-2", steps,
    });

    const out = await s.t.mutation(internal.listingDrain.finishVariant, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: v.variantId,
      leaseToken: "lease-2",
      outcome: { kind: "error", error: "boom" },
      clear: [],
      repoint: [],
    });

    expect(out.recorded).toBe(true);
    const stored = (await record(s, v.variantId))?.progress?.steps;
    expect(stored?.map((x) => `${x.kind}:${x.status}`)).toEqual(["read:done", "send:failed"]);
  });
});

describe("NEO-433: a run the platform killed", () => {
  const TOKEN = "the-run";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // convex-test logs every scheduled function that throws; the fixture is meant to.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Moves the clock and lets whatever fell due run to the end. */
  const advance = async (s: S, ms: number) => {
    vi.advanceTimersByTime(ms);
    await s.t.finishInProgressScheduledFunctions();
  };
  /** Moves the clock while a run is held open (finishing it would wait forever). */
  const advanceHeld = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const scheduled = (s: S, name: string, kind?: string) =>
    s.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes(name) && (kind === undefined || f.state.kind === kind),
      ),
    );
  const pendingWatch = (s: S) => scheduled(s, "watchDrainRun", "pending");
  const claimAs = (s: S, leaseToken: string, kickToken?: string) =>
    s.t.mutation(internal.listingDrain.claimDrain, {
      ownerId: OWNER,
      platform: "bsc",
      leaseToken,
      ...(kickToken !== undefined ? { kickToken } : {}),
    });
  /** A real scheduled function that really fails, as a kick would have stamped it. */
  const failingFn = (s: S) =>
    s.t.run(async (ctx) => await ctx.scheduler.runAfter(0, internal.testing.failLikeAKilledDrain, {}));

  /**
   * A run that claimed through its kick and is mid-step on one variant, with one
   * queued row, and whose function has really failed. The watcher has not looked yet.
   */
  async function deadRunMidStep(s: S) {
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 40 });
    const fnId = await failingFn(s);
    await listOnBsc(s, { drainKickToken: "kick", drainKickFnId: fnId });
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    expect(await claimAs(s, TOKEN, "kick")).toEqual({ claimed: true });
    const ids = { ownerId: OWNER, platform: "bsc" as const, variantId: v.variantId, leaseToken: TOKEN };
    await s.t.mutation(internal.listingDrain.claimVariant, ids);
    await s.t.mutation(internal.listingDrain.writeProgress, {
      ...ids,
      steps: [
        { kind: "read", status: "done", finishedAt: Date.now() },
        { kind: "send", status: "working" },
        { kind: "confirm", status: "waiting" },
      ],
    });
    await advance(s, 0);
    const fn = await s.t.run(async (ctx) => await ctx.db.system.get(fnId));
    expect(fn?.state.kind).toBe("failed");
    return { v, ids, fnId };
  }

  test("a slow run the platform says is in progress is never reclaimed, however old its ledger", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    let letGo = () => undefined as void;
    bsc.onSheetRead = () => new Promise<void>((resolve) => (letGo = resolve));
    vi.stubGlobal("fetch", bsc.fetch);
    await add(s, v.cardIds[0], { homeId: s.box, condition: "Near Mint", minPriceCents: 40 });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await s.t.run(async (ctx) => {
      await kickOwnerDrains(ctx as never, OWNER);
    });
    await advanceHeld(0);
    expect(bsc.sheetReads).toHaveLength(1);
    const [fn] = await scheduled(s, "drainOwner");
    expect(fn.state.kind).toBe("inProgress");
    const held = await state(s);
    const ledgerBefore = (await record(s, v.variantId))?.progress?.steps;

    // Eleven and a half minutes with nothing landing: the ledger goes stale, the watcher keeps looking.
    for (let i = 0; i < 23; i += 1) await advanceHeld(30_000);
    const during = await state(s);
    expect(during?.drainLeaseToken).toBe(held?.drainLeaseToken);
    expect(during?.drainLeaseExpiresAt).toBe(held?.drainLeaseExpiresAt);
    expect(during?.drainRunDeadAt).toBeUndefined();
    expect((await record(s, v.variantId))?.status).toBe("running");
    expect((await record(s, v.variantId))?.progress?.steps).toEqual(ledgerBefore);
    expect(await claimAs(s, "a-second-run")).toEqual({ claimed: false, reason: "busy" });
    expect(await s.t.query(internal.listingDrain.drainHeld, { ownerId: OWNER, platform: "bsc", leaseToken: held!.drainLeaseToken! })).toBe(true);
    expect(await pendingWatch(s)).toHaveLength(1);

    // It finishes after all: released as ever, and the watcher ends on its next look.
    bsc.onSheetRead = undefined;
    letGo();
    await s.t.finishInProgressScheduledFunctions();
    expect((await record(s, v.variantId))?.status).toBe("idle");
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    await advance(s, 30_000);
    expect(await pendingWatch(s)).toHaveLength(0);
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
  });

  test("a failed run: running stops at the watcher's next look, the claim waits out the grace, then takes it", async () => {
    const s = await setup();
    const { v } = await deadRunMidStep(s);
    const before = await record(s, v.variantId);

    await advance(s, DRAIN_WATCH_TICK_MS);
    const dead = await state(s);
    expect(dead?.drainRunDeadAt).toBeTypeOf("number");
    expect(dead?.drainLeaseExpiresAt).toBe(dead!.drainRunDeadAt! + DRAIN_DEATH_GRACE_MS);
    expect(dead?.drainLeaseToken).toBe(TOKEN);

    // The open status page flips on this write alone: not running, last result, the failed step.
    const settled = await record(s, v.variantId);
    expect(settled?.status).toBe("idle");
    expect(settled?.lastError).toBeUndefined();
    expect(settled?.lastRunAt).toBe(before?.lastRunAt);
    expect(settled?.progress?.steps.map((x) => `${x.kind}:${x.status}`)).toEqual(["read:done", "send:failed"]);
    const status = await s.me.query(api.listingSync.syncStatus, {});
    const bsc = status.platforms.find((p) => p.platform === "bsc");
    expect(bsc?.running).toBeNull();
    expect(bsc?.sets[0].status).toBe("idle");
    expect(bsc?.sets[0].steps.map((x) => `${x.kind}:${x.status}`)).toEqual(["read:done", "send:failed"]);

    // In flight calls can still land: nobody else may write until the grace is up.
    expect(await claimAs(s, "too-soon")).toEqual({ claimed: false, reason: "busy" });
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { drainRequested: undefined });
    });
    await advance(s, DRAIN_DEATH_GRACE_MS);
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
    expect(await claimAs(s, "after-grace")).toEqual({ claimed: true });
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
  });

  test("the grace is the longest single call plus ten seconds", () => {
    expect(DRAIN_DEATH_GRACE_MS).toBe(
      Math.max(BSC_SELLER_TIMEOUTS_MS.sheet, BSC_SELLER_TIMEOUTS_MS.put, EBAY_TIMEOUTS_MS.bulk) + 10_000,
    );
    expect(DRAIN_DEATH_GRACE_MS).toBeGreaterThan(Math.max(...Object.values(EBAY_TIMEOUTS_MS), ...Object.values(BSC_SELLER_TIMEOUTS_MS)));
  });

  test("a function that ended in success with the lease still held is dead too", async () => {
    const s = await setup();
    // A real function that really succeeds: a release naming some other token changes nothing.
    const fnId = await s.t.run(
      async (ctx) =>
        await ctx.scheduler.runAfter(0, internal.listingDrain.releaseDrain, {
          ownerId: OWNER,
          platform: "bsc",
          leaseToken: "not-this-run",
          next: "done",
        }),
    );
    await listOnBsc(s, { drainKickToken: "kick", drainKickFnId: fnId });
    await claimAs(s, TOKEN, "kick");
    await advance(s, 0);
    expect((await s.t.run(async (ctx) => await ctx.db.system.get(fnId)))?.state.kind).toBe("success");
    await advance(s, DRAIN_WATCH_TICK_MS);
    expect((await state(s))?.drainRunDeadAt).toBeTypeOf("number");
  });

  test("canceled is not death: the lease stands to its 12 minutes and the watch ends there", async () => {
    const s = await setup();
    const fnId = await s.t.run(async (ctx) => await ctx.scheduler.runAfter(60_000, internal.testing.failLikeAKilledDrain, {}));
    await listOnBsc(s, { drainKickToken: "kick", drainKickFnId: fnId });
    await claimAs(s, TOKEN, "kick");
    await s.t.run(async (ctx) => await ctx.scheduler.cancel(fnId));
    const expiresAt = (await state(s))?.drainLeaseExpiresAt;
    for (let i = 0; i < 23; i += 1) await advance(s, 30_000);
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
    expect((await state(s))?.drainLeaseExpiresAt).toBe(expiresAt);
    expect(await pendingWatch(s)).toHaveLength(1);
    // The outer bound: no more looking, and the claim's own rule takes over.
    for (let i = 0; i < 2; i += 1) await advance(s, 30_000);
    expect(await pendingWatch(s)).toHaveLength(0);
    expect((await state(s))?.drainLeaseToken).toBe(TOKEN);
    expect(await claimAs(s, "next")).toEqual({ claimed: true });
  });

  test("a press during the grace gets a run, and that run reads every condition", async () => {
    const s = await setup();
    const { v } = await deadRunMidStep(s);
    await s.t.run(async (ctx) => {
      const rec = await ctx.db.query("marketplaceListingSyncs").first();
      await ctx.db.patch(rec!._id, { lastSuccessAt: Date.now() - 3_600_000, conditionsPushed: ["near_mint"] });
    });
    const bsc = new FakeBsc([{ bscCardId: "bsc-1", cardNo: "1" }], MODERN);
    vi.stubGlobal("fetch", bsc.fetch);
    await advance(s, DRAIN_WATCH_TICK_MS);
    expect((await state(s))?.drainRunDeadAt).toBeTypeOf("number");

    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: v.variantId })).toEqual({ queued: true });
    expect((await state(s))?.drainRequested).toBe(true);
    expect(await scheduled(s, "drainOwner")).toHaveLength(0);
    expect(bsc.sheetReads).toHaveLength(0);

    await advance(s, DRAIN_DEATH_GRACE_MS);
    await advance(s, 0);
    expect(await scheduled(s, "drainOwner", "success")).toHaveLength(1);
    expect([...new Set(bsc.sheetReads.map((r) => r.condition))].sort()).toEqual([...MODERN].sort());
    expect(bsc.qty("bsc-1", "near_mint")).toBe(1);
    expect(await outbox(s)).toHaveLength(0);
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    await advance(s, DRAIN_WATCH_TICK_MS);
    expect(await pendingWatch(s)).toHaveLength(0);
  });

  test("no press: the lease clears, nothing is scheduled, and the rows wait for the next kick", async () => {
    const s = await setup();
    await deadRunMidStep(s);
    await advance(s, DRAIN_WATCH_TICK_MS);
    await advance(s, DRAIN_DEATH_GRACE_MS);
    expect((await state(s))?.drainLeaseToken).toBeUndefined();
    expect((await state(s))?.lastDrainAt).toBeUndefined();
    expect(await scheduled(s, "drainOwner")).toHaveLength(0);
    expect(await pendingWatch(s)).toHaveLength(0);
    expect(await outbox(s)).toHaveLength(1);
  });

  test("a late write from the dead run records nothing, in the grace or after it", async () => {
    const s = await setup();
    const { v, ids } = await deadRunMidStep(s);
    await advance(s, DRAIN_WATCH_TICK_MS);
    const settled = await record(s, v.variantId);
    const late = async () => {
      expect(
        await s.t.mutation(internal.listingDrain.writeProgress, { ...ids, steps: [{ kind: "send", status: "done" }] }),
      ).toBe(false);
      const out = await s.t.mutation(internal.listingDrain.finishVariant, {
        ...ids,
        outcome: { kind: "ok", counts: { listed: 9, pushed: 9, zeroed: 0, skipped: 0 }, problems: [], problemsTotal: 0, conditionsPushed: ["near_mint"] },
        clear: [],
        repoint: [],
        progress: [{ kind: "send", status: "done" }],
      });
      expect(out.recorded).toBe(false);
      expect(await record(s, v.variantId)).toEqual(settled);
      expect(await s.t.mutation(internal.listingDrain.claimVariant, ids)).toEqual({ claimed: false, reason: "listingOff" });
    };
    await late();
    await advance(s, DRAIN_DEATH_GRACE_MS);
    await late();
  });

  test("drainHeld is false once dead (each PUT chunk stands down), and the watcher deletes no row", async () => {
    const s = await setup();
    const { ids } = await deadRunMidStep(s);
    const held = { ownerId: OWNER, platform: "bsc" as const, leaseToken: ids.leaseToken };
    expect(await s.t.query(internal.listingDrain.drainHeld, held)).toBe(true);
    await advance(s, DRAIN_WATCH_TICK_MS);
    expect(await s.t.query(internal.listingDrain.drainHeld, held)).toBe(false);
    expect(await outbox(s)).toHaveLength(1);
    await advance(s, DRAIN_DEATH_GRACE_MS);
    expect(await s.t.query(internal.listingDrain.drainHeld, held)).toBe(false);
    expect(await outbox(s)).toHaveLength(1);
  });

  test("an unlinked run has no signal: no watcher, and today's 12 minutes", async () => {
    const s = await setup();
    await listOnBsc(s);
    expect(await claimAs(s, TOKEN)).toEqual({ claimed: true });
    expect(await scheduled(s, "watchDrainRun")).toHaveLength(0);
    vi.advanceTimersByTime(DRAIN_LEASE_MS - 1);
    expect(await claimAs(s, "too-soon")).toEqual({ claimed: false, reason: "busy" });
    vi.advanceTimersByTime(1);
    expect(await claimAs(s, "next")).toEqual({ claimed: true });
  });

  test("a run holding some other kick's token leaves no fn id and gets no watcher", async () => {
    const s = await setup();
    const fnId = await failingFn(s);
    await listOnBsc(s, { drainKickToken: "their-kick", drainKickFnId: fnId });
    expect(await claimAs(s, TOKEN, "my-kick")).toEqual({ claimed: true });
    const st = await state(s);
    expect(st?.drainKickFnId).toBeUndefined();
    expect(st?.drainKickToken).toBeUndefined();
    expect(await scheduled(s, "watchDrainRun")).toHaveLength(0);
    // Their function failing says nothing about this run.
    await advance(s, 30_000);
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
  });

  test("a normal release ends the watch, even though the function has failed by then", async () => {
    const s = await setup();
    const fnId = await failingFn(s);
    await listOnBsc(s, { drainKickToken: "kick", drainKickFnId: fnId });
    await claimAs(s, TOKEN, "kick");
    await advance(s, 0);
    await s.t.mutation(internal.listingDrain.releaseDrain, { ownerId: OWNER, platform: "bsc", leaseToken: TOKEN, next: "done" });
    expect(await pendingWatch(s)).toHaveLength(1);
    await advance(s, DRAIN_WATCH_TICK_MS);
    expect(await pendingWatch(s)).toHaveLength(0);
    expect((await state(s))?.drainRunDeadAt).toBeUndefined();
  });

  test("a kick stamps the run it schedules, and a continuing release stamps its own", async () => {
    const s = await setup();
    const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
    await listOnBsc(s);
    await queue(s, [{ cardId: v.cardIds[0], variantId: v.variantId }]);
    await s.t.run(async (ctx) => {
      await kickOwnerDrains(ctx as never, OWNER);
    });
    const kicked = await state(s);
    const [run] = await scheduled(s, "drainOwner");
    expect(kicked?.drainKickFnId).toBe(run._id);
    expect((run.args[0] as { kickToken: string }).kickToken).toBe(kicked?.drainKickToken);

    await claimAs(s, TOKEN, kicked?.drainKickToken);
    expect((await state(s))?.drainKickFnId).toBeUndefined();
    expect((await pendingWatch(s))[0].args[0]).toMatchObject({ leaseToken: TOKEN, fnId: run._id });
    await s.t.mutation(internal.listingDrain.releaseDrain, { ownerId: OWNER, platform: "bsc", leaseToken: TOKEN, next: "continue" });
    const released = await state(s);
    expect(released?.drainKickFnId).toBeDefined();
    expect(released?.drainKickFnId).not.toBe(run._id);
    await cancelScheduled(s.t);
  });

  describe("the live-proof fixture", () => {
    const seed = (s: S) => s.me.mutation(api.testing.seedMyTestKilledDrain, { platform: "bsc" });

    test("is refused off an armed deployment", async () => {
      vi.stubEnv("TESTING_RESET_SECRET", "");
      const s = await setup();
      await listOnBsc(s);
      await expect(seed(s)).rejects.toThrow(/not enabled/);
    });

    test("is refused signed out, and while a run holds the lease", async () => {
      vi.stubEnv("TESTING_RESET_SECRET", "armed");
      const s = await setup();
      await listOnBsc(s, { drainLeaseToken: "a-real-run", drainLeaseExpiresAt: Date.now() + 60_000 });
      await expect(s.t.mutation(api.testing.seedMyTestKilledDrain, { platform: "bsc" })).rejects.toThrow(/Not authenticated/);
      await expect(seed(s)).rejects.toThrow(/never takes its lease/);
      expect((await state(s))?.drainLeaseToken).toBe("a-real-run");
    });

    test("reads as running, then flips through the real watcher with no grace, on the caller's rows alone", async () => {
      vi.stubEnv("TESTING_RESET_SECRET", "armed");
      const s = await setup();
      const v = await seedVariant(s.t, { cards: [{ number: "1", ref: "bsc-1" }] });
      await listOnBsc(s);
      const someoneElse = await s.t.run(async (ctx) => {
        await ctx.db.insert("marketplaceListingSyncs", {
          ownerId: OWNER,
          variantId: v.variantId,
          platform: "bsc",
          status: "idle",
          lastRunAt: Date.now() - 60_000,
          lastSuccessAt: Date.now() - 60_000,
          problems: [],
          conditionsPushed: [],
          lastUpdated: Date.now(),
        });
        return await ctx.db.insert("marketplaceListingStates", { ownerId: "another-collector", platform: "bsc", listingStartedAt: NOW, lastUpdated: NOW });
      });
      await seed(s);
      expect((await s.me.query(api.listingSync.syncStatus, {})).platforms.find((p) => p.platform === "bsc")?.running).not.toBeNull();
      await advance(s, 0);
      await advance(s, 3000);
      const status = (await s.me.query(api.listingSync.syncStatus, {})).platforms.find((p) => p.platform === "bsc");
      expect(status?.running).toBeNull();
      expect(status?.sets[0].steps.map((x) => `${x.kind}:${x.status}`)).toEqual(["send:failed"]);
      await advance(s, 0);
      expect((await state(s))?.drainLeaseToken).toBeUndefined();
      expect(await scheduled(s, "drainOwner")).toHaveLength(0);
      const other = await s.t.run(async (ctx) => await ctx.db.get(someoneElse));
      expect(other?.drainLeaseToken).toBeUndefined();
    });
  });
});
