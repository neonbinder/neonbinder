/**
 * NEO-483 — the background read of a collector's BuySportsCards seller
 * account (`bscSellerId.ts`).
 *
 * Nothing waits on BSC's profile endpoint any more: when an owner who lists on
 * BSC has no seller account stored, one spaced chain of single-attempt reads
 * fetches it, and landing it stamps the listing row and kicks the drain that
 * was held (`listingDrain.claimDrain`, `awaitingSeller`).
 *
 * Layout: the schedule and the chain's bookkeeping (ensure, scheduleNext,
 * tickState, stopChain), then the landing (`setMarketplaceAccountIdInternal`
 * -> `landBscSellerId`), then `fetchTick` itself against a stubbed `fetch`.
 * Timers are held (`setTimeout` faked) so every `runAfter` stays pending to be
 * read; whatever is left is cancelled before a test ends, and no test reaches
 * a live server.
 */
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  BSC_SELLER_ID_FETCH_COOLDOWN_MS,
  BSC_SELLER_ID_FETCH_DELAYS_MS,
  BSC_SELLER_ID_FETCH_MAX_ATTEMPTS,
  BSC_SELLER_ID_FETCH_STALE_MS,
  BSC_SELLER_ID_FETCH_TIMEOUT_MS,
  bscSellerIdFetchDelayAfter,
} from "./bscSellerId";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** What the mocked credentials layer answers; reset per test. */
const creds = vi.hoisted(() => ({
  token: "tok-LEAKCANARY" as string | null,
  refreshed: true,
  refreshCalls: 0,
  tokenCalls: 0,
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

const OWNER = "collector_sellerid_001";
const OTHER = "collector_sellerid_002";
const SELLER = "seller-LEAKCANARY-abc";
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  creds.token = "tok-LEAKCANARY";
  creds.refreshed = true;
  creds.refreshCalls = 0;
  creds.tokenCalls = 0;
  // Hold every runAfter so it stays pending to be inspected.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Seeding and reading ─────────────────────────────────────────────────────

type StateOpts = {
  listing?: boolean;
  dormant?: "sellerConflict" | "noCredentials";
  testListingOff?: boolean;
  platformAccountId?: string;
  fetch?: { token: string; startedAt: number; endedAt?: number; endReason?: "gaveUp" | "noSellerProfile" };
  drainScheduledAt?: number;
  lastUpdated?: number;
};

/** The owner's BSC state row, listing unless said otherwise. */
async function seedState(t: T, opts: StateOpts = {}, ownerId = OWNER): Promise<Id<"marketplaceListingStates">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId,
      platform: "bsc",
      lastUpdated: opts.lastUpdated ?? NOW,
      ...(opts.listing === false ? {} : { listingStartedAt: NOW }),
      ...(opts.dormant ? { dormant: opts.dormant } : {}),
      ...(opts.testListingOff ? { testListingOff: true } : {}),
      ...(opts.platformAccountId ? { platformAccountId: opts.platformAccountId } : {}),
      ...(opts.fetch ? { sellerIdFetch: opts.fetch } : {}),
      ...(opts.drainScheduledAt !== undefined ? { drainScheduledAt: opts.drainScheduledAt } : {}),
    }),
  );
}

async function seedProfile(t: T, sellerId?: string, ownerId = OWNER) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: ownerId,
      siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      ...(sellerId ? { marketplaceAccountIds: { bscSellerId: sellerId } } : {}),
    } as never);
  });
}

/** One queued change, so a kicked drain has something to run. */
async function queueOne(t: T, ownerId = OWNER) {
  await t.run(async (ctx) => {
    const variantId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      isCustom: false,
      children: [],
      lastUpdated: NOW,
    } as never);
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      isCustom: false,
      children: [],
      lastUpdated: NOW,
    } as never);
    const cardId = await ctx.db.insert("cardChecklist", {
      sportId,
      selectorOptionId: variantId,
      cardNumber: "1",
      cardName: "Player 1",
      listingTitle: "Card 1",
      platformData: {},
      isCustom: false,
      sortOrder: 0,
      lastUpdated: NOW,
    } as never);
    await ctx.db.insert("listingOutbox", { ownerId, platform: "bsc", cardId, variantId, seq: 1, changedAt: NOW });
  });
}

const stateOf = (t: T, ownerId = OWNER) =>
  t.run(async (ctx) =>
    ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId).eq("platform", "bsc"))
      .first(),
  );

const profileId = (t: T, ownerId = OWNER) =>
  t.run(async (ctx) => {
    const p = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", ownerId))
      .first();
    return p?.marketplaceAccountIds?.bscSellerId ?? null;
  });

type Job = { name: string; args: Record<string, unknown>; scheduledTime: number; state: { kind: string } };
const jobs = (t: T, part: string): Promise<Job[]> =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (j) => j.name.includes(part) && j.state.kind === "pending",
    ).map((j) => ({ ...j, args: (j.args as unknown as Array<Record<string, unknown>>)[0] })) as unknown as Job[],
  );
const ticks = (t: T) => jobs(t, "fetchTick");
const drainRuns = (t: T) => jobs(t, "drainOwner");

/** Runs `work` and returns the real wall time around it, to bound a `runAfter` delay. */
async function around<R>(work: () => Promise<R>): Promise<{ result: R; from: number; to: number }> {
  const from = Date.now();
  const result = await work();
  return { result, from, to: Date.now() };
}

const ensure = (t: T, firstDelayMs?: number, ownerId = OWNER) =>
  t.mutation(internal.bscSellerId.ensureFetch, { ownerId, ...(firstDelayMs !== undefined ? { firstDelayMs } : {}) });

