/**
 * NEO-370 — the listing hook (`listingOutbox.enqueueListingCards`, called by
 * `collection.applyCopyChanges`) and the collector's listing functions
 * (`convex/listingSync.ts`): the switch, a variant's status, Resync and Sales.
 *
 * The rules pinned here:
 *   - a write whose copy lived in a box before or after queues the card for
 *     every platform the owner lists on; a binder-only write queues nothing;
 *   - an owner who lists nowhere gets no outbox row and no drain;
 *   - a burst of writes schedules ONE drain (the debounce latch);
 *   - only catalog cards carrying the platform's id are queued;
 *   - every public function is the caller's own, and a sync record's lease
 *     token never reaches a client.
 *
 * The drain itself is scheduled a minute out and never runs here: each test
 * drains the `runAfter(0)` walks and cancels the delayed drain.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { DRAIN_SCHEDULE_STALE_MS, enqueueListingCards } from "./listingOutbox";
import { PAUSED_PLATFORMS_ENV } from "./lib/marketplacePause";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_370" };
const THEM = { subject: "collector_them_370" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const them = t.withIdentity(THEM);
  const sys = await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" })).containerId;
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "PC" })).containerId;
  return { t, fx, me, them, sys, box, binder };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Turns BSC listing on for ME the way the drainer would find it: just the state row. */
async function listOn(s: S, owner = ME.subject, extra: Record<string, unknown> = {}) {
  return s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", { ownerId: owner, platform: "bsc", lastUpdated: 0, ...extra }),
  );
}
async function connect(s: S, owner = ME.subject) {
  await s.t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: owner,
      siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
    }),
  );
}
const outbox = (s: S) => s.t.run((ctx) => ctx.db.query("listingOutbox").collect());
const states = (s: S) => s.t.run((ctx) => ctx.db.query("marketplaceListingStates").collect());
async function drains(s: S) {
  const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.name.includes("drainOwner") && r.state.kind === "pending");
}
const addTo = (s: S, cardId: Id<"cardChecklist">, homeId: Id<"collectionContainers">) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, homeId } });

let current: S | null = null;
beforeEach(() => {
  current = null;
});
afterEach(async () => {
  if (!current) return;
  await drainScheduled(current.t);
  await cancelScheduled(current.t as never);
});
async function fresh() {
  current = await setup();
  return current;
}

describe("the copy-change hook", () => {
  test("an owner who lists nowhere: a box write queues nothing and schedules no drain", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
    expect(await drains(s)).toEqual([]);
  });

  test("a box add queues the card once, for its variant, and schedules one drain", async () => {
    const s = await fresh();
    await listOn(s);
    await addTo(s, s.fx.gooden1, s.box);
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: ME.subject, platform: "bsc", cardId: s.fx.gooden1, variantId: s.fx.baseId, seq: 1 });
    expect((await states(s))[0].drainScheduledAt).toBeTypeOf("number");
    const scheduled = await drains(s);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toEqual({ ownerId: ME.subject, platform: "bsc" });
  });

  test("a burst of box writes bumps seq on one row and still schedules one drain", async () => {
    const s = await fresh();
    await listOn(s);
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.strawberry2, s.box);
    const rows = await outbox(s);
    expect(rows.map((r) => [r.cardId, r.seq]).sort()).toEqual(
      [[s.fx.gooden1, 2], [s.fx.strawberry2, 1]].sort(),
    );
    expect(await drains(s)).toHaveLength(1);
  });

  test("a stale drain stamp schedules a fresh drain", async () => {
    const s = await fresh();
    await listOn(s, ME.subject, { drainScheduledAt: Date.now() - DRAIN_SCHEDULE_STALE_MS - 1 });
    await addTo(s, s.fx.gooden1, s.box);
    expect(await drains(s)).toHaveLength(1);
  });

  test("a fresh drain stamp schedules nothing more", async () => {
    const s = await fresh();
    await listOn(s, ME.subject, { drainScheduledAt: Date.now() });
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toHaveLength(1);
    expect(await drains(s)).toEqual([]);
  });

  test("binder-only writes queue nothing: add, edit, move between binders, remove", async () => {
    const s = await fresh();
    await listOn(s);
    const { copyId } = await addTo(s, s.fx.gooden1, s.binder);
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2 });
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 2 } });
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.sys.mainId });
    await s.me.mutation(api.collection.removeCopy, { copyId });
    expect(await outbox(s)).toEqual([]);
    expect(await drains(s)).toEqual([]);
  });

  test("a move into a box and back out each queue the card", async () => {
    const s = await fresh();
    await listOn(s);
    const { copyId } = await addTo(s, s.fx.gooden1, s.binder);
    expect(await outbox(s)).toEqual([]);
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.box });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
    await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.binder });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([2]);
  });

  test("removing a box copy, editing one, and a quick count all queue the card", async () => {
    const s = await fresh();
    await listOn(s);
    const { copyId } = await addTo(s, s.fx.gooden1, s.box);
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 3, homeId: s.box } });
    await s.me.mutation(api.collection.removeCopy, { copyId });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([3]);
    await s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.strawberry2, boxId: s.sys.unsortedId, quantity: 4 });
    expect((await outbox(s)).find((r) => r.cardId === s.fx.strawberry2)?.seq).toBe(1);
  });

  test("a card with no BSC id is never queued", async () => {
    const s = await fresh();
    await listOn(s);
    await s.t.run((ctx) => ctx.db.patch(s.fx.strawberry2, { platformData: {} }));
    await addTo(s, s.fx.strawberry2, s.box);
    expect(await outbox(s)).toEqual([]);
    expect(await drains(s)).toEqual([]);
  });

  test("an id that is not a catalog card (a private card's) is skipped", async () => {
    const s = await fresh();
    await listOn(s);
    const written = await s.t.run((ctx) =>
      enqueueListingCards(ctx as never, { ownerId: ME.subject, cardIds: [s.box, s.fx.gooden1] }),
    );
    expect(written).toBe(1);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
  });

  test("another collector's listing never sees my writes", async () => {
    const s = await fresh();
    await listOn(s, THEM.subject);
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
  });
});

