/**
 * NEO-370 — the listing hook (`listingOutbox.enqueueListingCards`, called by
 * `collection.applyCopyChanges`) and the collector's listing functions
 * (`convex/listingSync.ts`): Start listing, the credentials that stop it, a
 * box's "Listed on marketplaces" setting, Sync and Sales. The Sync status
 * tab's reads are pinned in `listingSyncStatus.test.ts`.
 *
 * The rules pinned here (Revision 4):
 *   - a write whose copy lived in a box before or after queues the card for
 *     every platform the owner has started; a binder-only write queues nothing;
 *   - an owner who never started (or whose sign-in was removed) gets no
 *     outbox row; saving a sign-in starts nothing, only `startListing` does;
 *   - the hook only queues: no write schedules a drain (no timer); a Sync,
 *     the end of the Start walk and a settled intake do;
 *   - a kick is a cheap no-op with nothing pending, a drain already
 *     scheduled, or one running (it then asks the running drain to go again);
 *   - flipping a box's listed setting queues its cards and kicks nothing;
 *   - only catalog cards carrying the platform's id are queued;
 *   - every public function is the caller's own, and a sync record's lease
 *     token, a marketplace card id and a seller SKU never reach a client.
 *
 * A kicked drain is `runAfter(0)`. Tests that only inspect the kick hold the
 * scheduler's timer (`holdDrains`) and cancel what is pending afterwards; a
 * drain that does run finds no BSC session (the credentials layer is mocked
 * to answer none), so nothing here reaches the network.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { DRAIN_SCHEDULE_STALE_MS, enqueueListingCards, kickOwnerDrains } from "./listingOutbox";
import { PAUSED_PLATFORMS_ENV } from "./lib/marketplacePause";

// A drain that runs here opens no BSC session: no token, and a refresh that
// fails. So it stops before any BSC call, and the suite never fetches.
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => null,
    }),
    refreshSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => ({ refreshed: false }),
    }),
  };
});

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

/** BSC listing started for ME the way the drainer would find it: just the state row. */
async function listOn(s: S, owner = ME.subject, extra: Record<string, unknown> = {}) {
  return s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId: owner,
      platform: "bsc",
      listingStartedAt: 1,
      lastUpdated: 0,
      ...extra,
    }),
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
/** Every drain ever scheduled, whatever became of it. */
async function drainsEver(s: S) {
  const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.name.includes("drainOwner"));
}
/** Hold the scheduler's timer so a kicked `runAfter(0)` drain stays pending to be inspected. */
function holdDrains() {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
}
/**
 * With drains held: run the queueing walk's pages by hand (cancelling each
 * scheduled copy), so the walk completes while the drain it kicks stays pending.
 */
async function runWalks(s: S) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const page = rows.find((r) => r.name.includes("queueBoxesPage") && r.state.kind === "pending");
    if (!page) return;
    await s.t.run((ctx) => ctx.scheduler.cancel(page._id));
    await s.t.mutation(internal.listingSync.queueBoxesPage, page.args[0] as never);
  }
  throw new Error("the walk did not finish");
}
/** One queued change for ME at the base variant, as the hook would leave it. */
const queueOne = (s: S, owner = ME.subject) =>
  s.t.run((ctx) =>
    ctx.db.insert("listingOutbox", {
      ownerId: owner,
      platform: "bsc",
      cardId: s.fx.gooden1,
      variantId: s.fx.baseId,
      seq: 1,
      changedAt: Date.now(),
    }),
  );
const addTo = (s: S, cardId: Id<"cardChecklist">, homeId: Id<"collectionContainers">) =>
  s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, homeId } });