const seedChain = (t: T, token = "chain-1", startedAt = Date.now()) => seedState(t, { fetch: { token, startedAt } });

/** A chain that ENDED `endedAgoMs` ago (field kept with `endedAt` and `endReason`). */
const seedEndedChain = (
  t: T,
  endReason: "gaveUp" | "noSellerProfile" = "gaveUp",
  endedAgoMs = 60_000,
  token = "ended-1",
) => {
  const endedAt = Date.now() - endedAgoMs;
  return seedState(t, { fetch: { token, startedAt: endedAt - 40 * 60_000, endedAt, endReason } });
};

/** The ensure a user action makes (Connect/save, Sync press, turning listing on). */
const ensureByUser = (t: T, firstDelayMs?: number, ownerId = OWNER) =>
  t.mutation(internal.bscSellerId.ensureFetch, {
    ownerId,
    userAction: true,
    ...(firstDelayMs !== undefined ? { firstDelayMs } : {}),
  });

/** The drain claim a scheduled drain (the 15-minute poll's) makes. */
const pollClaim = (t: T, ownerId = OWNER) =>
  t.mutation(internal.listingDrain.claimDrain, { ownerId, platform: "bsc", leaseToken: "lease-poll" });

// ── The schedule ────────────────────────────────────────────────────────────

describe("the schedule", () => {
  test("the numbers: 30, 60, 120 then 300 s; ten tries; stale at 60 min; a 6 h cooldown; a 20 s wait for BSC", () => {
    expect([...BSC_SELLER_ID_FETCH_DELAYS_MS]).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(BSC_SELLER_ID_FETCH_MAX_ATTEMPTS).toBe(10);
    expect(BSC_SELLER_ID_FETCH_STALE_MS).toBe(60 * 60_000);
    expect(BSC_SELLER_ID_FETCH_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
    expect(BSC_SELLER_ID_FETCH_TIMEOUT_MS).toBe(20_000);
  });

  test.each([
    [1, 60_000],
    [2, 120_000],
    [3, 300_000],
    [4, 300_000],
    [9, 300_000],
    [100, 300_000],
  ])("after read %i fails the next waits %i ms (the last delay repeats)", (attempt, ms) => {
    expect(bscSellerIdFetchDelayAfter(attempt)).toBe(ms);
  });

  test("a chain that gives up has waited about 39 minutes, and a live chain is never doubled by the stale bound", () => {
    // first 30 s, then the nine waits between ten reads
    let total = BSC_SELLER_ID_FETCH_DELAYS_MS[0];
    for (let attempt = 1; attempt < BSC_SELLER_ID_FETCH_MAX_ATTEMPTS; attempt++) total += bscSellerIdFetchDelayAfter(attempt);
    expect(total).toBe(30_000 + 60_000 + 120_000 + 7 * 300_000);
    expect(total / 60_000).toBeCloseTo(38.5, 1);
    // Ten reads at the 20 s cap on top of the waits still sit inside the stale bound.
    expect(total + BSC_SELLER_ID_FETCH_MAX_ATTEMPTS * BSC_SELLER_ID_FETCH_TIMEOUT_MS).toBeLessThan(BSC_SELLER_ID_FETCH_STALE_MS);
  });

  test("scheduleNext waits the delay for the read that just failed, and numbers the next read", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "chain-1");
    const seen: Array<[number, number, number]> = [];
    for (const attempt of [1, 2, 3, 4, 9]) {
      const { result, from, to } = await around(() =>
        t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt }),
      );
      expect(result).toBe("scheduled");
      const job = (await ticks(t)).find((j) => j.args.attempt === attempt + 1)!;
      expect(job.args).toEqual({ ownerId: OWNER, token: "chain-1", attempt: attempt + 1 });
      expect(job.scheduledTime).toBeGreaterThanOrEqual(from + bscSellerIdFetchDelayAfter(attempt));
      expect(job.scheduledTime).toBeLessThanOrEqual(to + bscSellerIdFetchDelayAfter(attempt));
      seen.push([attempt, attempt + 1, bscSellerIdFetchDelayAfter(attempt)]);
    }
    expect(seen.map((s) => s[2])).toEqual([60_000, 120_000, 300_000, 300_000, 300_000]);
    await cancelScheduled(t);
  });

  test("the tenth failed read gives up: the field is KEPT, ended gaveUp, nothing is scheduled", async () => {
    const t = convexTest(schema, modules);
    const startedAt = Date.now() - 39 * 60_000;
    await seedChain(t, "chain-1", startedAt);

    const { result, from, to } = await around(() =>
      t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt: 10 }),
    );

    expect(result).toBe("gaveUp");
    const chain = (await stateOf(t))?.sellerIdFetch;
    expect(chain).toMatchObject({ token: "chain-1", startedAt, endReason: "gaveUp" });
    expect(chain?.endedAt).toBeGreaterThanOrEqual(from);
    expect(chain?.endedAt).toBeLessThanOrEqual(to);
    expect(await ticks(t)).toEqual([]);
  });

  test("an ended chain's late scheduleNext is stale: it neither reschedules nor re-ends", async () => {
    const t = convexTest(schema, modules);
    await seedEndedChain(t, "gaveUp", 60_000, "chain-1");
    const before = await stateOf(t);

    expect(await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt: 4 })).toBe("stale");
    expect(await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt: 10 })).toBe("stale");

    expect(await stateOf(t)).toEqual(before);
    expect(await ticks(t)).toEqual([]);
  });

  test("the give-up logs the attempt and no owner, token or id", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "chain-1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt: 10 });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      JSON.stringify({
        msg: "bsc_seller_id_fetch",
        platform: "bsc",
        operation: "tick",
        outcome: "gave_up",
        attempt: 10,
        endReason: "gaveUp",
      }),
    ]);
  });
});