describe("listingSettings", () => {
  test("off and not connected by default", async () => {
    const s = await fresh();
    expect(await s.me.query(api.listingSync.listingSettings, {})).toEqual({
      bsc: { enabled: false, connected: false, needsReauth: false, paused: false },
    });
  });

  test("connected once BSC credentials are saved; on once the state row exists", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ enabled: true, connected: true });
    expect((await s.them.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ enabled: false, connected: false });
  });

  test("paused when NB pauses BuySportsCards", async () => {
    const s = await fresh();
    const before = process.env[PAUSED_PLATFORMS_ENV];
    process.env[PAUSED_PLATFORMS_ENV] = "buysportscards";
    try {
      expect((await s.me.query(api.listingSync.listingSettings, {})).bsc.paused).toBe(true);
    } finally {
      if (before === undefined) delete process.env[PAUSED_PLATFORMS_ENV];
      else process.env[PAUSED_PLATFORMS_ENV] = before;
    }
  });
});

describe("setListingEnabled", () => {
  test("refuses to switch on without saved BuySportsCards credentials", async () => {
    const s = await fresh();
    await expect(
      s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: true }),
    ).rejects.toThrow(/Connect your BuySportsCards account/);
    expect(await states(s)).toEqual([]);
  });

  test("on: makes the state row and queues every boxed card (every box), never a binder card", async () => {
    const s = await fresh();
    await connect(s);
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.gold1, s.box);
    await addTo(s, s.fx.strawberry2, s.sys.unsortedId);
    await addTo(s, s.fx.futureStar, s.binder);
    await s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: true });
    await drainScheduled(s.t);
    expect(await states(s)).toHaveLength(1);
    const rows = await outbox(s);
    expect(rows.map((r) => r.cardId).sort()).toEqual([s.fx.gooden1, s.fx.gold1, s.fx.strawberry2].sort());
    expect(rows.find((r) => r.cardId === s.fx.gold1)?.variantId).toBe(s.fx.goldId);
    expect(await drains(s)).toHaveLength(1);
  });

  test("on twice writes nothing the second time", async () => {
    const s = await fresh();
    await connect(s);
    await s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: true });
    await s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: true });
    expect(await states(s)).toHaveLength(1);
  });

  test("off: deletes the state row and my queued changes, never another collector's", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, THEM.subject);
    await s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: true });
    await addTo(s, s.fx.gooden1, s.box);
    await s.t.run((ctx) =>
      ctx.db.insert("listingOutbox", {
        ownerId: THEM.subject,
        platform: "bsc",
        cardId: s.fx.gooden1,
        variantId: s.fx.baseId,
        seq: 1,
        changedAt: 0,
      }),
    );
    await s.me.mutation(api.listingSync.setListingEnabled, { platform: "bsc", enabled: false });
    expect((await states(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    // Off, the hook queues nothing more.
    await addTo(s, s.fx.strawberry2, s.box);
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
  });

  test("a walk page that finds listing switched off again stops and queues nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await s.t.mutation(internal.listingSync.queueBoxesPage, {
      ownerId: ME.subject,
      platform: "bsc",
      boxIds: [s.box],
      index: 0,
      cursor: null,
    });
    expect(await outbox(s)).toEqual([]);
  });
});