let current: S | null = null;
beforeEach(() => {
  current = null;
});
afterEach(async () => {
  if (!current) {
    vi.useRealTimers();
    return;
  }
  // Cancel first: a held drain never fires, so draining would wait on it.
  await cancelScheduled(current.t as never);
  vi.useRealTimers();
  await drainScheduled(current.t);
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

  test("a box add queues the card once, for its variant, and schedules no drain", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await addTo(s, s.fx.gooden1, s.box);
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: ME.subject, platform: "bsc", cardId: s.fx.gooden1, variantId: s.fx.baseId, seq: 1 });
    expect((await states(s))[0].drainScheduledAt).toBeUndefined();
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a burst of box writes bumps seq on one row and schedules nothing", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.strawberry2, s.box);
    const rows = await outbox(s);
    expect(rows.map((r) => [r.cardId, r.seq]).sort()).toEqual(
      [[s.fx.gooden1, 2], [s.fx.strawberry2, 1]].sort(),
    );
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a row never started (Revision 3's `enabled` alone, or the start cleared): a box write queues nothing", async () => {
    const s = await fresh();
    const id = await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
    await s.t.run((ctx) => ctx.db.patch(id, { enabled: undefined }));
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
  });

  test("a write into an in-person box still queues the card (the drain counts it as 0)", async () => {
    const s = await fresh();
    await listOn(s);
    await s.t.run((ctx) => ctx.db.patch(s.box, { listedOnMarketplaces: false }));
    await addTo(s, s.fx.gooden1, s.box);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
  });

  test("a dormant row (no credentials) queues nothing", async () => {
    const s = await fresh();
    await listOn(s, ME.subject, { dormant: "noCredentials" });
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
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

describe("the drain kick (kickOwnerDrains: Sync, the end of the Start walk, a settled intake)", () => {
  const kick = (s: S, owner = ME.subject) => s.t.run((ctx) => kickOwnerDrains(ctx as never, owner));

  test("with a change pending: schedules one drain for me, stamped; a second kick adds none", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await listOn(s, THEM.subject);
    await queueOne(s);
    await queueOne(s, THEM.subject);
    await kick(s);
    const scheduled = await drains(s);
    expect(scheduled.map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
    const mine = (await states(s)).find((r) => r.ownerId === ME.subject);
    expect(mine?.drainScheduledAt).toBeTypeOf("number");
    await kick(s);
    expect(await drains(s)).toHaveLength(1);
    // Never another collector's drain.
    expect((await states(s)).find((r) => r.ownerId === THEM.subject)?.drainScheduledAt).toBeUndefined();
  });

  test("nothing pending: a no-op that writes nothing", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    const before = await states(s);
    await kick(s);
    expect(await drainsEver(s)).toEqual([]);
    expect(await states(s)).toEqual(before);
  });

  test("never started, start cleared, or dormant: nothing scheduled", async () => {
    const s = await fresh();
    holdDrains();
    await queueOne(s);
    await kick(s);
    expect(await drainsEver(s)).toEqual([]);
    const id = await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    await kick(s);
    await s.t.run((ctx) => ctx.db.patch(id, { listingStartedAt: 1, dormant: "noCredentials" }));
    await kick(s);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a stale drain stamp is replaced by a fresh drain", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s, ME.subject, { drainScheduledAt: Date.now() - DRAIN_SCHEDULE_STALE_MS - 1 });
    await queueOne(s);
    await kick(s);
    expect(await drains(s)).toHaveLength(1);
  });

  test("a fresh drain stamp: nothing more scheduled", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s, ME.subject, { drainScheduledAt: Date.now() });
    await queueOne(s);
    await kick(s);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a drain holding the lease: asked to go again once, nothing scheduled, a repeat writes nothing", async () => {
    const s = await fresh();
    holdDrains();
    const id = await listOn(s, ME.subject, { drainLeaseToken: "lease", drainLeaseExpiresAt: Date.now() + 60_000 });
    await queueOne(s);
    await kick(s);
    expect(await drainsEver(s)).toEqual([]);
    const after = await s.t.run((ctx) => ctx.db.get(id));
    expect(after?.drainRequested).toBe(true);
    await kick(s);
    expect(await s.t.run((ctx) => ctx.db.get(id))).toEqual(after);
    expect(await drainsEver(s)).toEqual([]);
  });
});