// ── Re-arming after a chain ended (the NEO-483 audit) ───────────────────────

describe("an ended chain is not re-armed by renewals or the poll, only by the collector", () => {
  /** Gives up a running chain through the real path (scheduleNext at the last attempt). */
  async function giveUp(t: T) {
    await seedProfile(t);
    await seedChain(t, "chain-1", Date.now() - 39 * 60_000);
    expect(await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "chain-1", attempt: 10 })).toBe("gaveUp");
    return (await stateOf(t))!.sellerIdFetch!;
  }

  test("give up, then the poll's drain claim: awaitingSeller, coolingDown, no new chain, no read scheduled", async () => {
    const t = convexTest(schema, modules);
    const ended = await giveUp(t);
    await queueOne(t);

    // Four polls, an hour of them.
    for (let i = 0; i < 4; i++) {
      expect(await pollClaim(t)).toEqual({ claimed: false, reason: "awaitingSeller" });
    }

    expect((await stateOf(t))?.sellerIdFetch).toEqual(ended);
    expect(await ticks(t)).toEqual([]);
  });

  test("give up, then a token renewal (ensureFetch with no userAction, as runSiteLogin arms it): coolingDown", async () => {
    const t = convexTest(schema, modules);
    const ended = await giveUp(t);

    expect(await ensure(t)).toBe("coolingDown");
    expect(await ensure(t, 0)).toBe("coolingDown");

    expect((await stateOf(t))?.sellerIdFetch).toEqual(ended);
    expect(await ticks(t)).toEqual([]);
  });

  test("give up, then a user action: a new chain starts at once, with a new token", async () => {
    const t = convexTest(schema, modules);
    await giveUp(t);

    const { result, from, to } = await around(() => ensureByUser(t, 0));

    expect(result).toBe("started");
    const chain = (await stateOf(t))?.sellerIdFetch;
    expect(chain?.token).not.toBe("chain-1");
    expect(chain?.endedAt).toBeUndefined();
    expect(chain?.endReason).toBeUndefined();
    expect(chain?.startedAt).toBeGreaterThanOrEqual(from);
    expect(chain?.startedAt).toBeLessThanOrEqual(to);
    const [job] = await ticks(t);
    expect(job.args).toEqual({ ownerId: OWNER, token: chain?.token, attempt: 1 });
    // The new chain reads; the ended one's token stands down.
    expect(await t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token: chain!.token })).toBe("go");
    expect(await t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token: "chain-1" })).toBe("stale");
    await cancelScheduled(t);
  });

  test("a user action never doubles a RUNNING chain: inFlight", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await ensure(t);
    const before = await stateOf(t);

    expect(await ensureByUser(t, 0)).toBe("inFlight");

    expect(await stateOf(t)).toEqual(before);
    expect(await ticks(t)).toHaveLength(1);
    await cancelScheduled(t);
  });

  test.each<["gaveUp" | "noSellerProfile"]>([["gaveUp"], ["noSellerProfile"]])(
    "%s: cooling down just inside 6 h, re-armed by a renewal or the poll once it has passed",
    async (reason) => {
      const t = convexTest(schema, modules);
      await seedProfile(t);
      await seedEndedChain(t, reason, BSC_SELLER_ID_FETCH_COOLDOWN_MS - 60_000);
      expect(await ensure(t)).toBe("coolingDown");
      expect(await ticks(t)).toEqual([]);

      await t.run(async (ctx) => {
        const row = (await ctx.db
          .query("marketplaceListingStates")
          .withIndex("by_owner_platform", (q) => q.eq("ownerId", OWNER).eq("platform", "bsc"))
          .first())!;
        const endedAt = Date.now() - BSC_SELLER_ID_FETCH_COOLDOWN_MS - 1;
        await ctx.db.patch(row._id, { sellerIdFetch: { ...row.sellerIdFetch!, endedAt } });
      });

      expect(await pollClaim(t)).toEqual({ claimed: false, reason: "awaitingSeller" });
      const chain = (await stateOf(t))?.sellerIdFetch;
      expect(chain?.token).not.toBe("ended-1");
      expect(chain?.endedAt).toBeUndefined();
      expect((await ticks(t))[0].args.attempt).toBe(1);
      await cancelScheduled(t);
    },
  );

  test("an ended chain is not stale by age: a renewal 2 h after a chain STARTED still cools down", async () => {
    const t = convexTest(schema, modules);
    const endedAt = Date.now() - 60 * 60_000;
    await seedState(t, {
      fetch: { token: "ended-1", startedAt: endedAt - 60 * 60_000, endedAt, endReason: "gaveUp" },
    });

    expect(await ensure(t, 0)).toBe("coolingDown");
    expect(await ticks(t)).toEqual([]);
  });

  test("the cooling-down line carries the reason and no owner or token", async () => {
    const t = convexTest(schema, modules);
    await seedEndedChain(t, "noSellerProfile");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await ensure(t);

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      JSON.stringify({
        msg: "bsc_seller_id_fetch",
        platform: "bsc",
        operation: "ensure",
        outcome: "cooling_down",
        endReason: "noSellerProfile",
      }),
    ]);
    for (const l of lines) expect(l).not.toMatch(/ended-1|collector_sellerid/);
  });

  test("an account that lands after the chain ended clears the ended chain and kicks the drain", async () => {
    const t = convexTest(schema, modules);
    await seedEndedChain(t, "gaveUp");
    await queueOne(t);

    await t.mutation(internal.userProfile.setMarketplaceAccountIdInternal, {
      userId: OWNER,
      site: "buysportscards",
      accountId: SELLER,
    });

    const row = await stateOf(t);
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(row?.platformAccountId).toBe(SELLER);
    expect(await drainRuns(t)).toHaveLength(1);
    await cancelScheduled(t);
  });

  test("tickState: an ended chain's own token is stale, so a late tick never reads", async () => {
    const t = convexTest(schema, modules);
    await seedEndedChain(t, "gaveUp", 60_000, "chain-1");

    expect(await t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token: "chain-1" })).toBe("stale");
  });

  test("stopChain leaves an ended chain alone (only the cooldown or a user action replaces it)", async () => {
    const t = convexTest(schema, modules);
    await seedEndedChain(t, "noSellerProfile", 60_000, "chain-1");
    const before = await stateOf(t);

    await t.mutation(internal.bscSellerId.stopChain, { ownerId: OWNER, token: "chain-1" });

    expect(await stateOf(t)).toEqual(before);
  });
});