describe("variantStatus", () => {
  test("no record and nothing queued before the first run", async () => {
    const s = await fresh();
    expect(await s.me.query(api.listingSync.variantStatus, { variantId: s.fx.baseId })).toEqual({
      record: null,
      pending: false,
    });
  });

  test("pending while one of the variant's cards is queued, and only for that variant", async () => {
    const s = await fresh();
    await listOn(s);
    await addTo(s, s.fx.gooden1, s.box);
    expect((await s.me.query(api.listingSync.variantStatus, { variantId: s.fx.baseId })).pending).toBe(true);
    expect((await s.me.query(api.listingSync.variantStatus, { variantId: s.fx.goldId })).pending).toBe(false);
    expect((await s.them.query(api.listingSync.variantStatus, { variantId: s.fx.baseId })).pending).toBe(false);
  });

  test("the record comes back without its lease token, and only to its owner", async () => {
    const s = await fresh();
    await s.t.run((ctx) =>
      ctx.db.insert("marketplaceListingSyncs", {
        ownerId: ME.subject,
        variantId: s.fx.baseId,
        platform: "bsc",
        status: "running",
        leaseToken: "secret-lease",
        leaseExpiresAt: 123,
        lastSuccessAt: 99,
        counts: { listed: 2, pushed: 1, zeroed: 0, skipped: 1 },
        problems: [{ cardId: s.fx.strawberry2, reason: "noPrice" }],
        problemsTotal: 1,
        conditionsPushed: ["near_mint"],
        lastUpdated: 1,
      }),
    );
    const mine = await s.me.query(api.listingSync.variantStatus, { variantId: s.fx.baseId });
    expect(mine.record).toEqual({
      status: "running",
      leaseExpiresAt: 123,
      lastSuccessAt: 99,
      counts: { listed: 2, pushed: 1, zeroed: 0, skipped: 1 },
      problems: [{ cardId: s.fx.strawberry2, reason: "noPrice" }],
      problemsTotal: 1,
    });
    expect(JSON.stringify(mine)).not.toContain("secret-lease");
    expect((await s.them.query(api.listingSync.variantStatus, { variantId: s.fx.baseId })).record).toBeNull();
  });
});

describe("resyncVariant", () => {
  test("while listing is off: answers 0 and writes nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    expect(await s.me.mutation(api.listingSync.resyncVariant, { variantId: s.fx.baseId })).toEqual({ queued: 0 });
    expect(await outbox(s)).toEqual([]);
  });

  test("forgets the last clean run and queues the variant's box cards only", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.strawberry2, s.binder);
    await addTo(s, s.fx.gold1, s.box);
    await listOn(s);
    const recordId = await s.t.run((ctx) =>
      ctx.db.insert("marketplaceListingSyncs", {
        ownerId: ME.subject,
        variantId: s.fx.baseId,
        platform: "bsc",
        status: "idle",
        lastSuccessAt: 500,
        problems: [],
        conditionsPushed: ["near_mint"],
        lastUpdated: 1,
      }),
    );
    expect(await s.me.mutation(api.listingSync.resyncVariant, { variantId: s.fx.baseId })).toEqual({ queued: 1 });
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    const record = await s.t.run((ctx) => ctx.db.get(recordId));
    expect(record?.lastSuccessAt).toBeUndefined();
    expect(record?.conditionsPushed).toEqual(["near_mint"]);
  });

  test("a variant with nothing in a box still queues one card so its run sets BSC to zero", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.binder);
    await listOn(s);
    expect(await s.me.mutation(api.listingSync.resyncVariant, { variantId: s.fx.baseId })).toEqual({ queued: 1 });
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].variantId).toBe(s.fx.baseId);
  });
});

describe("listSales", () => {
  test("my orders only, newest first, a page at a time", async () => {
    const s = await fresh();
    const order = (owner: string, orderNo: string, orderDate: number) =>
      s.t.run((ctx) =>
        ctx.db.insert("marketplaceSales", {
          ownerId: owner,
          platform: "bsc",
          orderId: `id-${orderNo}`,
          orderNo,
          orderDate,
          status: "SHIPPED",
          totals: { totalCents: 125 },
          items: [
            {
              platformCardId: "bsc-1",
              cardId: s.fx.gooden1,
              condition: "near_mint",
              quantity: 1,
              priceCents: 100,
              sellerSku: "NB-sku-box",
              applied: true,
              appliedAt: orderDate,
            },
          ],
          firstSeenAt: orderDate,
          lastUpdated: orderDate,
        }),
      );
    await order(ME.subject, "A-1", 1000);
    await order(ME.subject, "A-3", 3000);
    await order(ME.subject, "A-2", 2000);
    await order(THEM.subject, "B-1", 5000);
    const first = await s.me.query(api.listingSync.listSales, { paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page.map((o) => o.orderNo)).toEqual(["A-3", "A-2"]);
    expect(first.isDone).toBe(false);
    // The SKU and the time it was applied stay server-side.
    expect(first.page[0].items[0]).toEqual({
      platformCardId: "bsc-1",
      cardId: s.fx.gooden1,
      condition: "near_mint",
      quantity: 1,
      priceCents: 100,
      applied: true,
    });
    const second = await s.me.query(api.listingSync.listSales, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((o) => o.orderNo)).toEqual(["A-1"]);
    expect(second.isDone).toBe(true);
  });
});