describe("listingSettings", () => {
  test("not listing and not connected by default", async () => {
    const s = await fresh();
    expect(await s.me.query(api.listingSync.listingSettings, {})).toEqual({
      bsc: { connected: false, listing: false, needsReauth: false, paused: false, sellerConflict: false },
    });
  });

  test("connected but never started: not listing (saving a sign-in starts nothing)", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toEqual({
      connected: true,
      listing: false,
      needsReauth: false,
      paused: false,
      sellerConflict: false,
    });
  });

  test("started: listing since the Start press; only to its owner", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: 1234 });
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      connected: true,
      listing: true,
      listingSince: 1234,
    });
    expect((await s.them.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      connected: false,
      listing: false,
    });
  });

  test("a seller conflict holds pushing back: not listing, conflict reported, start kept", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: 77, dormant: "sellerConflict" });
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      listing: false,
      listingSince: 77,
      sellerConflict: true,
    });
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

describe("startListing", () => {
  test("signed out: refused, no state row", async () => {
    const s = await fresh();
    await expect(s.t.mutation(api.listingSync.startListing, { platform: "bsc" })).rejects.toThrow();
    expect(await states(s)).toEqual([]);
  });

  test("without saved BuySportsCards credentials: notConnected, nothing written", async () => {
    const s = await fresh();
    expect(await s.me.mutation(api.listingSync.startListing, { platform: "bsc" })).toEqual({
      started: false,
      reason: "notConnected",
    });
    expect(await states(s)).toEqual([]);
  });

  test("stamps the start and queues every listed box's cards, never an in-person box or a binder", async () => {
    const s = await fresh();
    await connect(s);
    const inPerson = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show table" }))
      .containerId;
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: inPerson, listed: false });
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.gold1, s.box);
    await addTo(s, s.fx.strawberry2, s.sys.unsortedId);
    await addTo(s, s.fx.gooden1Sliding, inPerson);
    await addTo(s, s.fx.futureStar, s.binder);
    holdDrains();
    const before = Date.now();
    expect(await s.me.mutation(api.listingSync.startListing, { platform: "bsc" })).toEqual({ started: true });
    const [row] = await states(s);
    expect(row.listingStartedAt).toBeGreaterThanOrEqual(before);
    expect(row.dormant).toBeUndefined();
    await runWalks(s);
    const queued = await outbox(s);
    expect(queued.map((r) => r.cardId).sort()).toEqual([s.fx.gooden1, s.fx.gold1, s.fx.strawberry2].sort());
    expect(queued.find((r) => r.cardId === s.fx.gold1)?.variantId).toBe(s.fx.goldId);
    // The end of the walk ran one drain: the owner's first sync.
    expect((await drains(s)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ listing: true });
  });

  test("a second press keeps the first start and schedules no second walk", async () => {
    const s = await fresh();
    await connect(s);
    await addTo(s, s.fx.gooden1, s.box);
    holdDrains();
    await s.me.mutation(api.listingSync.startListing, { platform: "bsc" });
    await runWalks(s);
    const first = (await states(s))[0].listingStartedAt;
    expect(await s.me.mutation(api.listingSync.startListing, { platform: "bsc" })).toEqual({ started: true });
    const rows = await states(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].listingStartedAt).toBe(first);
    const walks = (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (r) => r.name.includes("queueBoxesPage") && r.state.kind === "pending",
    );
    expect(walks).toEqual([]);
  });

  test("a row kept from Revision 3 (enabled, never started) is started in place", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    expect(await s.me.mutation(api.listingSync.startListing, { platform: "bsc" })).toEqual({ started: true });
    const rows = await states(s);
    expect(rows.map((r) => r._id)).toEqual([id]);
    expect(rows[0].listingStartedAt).toBeTypeOf("number");
  });

  test("a BSC seller account another NB owner already lists from: sellerConflict, nothing written", async () => {
    const s = await fresh();
    await s.t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: ME.subject,
        marketplaceAccountIds: { bscSellerId: "seller-shared" },
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never),
    );
    await listOn(s, THEM.subject, { platformAccountId: "seller-shared" });
    expect(await s.me.mutation(api.listingSync.startListing, { platform: "bsc" })).toEqual({
      started: false,
      reason: "sellerConflict",
    });
    expect((await states(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
  });

  test("a walk page that finds the start cleared stops and queues nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { listingStartedAt: undefined });
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

describe("credentials: removing the sign-in stops listing, saving one starts nothing", () => {
  test("removal makes the row dormant, clears the start and my queued changes, never another collector's", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { reauthPollAt: 5, drainRequested: true });
    await listOn(s, THEM.subject);
    await queueOne(s);
    await queueOne(s, THEM.subject);
    await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: ME.subject, site: "buysportscards" });
    const stopped = await s.t.run((ctx) => ctx.db.get(id));
    expect(stopped?.dormant).toBe("noCredentials");
    expect(stopped?.listingStartedAt).toBeUndefined();
    expect(stopped?.drainRequested).toBeUndefined();
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    // Stopped, the hook queues nothing.
    await addTo(s, s.fx.gooden1, s.box);
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ listing: false });
  });

  test("saving the sign-in again wakes the row but does not start listing", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { reauthPollAt: 5 });
    await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: ME.subject, site: "buysportscards" });
    await s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
      userId: ME.subject,
      site: "buysportscards",
      hasCredentials: true,
    });
    const woke = await s.t.run((ctx) => ctx.db.get(id));
    expect(woke?.dormant).toBeUndefined();
    expect(woke?.reauthPollAt).toBeUndefined();
    expect(woke?.listingStartedAt).toBeUndefined();
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      connected: true,
      listing: false,
    });
  });

  test("saving a sign-in with no listing row writes none", async () => {
    const s = await fresh();
    await s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
      userId: ME.subject,
      site: "buysportscards",
      hasCredentials: true,
    });
    expect(await states(s)).toEqual([]);
  });

  test("another site's credentials, and a seller conflict, are left alone", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { dormant: "sellerConflict" });
    await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: ME.subject, site: "sportlots" });
    await s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
      userId: ME.subject,
      site: "buysportscards",
      hasCredentials: true,
    });
    const row = await s.t.run((ctx) => ctx.db.get(id));
    expect(row?.dormant).toBe("sellerConflict");
    expect(row?.listingStartedAt).toBe(1);
  });
});