// ── ensure ──────────────────────────────────────────────────────────────────

describe("ensureFetch", () => {
  test("starts a chain: stamps the field, schedules read 1 at the first delay", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);

    const { result, from, to } = await around(() => ensure(t));

    expect(result).toBe("started");
    const row = await stateOf(t);
    expect(row?.sellerIdFetch?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.sellerIdFetch?.startedAt).toBeGreaterThanOrEqual(from);
    expect(row?.sellerIdFetch?.startedAt).toBeLessThanOrEqual(to);
    const [job] = await ticks(t);
    expect(job.args).toEqual({ ownerId: OWNER, token: row?.sellerIdFetch?.token, attempt: 1 });
    expect(job.scheduledTime).toBeGreaterThanOrEqual(from + 30_000);
    expect(job.scheduledTime).toBeLessThanOrEqual(to + 30_000);
    await cancelScheduled(t);
  });

  test.each([
    [0, 0],
    [5_000, 5_000],
    [-100, 0],
  ])("firstDelayMs %i schedules the first read %i ms out", async (given, expected) => {
    const t = convexTest(schema, modules);
    await seedState(t);

    const { result, from, to } = await around(() => ensure(t, given));

    expect(result).toBe("started");
    const [job] = await ticks(t);
    expect(job.scheduledTime).toBeGreaterThanOrEqual(from + expected);
    expect(job.scheduledTime).toBeLessThanOrEqual(to + expected);
    await cancelScheduled(t);
  });

  test("a second ensure while a chain runs is inFlight: nothing written, nothing scheduled", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await ensure(t);
    const before = await stateOf(t);

    expect(await ensure(t, 0)).toBe("inFlight");

    expect(await stateOf(t)).toEqual(before);
    expect(await ticks(t)).toHaveLength(1);
    await cancelScheduled(t);
  });

  test("two ensures racing start exactly one chain", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);

    const [a, b] = await Promise.all([ensure(t), ensure(t, 0)]);

    expect([a, b].sort()).toEqual(["inFlight", "started"]);
    expect(await ticks(t)).toHaveLength(1);
    const row = await stateOf(t);
    expect((await ticks(t))[0].args.token).toBe(row?.sellerIdFetch?.token);
    await cancelScheduled(t);
  });

  test("a chain just under 60 minutes old is still in flight", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "old", Date.now() - BSC_SELLER_ID_FETCH_STALE_MS + 60_000);

    expect(await ensure(t)).toBe("inFlight");
    expect((await stateOf(t))?.sellerIdFetch?.token).toBe("old");
    expect(await ticks(t)).toEqual([]);
  });

  test("a chain 60 minutes old is stale and replaced: a new token, and the old tick then stands down", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "old", Date.now() - BSC_SELLER_ID_FETCH_STALE_MS - 1);

    expect(await ensure(t)).toBe("started");

    const row = await stateOf(t);
    expect(row?.sellerIdFetch?.token).not.toBe("old");
    expect(row?.sellerIdFetch?.startedAt).toBeGreaterThan(Date.now() - 60_000);
    // The old chain's tick no longer owns the row.
    expect(await t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token: "old" })).toBe("stale");
    expect(await t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token: row!.sellerIdFetch!.token })).toBe("go");
    await cancelScheduled(t);
  });

  test("a stale chain's own next tick cannot reschedule over its replacement", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "old", Date.now() - BSC_SELLER_ID_FETCH_STALE_MS - 1);
    await ensure(t);
    const before = await ticks(t);

    expect(await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token: "old", attempt: 3 })).toBe("stale");

    expect(await ticks(t)).toEqual(before);
    await cancelScheduled(t);
  });

  test("known: the profile already holds an account, so nothing starts", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await seedProfile(t, "seller-known");

    expect(await ensure(t)).toBe("known");

    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(t)).toEqual([]);
  });

  test("a profile that exists with no account does not count as known", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await seedProfile(t);

    expect(await ensure(t)).toBe("started");
    await cancelScheduled(t);
  });

  test.each<[string, StateOpts | null]>([
    ["no listing state row", null],
    ["listing not started", { listing: false }],
    ["dormant: no credentials", { dormant: "noCredentials" }],
    ["dormant: seller conflict", { dormant: "sellerConflict" }],
    ["the E2E test marker", { testListingOff: true }],
  ])("%s: notListing, nothing written, nothing scheduled", async (_name, opts) => {
    const t = convexTest(schema, modules);
    if (opts) await seedState(t, opts);
    const before = await stateOf(t);

    expect(await ensure(t, 0)).toBe("notListing");

    expect(await stateOf(t)).toEqual(before);
    expect(await ticks(t)).toEqual([]);
  });

  test("BSC paused for everyone: notListing, nothing scheduled", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
    const t = convexTest(schema, modules);
    await seedState(t);

    expect(await ensure(t, 0)).toBe("notListing");

    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(t)).toEqual([]);
  });

  test("SportLots paused does not stop it", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "sportlots");
    const t = convexTest(schema, modules);
    await seedState(t);

    expect(await ensure(t)).toBe("started");
    await cancelScheduled(t);
  });

  test("another owner's row is never touched", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await seedState(t, {}, OTHER);

    await ensure(t);

    expect((await stateOf(t, OTHER))?.sellerIdFetch).toBeUndefined();
    await cancelScheduled(t);
  });
});