describe("setContainerListed", () => {
  const pendingWalks = async (s: S) =>
    (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (r) => r.name.includes("queueBoxesPage") && r.state.kind === "pending",
    );

  test("signed out, or another collector's box: refused", async () => {
    const s = await fresh();
    await expect(
      s.t.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false }),
    ).rejects.toThrow();
    await expect(
      s.them.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false }),
    ).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(s.box)))?.listedOnMarketplaces).toBeUndefined();
  });

  test("a binder (or a system binder) is refused: a binder is never for sale", async () => {
    const s = await fresh();
    await expect(
      s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.binder, listed: false }),
    ).rejects.toThrow(/Only a box lists on marketplaces/);
    await expect(
      s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.sys.mainId, listed: false }),
    ).rejects.toThrow(/Only a box lists on marketplaces/);
  });

  test("in person and back: stored as false only, listed again as absent; the shelf shows false only", async () => {
    const s = await fresh();
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    expect((await s.t.run((ctx) => ctx.db.get(s.box)))?.listedOnMarketplaces).toBe(false);
    const shelf = await s.me.query(api.collectionContainers.list, {});
    expect(shelf.find((c) => c._id === s.box)?.listedOnMarketplaces).toBe(false);
    expect(shelf.filter((c) => c._id !== s.box).every((c) => !("listedOnMarketplaces" in c))).toBe(true);
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    expect((await s.t.run((ctx) => ctx.db.get(s.box)))?.listedOnMarketplaces).toBeUndefined();
    expect((await s.me.query(api.collectionContainers.list, {})).find((c) => c._id === s.box)).not.toHaveProperty(
      "listedOnMarketplaces",
    );
  });

  test("while listing: a flip queues every card in the box and runs no drain, like a move", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.strawberry2, s.box);
    await addTo(s, s.fx.futureStar, s.binder);
    await listOn(s);
    holdDrains();
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.cardId).sort()).toEqual([s.fx.gooden1, s.fx.strawberry2].sort());
    expect(await drainsEver(s)).toEqual([]);
    // And back: queued again (seq bumps), still no drain.
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.seq)).toEqual([2, 2]);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("setting the value it already has writes and queues nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    const before = await s.t.run((ctx) => ctx.db.get(s.box));
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    expect(await s.t.run((ctx) => ctx.db.get(s.box))).toEqual(before);
    expect(await pendingWalks(s)).toEqual([]);
    expect(await outbox(s)).toEqual([]);
  });

  test("not listing anywhere: the setting is saved and nothing is queued", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    expect(await pendingWalks(s)).toEqual([]);
    expect(await outbox(s)).toEqual([]);
    expect((await s.t.run((ctx) => ctx.db.get(s.box)))?.listedOnMarketplaces).toBe(false);
  });
});