// ── tickState and stopChain ─────────────────────────────────────────────────

describe("tickState: what a tick may do before BSC is contacted", () => {
  const state = (t: T, token = "chain-1") => t.query(internal.bscSellerId.tickState, { ownerId: OWNER, token });

  test("go: the chain owns the row, the owner lists, no account is stored", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    expect(await state(t)).toBe("go");
  });

  test("stale: the row is gone", async () => {
    const t = convexTest(schema, modules);
    expect(await state(t)).toBe("stale");
  });

  test("stale: a row with no chain", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    expect(await state(t)).toBe("stale");
  });

  test("stale: another chain's token (a token that never matches)", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "someone-else");
    expect(await state(t, "chain-1")).toBe("stale");
  });

  test("stale wins over stop: a token mismatch on a row that also stopped listing is still stale", async () => {
    const t = convexTest(schema, modules);
    await seedState(t, { listing: false, fetch: { token: "someone-else", startedAt: Date.now() } });
    expect(await state(t, "chain-1")).toBe("stale");
  });

  test.each<[string, StateOpts]>([
    ["the owner stopped listing", { listing: false }],
    ["the row went dormant", { dormant: "noCredentials" }],
    ["the test marker is on", { testListingOff: true }],
  ])("stop: %s", async (_name, opts) => {
    const t = convexTest(schema, modules);
    await seedState(t, { ...opts, fetch: { token: "chain-1", startedAt: Date.now() } });
    expect(await state(t)).toBe("stop");
  });

  test("stop: BSC is paused", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
    const t = convexTest(schema, modules);
    await seedChain(t);
    expect(await state(t)).toBe("stop");
  });

  test("stop: an account is already stored", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await seedProfile(t, "seller-known");
    expect(await state(t)).toBe("stop");
  });
});

describe("stopChain", () => {
  test("clears the field when the token matches", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await t.mutation(internal.bscSellerId.stopChain, { ownerId: OWNER, token: "chain-1" });
    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
  });

  test("leaves another chain's field alone", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "chain-2");
    await t.mutation(internal.bscSellerId.stopChain, { ownerId: OWNER, token: "chain-1" });
    expect((await stateOf(t))?.sellerIdFetch?.token).toBe("chain-2");
  });

  test("a row that is gone is not an error", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.bscSellerId.stopChain, { ownerId: OWNER, token: "chain-1" })).resolves.toBeNull();
  });
});

// ── Landing: setMarketplaceAccountIdInternal -> landBscSellerId ─────────────

describe("an account lands (setMarketplaceAccountIdInternal -> landBscSellerId)", () => {
  const land = (t: T, accountId = SELLER, ownerId = OWNER) =>
    t.mutation(internal.userProfile.setMarketplaceAccountIdInternal, { userId: ownerId, site: "buysportscards", accountId });

  test("a waiting chain: the account is stamped, the chain cleared, the drain kicked", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await queueOne(t);

    await land(t);

    const row = await stateOf(t);
    expect(row?.platformAccountId).toBe(SELLER);
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(row?.dormant).toBeUndefined();
    expect(await profileId(t)).toBe(SELLER);
    expect(await drainRuns(t)).toHaveLength(1);
    expect(row?.drainScheduledAt).toBeTypeOf("number");
    await cancelScheduled(t);
  });

  test("an account from a sign-in with no chain waiting is stamped and kicks the drain too", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await queueOne(t);

    await land(t);

    expect((await stateOf(t))?.platformAccountId).toBe(SELLER);
    expect(await drainRuns(t)).toHaveLength(1);
    await cancelScheduled(t);
  });

  test("the same account again with no chain waiting changes nothing and kicks nothing", async () => {
    const t = convexTest(schema, modules);
    await seedState(t, { platformAccountId: SELLER, lastUpdated: 123 });
    await queueOne(t);

    await land(t);

    const row = await stateOf(t);
    expect(row?.lastUpdated).toBe(123);
    expect(await drainRuns(t)).toEqual([]);
  });

  test("the same account with a chain waiting still clears the chain and kicks", async () => {
    const t = convexTest(schema, modules);
    await seedState(t, { platformAccountId: SELLER, fetch: { token: "chain-1", startedAt: Date.now() } });
    await queueOne(t);

    await land(t);

    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
    expect(await drainRuns(t)).toHaveLength(1);
    await cancelScheduled(t);
  });

  test("a different account replaces the stamped one", async () => {
    const t = convexTest(schema, modules);
    await seedState(t, { platformAccountId: "seller-old" });

    await land(t);

    expect((await stateOf(t))?.platformAccountId).toBe(SELLER);
    await cancelScheduled(t);
  });

  test("another listing owner holds the account: dormant sellerConflict, not stamped, no kick, chain cleared", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await queueOne(t);
    await seedState(t, { platformAccountId: SELLER }, OTHER);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await land(t);

    const row = await stateOf(t);
    expect(row?.dormant).toBe("sellerConflict");
    expect(row?.platformAccountId).toBeUndefined();
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(await drainRuns(t)).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      JSON.stringify({ msg: "listing_seller_conflict", platform: "bsc", operation: "landBscSellerId" }),
    ]);
    // The account is still the profile's own: NB stores what BSC named.
    expect(await profileId(t)).toBe(SELLER);
    // The other owner is untouched.
    expect((await stateOf(t, OTHER))?.dormant).toBeUndefined();
  });

  test("a holder that no longer lists holds nothing", async () => {
    const t = convexTest(schema, modules);
    await seedState(t);
    await seedState(t, { platformAccountId: SELLER, listing: false }, OTHER);

    await land(t);

    const row = await stateOf(t);
    expect(row?.dormant).toBeUndefined();
    expect(row?.platformAccountId).toBe(SELLER);
    await cancelScheduled(t);
  });

  test("an owner who is not listing: only the chain is cleared, nothing stamped, nothing kicked", async () => {
    const t = convexTest(schema, modules);
    await seedState(t, { listing: false, fetch: { token: "chain-1", startedAt: Date.now() } });
    await queueOne(t);

    await land(t);

    const row = await stateOf(t);
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(row?.platformAccountId).toBeUndefined();
    expect(await drainRuns(t)).toEqual([]);
    expect(await profileId(t)).toBe(SELLER);
  });

  test("an owner with no listing row: the account is stored and nothing else happens", async () => {
    const t = convexTest(schema, modules);

    await land(t);

    expect(await profileId(t)).toBe(SELLER);
    expect(await stateOf(t)).toBeNull();
    expect(await drainRuns(t)).toEqual([]);
  });

  test("an eBay account does not touch the BSC chain", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);

    await t.mutation(internal.userProfile.setMarketplaceAccountIdInternal, { userId: OWNER, site: "ebay", accountId: "ebay.user-1" });

    expect((await stateOf(t))?.sellerIdFetch?.token).toBe("chain-1");
  });

  test("a tick scheduled before the landing stands down on it: no token read, no BSC call", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(() => {
      throw new Error("a landed chain must not ask BSC");
    });
    await land(t);

    await t.action(internal.bscSellerId.fetchTick, { ownerId: OWNER, token: "chain-1", attempt: 4 });

    expect(asked.n).toBe(0);
    expect(creds.tokenCalls).toBe(0);
    await cancelScheduled(t);
  });
});

// ── fetchTick ───────────────────────────────────────────────────────────────

/** Stubs `fetch`: every BSC request goes to `answer`, counted. */
function stubBsc(answer: (n: number, init?: RequestInit) => Response | Promise<Response>) {
  const asked = { n: 0, urls: [] as string[], timeouts: [] as number[] };
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    asked.timeouts.push(ms);
    return realTimeout(ms);
  });
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    asked.n += 1;
    asked.urls.push(String(url));
    return await answer(asked.n, init);
  }) as typeof fetch);
  return asked;
}

const profileOk = (sellerId: string | null = SELLER) =>
  Response.json({ sellerProfile: sellerId === null ? {} : { sellerId } });

describe("fetchTick", () => {
  const tick = (t: T, attempt = 1, token = "chain-1") =>
    t.action(internal.bscSellerId.fetchTick, { ownerId: OWNER, token, attempt });

  /** The next read the chain scheduled, or undefined. */
  const nextTick = async (t: T) => (await ticks(t))[0];

  test("an id lands: the profile and the row hold it, the chain is gone, the drain is kicked", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await queueOne(t);
    const asked = stubBsc(() => profileOk());

    await tick(t);

    expect(asked.n).toBe(1);
    expect(asked.urls[0]).toBe("https://api-prod.buysportscards.com/marketplace/user/profile");
    expect(await profileId(t)).toBe(SELLER);
    const row = await stateOf(t);
    expect(row?.platformAccountId).toBe(SELLER);
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(await drainRuns(t)).toHaveLength(1);
    expect(await ticks(t)).toEqual([]);
    await cancelScheduled(t);
  });

  test("the read is a single 20 s attempt, not the drain's two 5 s ones", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(() => profileOk());

    await tick(t);

    expect(asked.timeouts).toEqual([20_000]);
    await cancelScheduled(t);
  });

  test("a fetch that never answers: the 20 s limit ends it, one request, the next read is scheduled", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    // Same stub, but the limit is shortened so the test does not wait 20 s.
    const asked = { n: 0, limits: [] as number[] };
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.limits.push(ms);
      return realTimeout(25);
    });
    vi.stubGlobal("fetch", ((_url: string, init?: RequestInit) => {
      asked.n += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch);

    const { from, to } = await around(() => tick(t, 1));

    expect(asked.n).toBe(1);
    expect(asked.limits).toEqual([BSC_SELLER_ID_FETCH_TIMEOUT_MS]);
    const next = await nextTick(t);
    expect(next.args).toEqual({ ownerId: OWNER, token: "chain-1", attempt: 2 });
    expect(next.scheduledTime).toBeGreaterThanOrEqual(from + 60_000);
    expect(next.scheduledTime).toBeLessThanOrEqual(to + 60_000);
    expect((await stateOf(t))?.sellerIdFetch?.token).toBe("chain-1");
    expect(await profileId(t)).toBeNull();
    await cancelScheduled(t);
  });

  test("a 429 waits for the next tick: exactly one request, no immediate retry", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(() => new Response("slow down", { status: 429 }));

    const { from, to } = await around(() => tick(t, 2));

    expect(asked.n).toBe(1);
    const next = await nextTick(t);
    expect(next.args.attempt).toBe(3);
    expect(next.scheduledTime).toBeGreaterThanOrEqual(from + 120_000);
    expect(next.scheduledTime).toBeLessThanOrEqual(to + 120_000);
    expect((await stateOf(t))?.sellerIdFetch?.token).toBe("chain-1");
    await cancelScheduled(t);
  });

  test.each<[string, () => Response | Promise<Response>]>([
    ["a 503", () => new Response("busy", { status: 503 })],
    ["a 500", () => new Response("oops", { status: 500 })],
    ["a 404", () => new Response("nope", { status: 404 })],
    ["an unreadable body", () => new Response("<html>not json</html>", { status: 200 })],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s: one request, then the next read is scheduled", async (_name, answer) => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(answer);

    await tick(t);

    expect(asked.n).toBe(1);
    expect((await nextTick(t)).args.attempt).toBe(2);
    await cancelScheduled(t);
  });

  test.each<[string, () => Response]>([
    ["a seller profile with no id", () => profileOk(null)],
    ["no seller profile at all", () => Response.json({ userName: "someone" })],
  ])("a 2xx with %s is terminal: ended noSellerProfile, nothing scheduled, no further reads", async (_name, answer) => {
    const t = convexTest(schema, modules);
    await seedProfile(t);
    await seedChain(t);
    await queueOne(t);
    const asked = stubBsc(answer);

    const { from, to } = await around(() => tick(t, 3));

    expect(asked.n).toBe(1);
    expect(await profileId(t)).toBeNull();
    const chain = (await stateOf(t))?.sellerIdFetch;
    expect(chain).toMatchObject({ token: "chain-1", endReason: "noSellerProfile" });
    expect(chain?.endedAt).toBeGreaterThanOrEqual(from);
    expect(chain?.endedAt).toBeLessThanOrEqual(to);
    expect(await ticks(t)).toEqual([]);

    // A late tick of the same chain, a renewal and the poll's claim: still no BSC call.
    await tick(t, 4);
    expect(await ensure(t)).toBe("coolingDown");
    expect(await pollClaim(t)).toEqual({ claimed: false, reason: "awaitingSeller" });
    expect(asked.n).toBe(1);
    expect(await ticks(t)).toEqual([]);
    expect((await stateOf(t))?.sellerIdFetch).toEqual(chain);
  });

  test("an id with characters outside the stored shape is not stored (and BSC has answered: terminal)", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    stubBsc(() => profileOk("has spaces"));

    await tick(t);

    expect(await profileId(t)).toBeNull();
    expect((await stateOf(t))?.platformAccountId).toBeUndefined();
    expect((await stateOf(t))?.sellerIdFetch?.endReason).toBe("noSellerProfile");
    expect(await ticks(t)).toEqual([]);
  });

  test("gives up after ten tries: the tenth failed read ends the chain (gaveUp, field kept) and schedules nothing", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    stubBsc(() => new Response("", { status: 503 }));

    await tick(t, 9);
    expect((await nextTick(t)).args.attempt).toBe(10);
    await cancelScheduled(t);
    await tick(t, 10);

    expect((await stateOf(t))?.sellerIdFetch).toMatchObject({ token: "chain-1", endReason: "gaveUp" });
    expect(await ticks(t)).toEqual([]);
  });

  test("the whole chain: ten failing reads, then nothing, and the owner's wait totals the schedule", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(() => new Response("", { status: 429 }));
    const waits: number[] = [];

    for (let attempt = 1; attempt <= BSC_SELLER_ID_FETCH_MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      await tick(t, attempt);
      const next = await nextTick(t);
      if (next) waits.push(Math.round((next.scheduledTime - before) / 1000) * 1000);
      await cancelScheduled(t);
    }

    expect(asked.n).toBe(10);
    // The first wait (30 s) belongs to ensure; these are the nine between reads.
    expect(waits).toEqual([60_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
    expect((await stateOf(t))?.sellerIdFetch?.endReason).toBe("gaveUp");
  });

  test("signed out (a 401 refused again after the one refresh): the chain stops, nothing is scheduled", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    const asked = stubBsc(() => new Response("", { status: 401 }));

    await tick(t);

    expect(asked.n).toBe(2);
    expect(creds.refreshCalls).toBe(1);
    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(t)).toEqual([]);
  });

  test("no token to read: the chain stops without asking BSC", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    creds.token = null;
    const asked = stubBsc(() => profileOk());

    await tick(t);

    expect(asked.n).toBe(0);
    expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(t)).toEqual([]);
  });

  test("a seller conflict found at landing: dormant sellerConflict, no drain, no further read", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    await queueOne(t);
    await seedState(t, { platformAccountId: SELLER }, OTHER);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubBsc(() => profileOk());

    await tick(t);

    const row = await stateOf(t);
    expect(row?.dormant).toBe("sellerConflict");
    expect(row?.sellerIdFetch).toBeUndefined();
    expect(row?.platformAccountId).toBeUndefined();
    expect(await drainRuns(t)).toEqual([]);
    expect(await ticks(t)).toEqual([]);
  });

  describe("no BSC call is made when the chain has nothing left to do", () => {
    const quiet = () =>
      stubBsc(() => {
        throw new Error("BSC must not be called");
      });

    test("the row is gone", async () => {
      const t = convexTest(schema, modules);
      const asked = quiet();
      await tick(t);
      expect(asked.n).toBe(0);
      expect(creds.tokenCalls).toBe(0);
    });

    test("a token that never matches: the row and its chain are untouched", async () => {
      const t = convexTest(schema, modules);
      await seedChain(t, "someone-else");
      const before = await stateOf(t);
      const asked = quiet();

      for (const attempt of [1, 5, 10]) await tick(t, attempt, "chain-1");

      expect(asked.n).toBe(0);
      expect(creds.tokenCalls).toBe(0);
      expect(await stateOf(t)).toEqual(before);
      expect(await ticks(t)).toEqual([]);
    });

    test("the owner stopped listing: the chain is cleared", async () => {
      const t = convexTest(schema, modules);
      await seedState(t, { listing: false, fetch: { token: "chain-1", startedAt: Date.now() } });
      const asked = quiet();

      await tick(t);

      expect(asked.n).toBe(0);
      expect(creds.tokenCalls).toBe(0);
      expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
      expect(await ticks(t)).toEqual([]);
    });

    test("BSC is paused: the chain is cleared", async () => {
      vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
      const t = convexTest(schema, modules);
      await seedChain(t);
      const asked = quiet();

      await tick(t);

      expect(asked.n).toBe(0);
      expect(creds.tokenCalls).toBe(0);
      expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
      expect(await ticks(t)).toEqual([]);
    });

    test("a pause that starts mid-chain stops the next tick", async () => {
      const t = convexTest(schema, modules);
      await seedChain(t);
      const asked = stubBsc(() => new Response("", { status: 429 }));
      await tick(t, 1);
      expect(asked.n).toBe(1);
      await cancelScheduled(t);

      vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "buysportscards");
      await tick(t, 2);

      expect(asked.n).toBe(1);
      expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
      expect(await ticks(t)).toEqual([]);
    });

    test("an account is already stored: the chain is cleared", async () => {
      const t = convexTest(schema, modules);
      await seedChain(t);
      await seedProfile(t, "seller-known");
      const asked = quiet();

      await tick(t);

      expect(asked.n).toBe(0);
      expect(creds.tokenCalls).toBe(0);
      expect((await stateOf(t))?.sellerIdFetch).toBeUndefined();
      expect(await profileId(t)).toBe("seller-known");
      expect(await ticks(t)).toEqual([]);
    });

    test("a second tick of a chain that already landed", async () => {
      const t = convexTest(schema, modules);
      await seedChain(t);
      const asked = stubBsc(() => profileOk());
      await tick(t, 1);
      expect(asked.n).toBe(1);
      await cancelScheduled(t);

      await tick(t, 2);

      expect(asked.n).toBe(1);
      expect(await ticks(t)).toEqual([]);
    });
  });

  test("a replaced chain's late tick does not read, and does not cut short the new chain", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t, "old", Date.now() - BSC_SELLER_ID_FETCH_STALE_MS - 1);
    await ensure(t);
    const token = (await stateOf(t))!.sellerIdFetch!.token;
    await cancelScheduled(t);
    const asked = stubBsc(() => profileOk());

    await tick(t, 3, "old");

    expect(asked.n).toBe(0);
    expect((await stateOf(t))?.sellerIdFetch?.token).toBe(token);
  });

  test("a tick scheduled by one chain keeps its number across scheduleNext: attempt N reads, N+1 follows", async () => {
    const t = convexTest(schema, modules);
    await seedChain(t);
    stubBsc(() => new Response("", { status: 503 }));

    await tick(t, 3);

    expect((await nextTick(t)).args).toEqual({ ownerId: OWNER, token: "chain-1", attempt: 4 });
    await cancelScheduled(t);
  });

  describe("logs never carry the id, a token or the owner", () => {
    function capture() {
      const all: string[] = [];
      for (const level of ["log", "warn", "error", "info"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void all.push(args.map(String).join(" ")));
      }
      return all;
    }
    const FORBIDDEN = [SELLER, "LEAKCANARY", OWNER, "chain-1", "Bearer"];

    test.each<[string, () => Response]>([
      ["a landing", () => profileOk()],
      ["a 429", () => new Response("", { status: 429 })],
      ["a 503", () => new Response("", { status: 503 })],
      ["a 401", () => new Response("", { status: 401 })],
      ["no id in the answer", () => profileOk(null)],
    ])("%s", async (_name, answer) => {
      const t = convexTest(schema, modules);
      await seedChain(t);
      stubBsc(answer);
      const lines = capture();

      await tick(t);

      expect(lines.some((l) => l.includes("bsc_seller_id_fetch"))).toBe(true);
      for (const line of lines) for (const f of FORBIDDEN) expect(line).not.toContain(f);
      await cancelScheduled(t);
    });

    test("a seller conflict at landing", async () => {
      const t = convexTest(schema, modules);
      await seedChain(t);
      await seedState(t, { platformAccountId: SELLER }, OTHER);
      stubBsc(() => profileOk());
      const lines = capture();

      await tick(t);

      expect(lines.some((l) => l.includes("listing_seller_conflict"))).toBe(true);
      for (const line of lines) for (const f of FORBIDDEN) expect(line).not.toContain(f);
    });

    test("the ensure and give-up lines", async () => {
      const t = convexTest(schema, modules);
      await seedState(t);
      const lines = capture();

      await ensure(t);
      const token = (await stateOf(t))!.sellerIdFetch!.token;
      await t.mutation(internal.bscSellerId.scheduleNext, { ownerId: OWNER, token, attempt: 10 });

      expect(lines.filter((l) => l.includes("bsc_seller_id_fetch"))).toHaveLength(2);
      for (const line of lines) {
        for (const f of [...FORBIDDEN, token]) expect(line).not.toContain(f);
      }
      await cancelScheduled(t);
    });
  });

  test("the public surface: nothing here is a public function", () => {
    // The module exports only internal functions, so convex/publicFunctionAuth*.test.ts has no entry to add.
    for (const ref of [
      internal.bscSellerId.ensureFetch,
      internal.bscSellerId.tickState,
      internal.bscSellerId.stopChain,
      internal.bscSellerId.endChainNoSellerProfile,
      internal.bscSellerId.scheduleNext,
      internal.bscSellerId.fetchTick,
    ]) {
      expect(getFunctionName(ref)).toMatch(/^bscSellerId:/);
    }
  });
});