describe("syncVariant", () => {
  const record = (s: S, extra: Record<string, unknown> = {}) =>
    s.t.run((ctx) =>
      ctx.db.insert("marketplaceListingSyncs", {
        ownerId: ME.subject,
        variantId: s.fx.baseId,
        platform: "bsc",
        status: "idle",
        lastSuccessAt: 500,
        lastRunAt: 500,
        problems: [],
        conditionsPushed: ["near_mint"],
        lastUpdated: 1,
        ...extra,
      }),
    );

  test("signed out: refused", async () => {
    const s = await fresh();
    await expect(s.t.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).rejects.toThrow();
  });

  test("listing nowhere (never started, or stopped): notListing, nothing written", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "notListing",
    });
    await listOn(s, ME.subject, { dormant: "noCredentials" });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "notListing",
    });
    expect(await outbox(s)).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("queues the set's box cards only, asks for a full read, keeps the last clean run, and kicks the drain", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await addTo(s, s.fx.strawberry2, s.binder);
    await addTo(s, s.fx.gold1, s.box);
    await listOn(s);
    const id = await record(s);
    holdDrains();
    const before = Date.now();
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    const after = await s.t.run((ctx) => ctx.db.get(id));
    expect(after?.resyncRequestedAt).toBeGreaterThanOrEqual(before);
    expect(after?.lastSuccessAt).toBe(500);
    expect(after?.conditionsPushed).toEqual(["near_mint"]);
    expect((await drains(s)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
  });

  test("a card in an in-person box is queued too: its run sets the marketplace to 0 for it", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await s.t.run((ctx) => ctx.db.patch(s.box, { listedOnMarketplaces: false }));
    await listOn(s);
    holdDrains();
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
  });

  test("a second press inside a minute is throttled: nothing queued, nothing kicked", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    await record(s, { resyncRequestedAt: Date.now() - 10_000 });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "throttled",
    });
    expect(await outbox(s)).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a press more than a minute after the last is taken", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    await record(s, { resyncRequestedAt: Date.now() - 61_000 });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
  });

  test("a press while the set's run holds its lease is throttled", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    await record(s, { status: "running", leaseToken: "lease", leaseExpiresAt: Date.now() + 60_000 });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "throttled",
    });
    expect(await outbox(s)).toEqual([]);
  });

  test("no record yet: a change queued in the last minute is not re-queued, only kicked", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    await queueOne(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "throttled",
    });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
    expect(await drains(s)).toHaveLength(1);
  });

  test("a set with nothing in a box still queues one card so its run sets BSC to zero", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.binder);
    await listOn(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    const rows = await outbox(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].variantId).toBe(s.fx.baseId);
  });

  test("a set no card of which carries a BSC id: queued false with no reason, nothing kicked", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await s.t.run(async (ctx) => {
      for (const id of [s.fx.gooden1, s.fx.strawberry2, s.fx.gooden1Sliding]) {
        await ctx.db.patch(id, { platformData: {} });
      }
    });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: false });
    expect(await outbox(s)).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("another collector's press never touches my record", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await listOn(s, THEM.subject);
    const id = await record(s);
    expect(await s.them.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBeUndefined();
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
              platformCardId: "bsc-secret-1",
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
    // The BSC card id, the SKU and the time it was applied stay server-side.
    expect(first.page[0].items[0]).toEqual({
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
    expect(JSON.stringify([first, second])).not.toContain("bsc-secret-1");
  });
});
