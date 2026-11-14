/**
 * NEO-370 — the listing hook (`listingOutbox.enqueueListingCards`, called by
 * `collection.applyCopyChanges`) and the collector's listing functions
 * (`convex/listingSync.ts`): what a saved sign-in starts, the removal that
 * stops it, the E2E test marker, the cron's pass over sign-ins saved before
 * Revision 5, a box's "Listed on marketplaces" setting, Sync and Sales. The
 * Sync status tab's reads are pinned in `listingSyncStatus.test.ts`.
 *
 * The rules pinned here (Revision 5, "If you have credentials you are
 * syncing"):
 *   - a write whose copy lived in a box before or after queues the card for
 *     every platform the owner lists on; a binder-only write queues nothing;
 *   - saving a sign-in starts listing (row, stamp, one walk of the listed
 *     boxes, one drain), idempotently; removing it stops listing (dormant,
 *     stamp cleared, queue dropped); saving again starts again, and a walk
 *     from the earlier save stands down;
 *   - a paused platform is refused setup and Sync; a seller conflict holds
 *     the row dormant; the test marker holds it off and only the testing
 *     seed can set it;
 *   - the hook only queues: no write schedules a drain (no timer); a Sync,
 *     the end of a saved sign-in's walk and a settled intake do;
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
import { priceEveryVariant } from "../lib/testing/common-prices";
import { DRAIN_SCHEDULE_STALE_MS, enqueueListingCards, kickOwnerDrains } from "./listingOutbox";
import { SAVED_SIGN_INS_PASS_KEY, SIGN_IN_SCAN_PAGE } from "./listingSync";
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
  // NEO-370: a syncing collector's box adds need a price (`listingGate`).
  await priceEveryVariant(s.t, owner);
  return await s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId: owner,
      platform: "bsc",
      listingStartedAt: 1,
      lastUpdated: 0,
      ...extra,
    }),
  );
}
async function connect(s: S, owner = ME.subject, sellerId?: string) {
  await s.t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: owner,
      siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      // NEO-483: a drain claim refuses a BSC owner with no stored seller account.
      ...(sellerId !== undefined ? { marketplaceAccountIds: { bscSellerId: sellerId } } : {}),
    }),
  );
}
/** A seller id `isBscSellerId` accepts, for the tests that claim a drain. */
const STORED_SELLER = "seller-1";
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
 * With drains held: run the queueing walk's pages by hand (a saved sign-in's
 * walk starts with `startListingWalk`; cancelling each
 * scheduled copy), so the walk completes while the drain it kicks stays pending.
 */
async function runWalks(s: S) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const page = rows.find(
      (r) =>
        (r.name.includes("queueBoxesPage") ||
          r.name.includes("queueListedBoxPage") ||
          r.name.includes("startListingWalk")) &&
        r.state.kind === "pending",
    );
    if (!page) return;
    await s.t.run((ctx) => ctx.scheduler.cancel(page._id));
    if (page.name.includes("queueListedBoxPage")) {
      await s.t.mutation(internal.listingSync.queueListedBoxPage, page.args[0] as never);
    } else if (page.name.includes("startListingWalk")) {
      await s.t.mutation(internal.listingSync.startListingWalk, page.args[0] as never);
    } else {
      await s.t.mutation(internal.listingSync.queueBoxesPage, page.args[0] as never);
    }
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

  test("a row not listing (Revision 3's `enabled` alone, the stamp cleared, the test marker): a box write queues nothing", async () => {
    const s = await fresh();
    const id = await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
    await s.t.run((ctx) => ctx.db.patch(id, { enabled: undefined }));
    await addTo(s, s.fx.gooden1, s.box);
    expect(await outbox(s)).toEqual([]);
    await s.t.run((ctx) => ctx.db.patch(id, { listingStartedAt: 1, testListingOff: true }));
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

describe("the drain kick (kickOwnerDrains: Sync, the end of a saved sign-in's walk, a settled intake)", () => {
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
    expect(scheduled.map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc", kickToken: expect.any(String) }]);
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
    await s.t.run((ctx) => ctx.db.patch(id, { dormant: undefined, testListingOff: true }));
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
    // NEO-415: eBay answers in the same shape beside BSC.
    expect(await s.me.query(api.listingSync.listingSettings, {})).toEqual({
      bsc: { connected: false, listing: false, needsReauth: false, paused: false, sellerConflict: false },
      ebay: { connected: false, listing: false, needsReauth: false, paused: false, sellerConflict: false },
    });
  });

  test("a row with no stamp (kept from Revision 3) is not listing, connected or not", async () => {
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

  test("listing since the save that started it; only to its owner", async () => {
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

  test("a seller conflict holds pushing back: not listing, conflict reported, no since", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: 77, dormant: "sellerConflict" });
    const bsc = (await s.me.query(api.listingSync.listingSettings, {})).bsc;
    expect(bsc).toMatchObject({ connected: true, listing: false, sellerConflict: true });
    expect(bsc.listingSince).toBeUndefined();
  });

  test("the E2E test marker: connected, not listing, nothing else to say", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: undefined, testListingOff: true });
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toEqual({
      connected: true,
      listing: false,
      needsReauth: false,
      paused: false,
      sellerConflict: false,
    });
  });

  test("paused when NB pauses BuySportsCards: a listing row reads not listing", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: 1234 });
    await withPaused(async () => {
      expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
        connected: true,
        listing: false,
        paused: true,
      });
    });
  });
});

/** The collector's own save through the product (`credentials.saveCredentials`). */
const save = (s: S, owner = ME.subject, listing: "save" | "testOff" = "save") =>
  s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
    userId: owner,
    site: "buysportscards",
    hasCredentials: true,
    needsReauth: false,
    listing,
  });
/** A successful login re-asserting the flag (a token refresh, Test Credentials): no `listing`. */
const refresh = (s: S, owner = ME.subject) =>
  s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
    userId: owner,
    site: "buysportscards",
    hasCredentials: true,
    needsReauth: false,
  });
const remove = (s: S, owner = ME.subject) =>
  s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: owner, site: "buysportscards" });
async function pendingNamed(s: S, name: string) {
  const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.name.includes(name) && r.state.kind === "pending");
}
async function withPaused(body: () => Promise<void>) {
  const before = process.env[PAUSED_PLATFORMS_ENV];
  process.env[PAUSED_PLATFORMS_ENV] = "buysportscards";
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env[PAUSED_PLATFORMS_ENV];
    else process.env[PAUSED_PLATFORMS_ENV] = before;
  }
}
async function withTestingFlag(body: () => Promise<void>) {
  const before = process.env.TESTING_RESET_SECRET;
  process.env.TESTING_RESET_SECRET = "test-enabled";
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.TESTING_RESET_SECRET;
    else process.env.TESTING_RESET_SECRET = before;
  }
}

describe("a saved sign-in is listing (Revision 5)", () => {
  test("saving makes the row, stamps since, queues every listed box's cards (never an in-person box or a binder) and runs one drain", async () => {
    const s = await fresh();
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
    await save(s);
    const [row] = await states(s);
    expect(row.listingStartedAt).toBeGreaterThanOrEqual(before);
    expect(row.dormant).toBeUndefined();
    expect(row.testListingOff).toBeUndefined();
    await runWalks(s);
    const queued = await outbox(s);
    expect(queued.map((r) => r.cardId).sort()).toEqual([s.fx.gooden1, s.fx.gold1, s.fx.strawberry2].sort());
    expect(queued.find((r) => r.cardId === s.fx.gold1)?.variantId).toBe(s.fx.goldId);
    // The end of the walk ran one drain: the owner's first sync.
    expect((await drains(s)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc", kickToken: expect.any(String) }]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      connected: true,
      listing: true,
      listingSince: row.listingStartedAt,
    });
  });

  test("idempotent: a second save, and a token refresh, keep the stamp and schedule no second walk", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    holdDrains();
    await save(s);
    const first = (await states(s))[0];
    // A second save while the first walk is still pending: no second walk.
    await save(s);
    await refresh(s);
    expect(await pendingNamed(s, "startListingWalk")).toHaveLength(1);
    await runWalks(s);
    await save(s);
    await refresh(s);
    const rows = await states(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].listingStartedAt).toBe(first.listingStartedAt);
    expect(await pendingNamed(s, "startListingWalk")).toEqual([]);
    expect(await pendingNamed(s, "queueBoxesPage")).toEqual([]);
  });

  test("a login re-asserting a sign-in saved before Revision 5 starts listing too", async () => {
    const s = await fresh();
    await connect(s);
    holdDrains();
    await refresh(s);
    expect((await states(s))[0].listingStartedAt).toBeTypeOf("number");
    expect(await pendingNamed(s, "startListingWalk")).toHaveLength(1);
  });

  test("a save while NB has paused BuySportsCards sets up anyway: row stamped, cards queued, no drain; reads paused, not listing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    holdDrains();
    await withPaused(async () => {
      await save(s);
      const [row] = await states(s);
      expect(row.listingStartedAt).toBeTypeOf("number");
      await runWalks(s);
      expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
      // Nothing reaches the platform while paused: no drain was kicked.
      expect(await drainsEver(s)).toEqual([]);
      expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
        connected: true,
        listing: false,
        paused: true,
      });
    });
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ listing: true });
  });

  test("a login re-asserting the flag while paused writes nothing", async () => {
    const s = await fresh();
    await connect(s);
    await withPaused(async () => {
      await refresh(s);
    });
    expect(await states(s)).toEqual([]);
    expect(await pendingNamed(s, "startListingWalk")).toEqual([]);
  });

  test("on a testing deployment a login re-assert never starts listing, row or no row; an explicit save does", async () => {
    const s = await fresh();
    await connect(s);
    await withTestingFlag(async () => {
      holdDrains();
      await refresh(s);
      expect(await states(s)).toEqual([]);
      const scheduled = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled).toEqual([]);
      // A row that is not listing (a stamp cleared) is not woken either.
      await listOn(s, ME.subject, { listingStartedAt: undefined, dormant: "noCredentials" });
      const before = await states(s);
      await refresh(s);
      expect(await states(s)).toEqual(before);
      await save(s);
      expect((await states(s))[0].listingStartedAt).toBeTypeOf("number");
    });
  });

  test("another site's sign-in starts nothing", async () => {
    const s = await fresh();
    await s.t.mutation(internal.userProfile.updateSiteCredentialStatus, {
      userId: ME.subject,
      site: "sportlots",
      hasCredentials: true,
    });
    expect(await states(s)).toEqual([]);
  });

  test("a row kept from Revision 3 (enabled, never stamped) is started in place", async () => {
    const s = await fresh();
    const id = await listOn(s, ME.subject, { listingStartedAt: undefined, enabled: true });
    holdDrains();
    await save(s);
    const rows = await states(s);
    expect(rows.map((r) => r._id)).toEqual([id]);
    expect(rows[0].listingStartedAt).toBeTypeOf("number");
  });

  test("a BSC seller account another NB owner already lists from: dormant sellerConflict, nothing queued, the account not stamped", async () => {
    const s = await fresh();
    await s.t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: ME.subject,
        marketplaceAccountIds: { bscSellerId: "seller-shared" },
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never),
    );
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, THEM.subject, { platformAccountId: "seller-shared" });
    holdDrains();
    await save(s);
    const mine = (await states(s)).find((r) => r.ownerId === ME.subject);
    expect(mine).toMatchObject({ dormant: "sellerConflict" });
    expect(mine?.platformAccountId).toBeUndefined();
    expect(mine?.listingStartedAt).toBeUndefined();
    expect(await pendingNamed(s, "startListingWalk")).toEqual([]);
    expect(await outbox(s)).toEqual([]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      listing: false,
      sellerConflict: true,
    });
    // A token refresh never re-checks it (no churn), and a repeated save
    // that still conflicts writes nothing.
    const before = await s.t.run((ctx) => ctx.db.get(mine!._id));
    await refresh(s);
    await save(s);
    expect(await s.t.run((ctx) => ctx.db.get(mine!._id))).toEqual(before);
    // The other owner stops listing (sign-in removed): a real save starts mine.
    await remove(s, THEM.subject);
    await save(s);
    const after = await s.t.run((ctx) => ctx.db.get(mine!._id));
    expect(after?.dormant).toBeUndefined();
    expect(after?.listingStartedAt).toBeTypeOf("number");
    expect(after?.platformAccountId).toBe("seller-shared");
  });

  describe("one seller account: only a LISTING owner holds it, so no two owners lock each other out", () => {
    const withSeller = (s: S, owner: string) =>
      s.t.run((ctx) =>
        ctx.db.insert("userProfiles", {
          userId: owner,
          marketplaceAccountIds: { bscSellerId: "seller-x" },
          siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
        } as never),
      );
    const rowOf = async (s: S, owner: string) => (await states(s)).find((r) => r.ownerId === owner);
    const A = ME.subject;
    const B = THEM.subject;

    test("A lists, B conflicts; A removes and saves again and still lists", async () => {
      const s = await fresh();
      await withSeller(s, A);
      await withSeller(s, B);
      holdDrains();
      await save(s, A);
      await save(s, B);
      expect((await rowOf(s, B))?.dormant).toBe("sellerConflict");
      await remove(s, A);
      // B's conflicted row holds nothing, so A's own row is free to list again.
      await save(s, A);
      const a = await rowOf(s, A);
      expect(a?.dormant).toBeUndefined();
      expect(a?.listingStartedAt).toBeTypeOf("number");
      expect(a?.platformAccountId).toBe("seller-x");
    });

    test("B, conflicted, removes its sign-in: nothing is held for A", async () => {
      const s = await fresh();
      await withSeller(s, A);
      await withSeller(s, B);
      holdDrains();
      await save(s, A);
      await save(s, B);
      await remove(s, B);
      await remove(s, A);
      await save(s, A);
      expect((await rowOf(s, A))?.listingStartedAt).toBeTypeOf("number");
    });

    test("a noCredentials row (an owner who stopped) holds nothing", async () => {
      const s = await fresh();
      await listOn(s, A, { listingStartedAt: undefined, dormant: "noCredentials", platformAccountId: "seller-x" });
      await withSeller(s, B);
      holdDrains();
      await save(s, B);
      const b = await rowOf(s, B);
      expect(b?.dormant).toBeUndefined();
      expect(b?.platformAccountId).toBe("seller-x");
    });
  });

  test("a walk page or walk start carrying an older stamp stands down and queues nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { listingStartedAt: 500 });
    await s.t.mutation(internal.listingSync.queueBoxesPage, {
      ownerId: ME.subject,
      platform: "bsc",
      startedAt: 400,
      boxIds: [s.box],
      index: 0,
      cursor: null,
    });
    await s.t.mutation(internal.listingSync.startListingWalk, { ownerId: ME.subject, platform: "bsc", startedAt: 400 });
    expect(await outbox(s)).toEqual([]);
    expect(await pendingNamed(s, "queueBoxesPage")).toEqual([]);
  });

  test("a walk page that finds the stamp cleared (sign-in removed) stops and queues nothing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { listingStartedAt: undefined, dormant: "noCredentials" });
    await s.t.mutation(internal.listingSync.queueBoxesPage, {
      ownerId: ME.subject,
      platform: "bsc",
      startedAt: 1,
      boxIds: [s.box],
      index: 0,
      cursor: null,
    });
    expect(await outbox(s)).toEqual([]);
  });

  test("an owner with no listed box: the walk schedules nothing", async () => {
    const s = await fresh();
    await s.t.run(async (ctx) => {
      const rows = await ctx.db.query("collectionContainers").collect();
      for (const row of rows) if (row.kind === "box") await ctx.db.patch(row._id, { listedOnMarketplaces: false });
    });
    holdDrains();
    await save(s);
    await runWalks(s);
    expect(await pendingNamed(s, "queueBoxesPage")).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
  });
});

describe("credentials: removing the sign-in stops listing, saving again starts it again", () => {
  test("removal makes the row dormant, clears the stamp and my queued changes, never another collector's", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { reauthPollAt: 5, drainRequested: true });
    await listOn(s, THEM.subject);
    await queueOne(s);
    await queueOne(s, THEM.subject);
    await remove(s);
    const stopped = await s.t.run((ctx) => ctx.db.get(id));
    expect(stopped?.dormant).toBe("noCredentials");
    expect(stopped?.listingStartedAt).toBeUndefined();
    expect(stopped?.drainRequested).toBeUndefined();
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    // Stopped, the hook queues nothing.
    await addTo(s, s.fx.gooden1, s.box);
    expect((await outbox(s)).map((r) => r.ownerId)).toEqual([THEM.subject]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
      connected: false,
      listing: false,
    });
  });

  test("saving again starts again: woken, restamped, walked; the earlier walk stands down", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    holdDrains();
    await save(s);
    const [firstWalk] = await pendingNamed(s, "startListingWalk");
    const firstArgs = firstWalk.args[0] as { ownerId: string; platform: "bsc"; startedAt: number };
    const id = (await states(s))[0]._id;
    await s.t.run((ctx) => ctx.db.patch(id, { reauthPollAt: 5 }));
    await remove(s);
    await s.t.run((ctx) => ctx.scheduler.cancel(firstWalk._id));
    // The first walk's start, run late: the row no longer lists, so it stands down.
    await s.t.mutation(internal.listingSync.startListingWalk, firstArgs);
    expect(await pendingNamed(s, "queueBoxesPage")).toEqual([]);
    // Saved again at a later millisecond: a new stamp and a new walk.
    const t0 = Date.now();
    while (Date.now() === t0) {
      // spin one millisecond (setTimeout is held)
    }
    await save(s);
    const woke = await s.t.run((ctx) => ctx.db.get(id));
    expect(woke?.dormant).toBeUndefined();
    expect(woke?.reauthPollAt).toBeUndefined();
    expect(woke?.listingStartedAt).toBeGreaterThan(firstArgs.startedAt);
    // The earlier walk's stamp no longer names the row's: it stands down even now.
    await s.t.mutation(internal.listingSync.startListingWalk, firstArgs);
    expect(await pendingNamed(s, "queueBoxesPage")).toEqual([]);
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({ listing: true });
  });

  test("another site's removal, and a removal with a seller conflict, keep what they should", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { dormant: "sellerConflict" });
    await s.t.mutation(internal.userProfile.removeSiteCredentialStatus, { userId: ME.subject, site: "sportlots" });
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.listingStartedAt).toBe(1);
    await remove(s);
    const row = await s.t.run((ctx) => ctx.db.get(id));
    expect(row?.dormant).toBe("sellerConflict");
    expect(row?.listingStartedAt).toBeUndefined();
  });
});

describe("the E2E test marker (testListingOff)", () => {
  test("refused where the testing flag is unset (production): nothing written", async () => {
    const s = await fresh();
    await expect(save(s, ME.subject, "testOff")).rejects.toThrow(/not enabled/);
    expect(await states(s)).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("userProfiles").collect())).toEqual([]);
  });

  test("set by the seed: connected, not listing, the hook and a token refresh start nothing", async () => {
    const s = await fresh();
    await withTestingFlag(async () => {
      holdDrains();
      await save(s, ME.subject, "testOff");
      const [row] = await states(s);
      expect(row).toMatchObject({ ownerId: ME.subject, platform: "bsc", testListingOff: true });
      expect(row.listingStartedAt).toBeUndefined();
      await refresh(s);
      await addTo(s, s.fx.gooden1, s.box);
      expect(await outbox(s)).toEqual([]);
      expect(await pendingNamed(s, "startListingWalk")).toEqual([]);
      expect((await s.me.query(api.listingSync.listingSettings, {})).bsc).toMatchObject({
        connected: true,
        listing: false,
      });
      expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
        queued: false,
        ignored: "notListing",
      });
    });
  });

  test("set on an owner already listing: stops (stamp cleared, queue dropped)", async () => {
    const s = await fresh();
    await connect(s);
    const id = await listOn(s, ME.subject, { drainRequested: true });
    await queueOne(s);
    await withTestingFlag(async () => {
      await save(s, ME.subject, "testOff");
    });
    const row = await s.t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ testListingOff: true });
    expect(row?.listingStartedAt).toBeUndefined();
    expect(row?.drainRequested).toBeUndefined();
    expect(await outbox(s)).toEqual([]);
  });

  test("a real save clears it and starts listing", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await withTestingFlag(async () => {
      await save(s, ME.subject, "testOff");
    });
    holdDrains();
    await save(s);
    const [row] = await states(s);
    expect(row.testListingOff).toBeUndefined();
    expect(row.listingStartedAt).toBeTypeOf("number");
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
  });
});

describe("sign-ins saved before Revision 5: the cron's one-time pass (setUpSavedSignInsPage)", () => {
  const pass = (s: S, cursor: string | null = null) =>
    s.t.mutation(internal.listingSync.setUpSavedSignInsPage, { cursor });
  const passDone = async (s: S) =>
    (await s.t.run((ctx) => ctx.db.query("listingBackfillState").collect())).some(
      (r) => r.key === SAVED_SIGN_INS_PASS_KEY,
    );

  test("sets up a saved BSC sign-in with no row; leaves the marker, a conflict, a listing owner and no sign-in alone", async () => {
    const s = await fresh();
    const others = ["owner_marker", "owner_conflict", "owner_listing", "owner_none"];
    await connect(s);
    for (const owner of others.slice(0, 3)) await connect(s, owner);
    await s.t.run((ctx) => ctx.db.insert("userProfiles", { userId: "owner_none", siteCredentials: [] }));
    await listOn(s, "owner_marker", { listingStartedAt: undefined, testListingOff: true });
    await listOn(s, "owner_conflict", { listingStartedAt: undefined, dormant: "sellerConflict" });
    const listingId = await listOn(s, "owner_listing", { listingStartedAt: 42 });
    holdDrains();
    const before = await states(s);
    expect(await pass(s)).toEqual({ started: 1, deferred: 0, done: true });
    const after = await states(s);
    const mine = after.find((r) => r.ownerId === ME.subject);
    expect(mine?.listingStartedAt).toBeTypeOf("number");
    for (const row of before) expect(after.find((r) => r._id === row._id)).toEqual(row);
    expect((await s.t.run((ctx) => ctx.db.get(listingId)))?.listingStartedAt).toBe(42);
    expect(after.some((r) => r.ownerId === "owner_none")).toBe(false);
    expect((await pendingNamed(s, "startListingWalk")).map((r) => r.args[0])).toEqual([
      { ownerId: ME.subject, platform: "bsc", startedAt: mine?.listingStartedAt },
    ]);
  });

  test("a row woken from noCredentials while the sign-in is saved again is set up", async () => {
    const s = await fresh();
    await connect(s);
    await listOn(s, ME.subject, { listingStartedAt: undefined, dormant: "noCredentials" });
    holdDrains();
    expect(await pass(s)).toEqual({ started: 1, deferred: 0, done: true });
    expect((await states(s))[0].dormant).toBeUndefined();
  });

  test("pages: a full page schedules the next one; the last schedules none", async () => {
    const s = await fresh();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < SIGN_IN_SCAN_PAGE; i += 1) {
        await ctx.db.insert("userProfiles", { userId: `bulk_${i}`, siteCredentials: [] });
      }
    });
    await connect(s, "bulk_last");
    holdDrains();
    expect(await pass(s)).toEqual({ started: 0, deferred: 0, done: false });
    expect(await passDone(s)).toBe(false);
    const [next] = await pendingNamed(s, "setUpSavedSignInsPage");
    expect(next).toBeDefined();
    await s.t.run((ctx) => ctx.scheduler.cancel(next._id));
    expect(await s.t.mutation(internal.listingSync.setUpSavedSignInsPage, next.args[0] as never)).toEqual({
      started: 1,
      deferred: 0,
      done: true,
    });
    expect(await pendingNamed(s, "setUpSavedSignInsPage")).toEqual([]);
    expect(await passDone(s)).toBe(true);
  });

  test("a sign-in found while paused is deferred: the pass is not done, and a later pass sets it up and ends", async () => {
    const s = await fresh();
    await connect(s);
    await withPaused(async () => {
      expect(await pass(s)).toEqual({ started: 0, deferred: 1, done: false });
    });
    expect(await states(s)).toEqual([]);
    expect(await passDone(s)).toBe(false);
    holdDrains();
    expect(await pass(s)).toEqual({ started: 1, deferred: 0, done: true });
    expect(await passDone(s)).toBe(true);
  });

  test("done: a later pass reads nothing and writes nothing", async () => {
    const s = await fresh();
    expect(await pass(s)).toEqual({ started: 0, deferred: 0, done: true });
    await connect(s);
    expect(await pass(s)).toEqual({ started: 0, deferred: 0, done: true });
    expect(await states(s)).toEqual([]);
    expect(
      (await s.t.run((ctx) => ctx.db.query("listingBackfillState").collect())).map((r) => r.key),
    ).toEqual([SAVED_SIGN_INS_PASS_KEY]);
  });

  test("on a testing deployment: sets up nothing and never records done", async () => {
    const s = await fresh();
    await connect(s);
    await withTestingFlag(async () => {
      expect(await pass(s)).toEqual({ started: 0, deferred: 0, done: false });
    });
    expect(await states(s)).toEqual([]);
    expect(await passDone(s)).toBe(false);
  });
});

describe("setContainerListed", () => {
  const pendingWalks = async (s: S) =>
    (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (r) => (r.name.includes("queueBoxesPage") || r.name.includes("queueListedBoxPage")) && r.state.kind === "pending",
    );
  const boxRow = (s: S) => s.t.run((ctx) => ctx.db.get(s.box));

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

  test("a run of flips while the box's walk is pending schedules no second walk; the walk follows the setting", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    holdDrains();
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    const stamped = (await boxRow(s))?.listedQueuedAt;
    expect(stamped).toBeTypeOf("number");
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    const walks = await pendingWalks(s);
    expect(walks).toHaveLength(1);
    expect(walks[0].args[0]).toMatchObject({ listed: false, queuedAt: stamped, cursor: null });
    // The setting ended where the walk started: it runs as scheduled, then clears the stamp.
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    expect((await boxRow(s))?.listedQueuedAt).toBeUndefined();
    // Done: the next flip walks again.
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    expect(await pendingWalks(s)).toHaveLength(1);
  });

  test("flipped back before the walk ran: that walk stops and one fresh walk carries the box's current setting", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    holdDrains();
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: true });
    const [first] = await pendingWalks(s);
    await s.t.run((ctx) => ctx.scheduler.cancel(first._id));
    await s.t.mutation(internal.listingSync.queueListedBoxPage, first.args[0] as never);
    // The stale walk queued nothing and handed over to one walk at the current setting.
    expect(await outbox(s)).toEqual([]);
    const next = await pendingWalks(s);
    expect(next).toHaveLength(1);
    expect(next[0].args[0]).toMatchObject({ listed: true, cursor: null });
    expect((next[0].args[0] as { queuedAt: number }).queuedAt).toBe((await boxRow(s))?.listedQueuedAt);
    await runWalks(s);
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    expect((await boxRow(s))?.listedQueuedAt).toBeUndefined();
  });

  test("a walk whose stamp the box no longer carries stands down; a stamp over a minute old is replaced", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    holdDrains();
    // A walk taken for dead: stamped long ago, never cleared.
    await s.t.run((ctx) => ctx.db.patch(s.box, { listedQueuedAt: Date.now() - 61_000 }));
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    const walks = await pendingWalks(s);
    expect(walks).toHaveLength(1);
    const fresh_ = (await boxRow(s))?.listedQueuedAt as number;
    expect(Date.now() - fresh_).toBeLessThan(61_000);
    // The old walk's page, if it still ran, writes nothing.
    await s.t.mutation(internal.listingSync.queueListedBoxPage, {
      ownerId: ME.subject,
      boxId: s.box,
      listed: false,
      queuedAt: fresh_ - 61_000,
      cursor: null,
    });
    expect(await outbox(s)).toEqual([]);
    expect((await boxRow(s))?.listedQueuedAt).toBe(fresh_);
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

  test("not listing anywhere: the setting is saved and nothing is queued or stamped", async () => {
    const s = await fresh();
    await addTo(s, s.fx.gooden1, s.box);
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    expect(await pendingWalks(s)).toEqual([]);
    expect(await outbox(s)).toEqual([]);
    expect((await s.t.run((ctx) => ctx.db.get(s.box)))?.listedOnMarketplaces).toBe(false);
    expect((await boxRow(s))?.listedQueuedAt).toBeUndefined();
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
    expect((await drains(s)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc", kickToken: expect.any(String) }]);
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

  test("a press while the set's run holds its lease is taken: queued, not ignored, with the cards queued, the stamp set and a kick", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { drainLeaseToken: "owner-lease", drainLeaseExpiresAt: Date.now() + 60_000 });
    const id = await record(s, { status: "running", leaseToken: "lease", leaseExpiresAt: Date.now() + 60_000, lastRunAt: Date.now() - 5_000 });

    const result = await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId });

    expect(result.queued).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    const stamped = await s.t.run((ctx) => ctx.db.get(id));
    expect(stamped?.resyncRequestedAt).toBeGreaterThan(stamped?.lastRunAt ?? 0);
    // The owner's drain is busy: the kick asks it to run again on release.
    expect((await states(s))[0].drainRequested).toBe(true);
  });

  test("a press while the eBay run holds its lease is taken: queued on eBay, not ignored, stamped, and the busy drain is asked to run again", async () => {
    const s = await fresh();
    holdDrains();
    vi.stubEnv("EBAY_CLIENT_ID", "client");
    vi.stubEnv("EBAY_RU_NAME", "runame");
    vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
    try {
      await addTo(s, s.fx.gooden1, s.box);
      await priceEveryVariant(s.t, ME.subject);
      await s.t.run((ctx) =>
        ctx.db.insert("marketplaceListingStates", {
          ownerId: ME.subject,
          platform: "ebay",
          listingStartedAt: 1,
          lastUpdated: 0,
          drainLeaseToken: "owner-lease",
          drainLeaseExpiresAt: Date.now() + 60_000,
        }),
      );
      const id = await s.t.run((ctx) =>
        ctx.db.insert("marketplaceListingSyncs", {
          ownerId: ME.subject,
          variantId: s.fx.baseId,
          platform: "ebay",
          status: "running",
          leaseToken: "lease",
          leaseExpiresAt: Date.now() + 60_000,
          lastSuccessAt: 500,
          lastRunAt: Date.now() - 5_000,
          problems: [],
          conditionsPushed: [],
          lastUpdated: 1,
        }),
      );

      const result = await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId });

      expect(result.queued).toBe(true);
      expect(result.ignored).toBeUndefined();
      expect((await outbox(s)).map((r) => [r.platform, r.cardId])).toEqual([["ebay", s.fx.gooden1]]);
      const stamped = await s.t.run((ctx) => ctx.db.get(id));
      expect(stamped?.resyncRequestedAt).toBeGreaterThan(stamped?.lastRunAt ?? 0);
      expect((await states(s)).find((x) => x.platform === "ebay")?.drainRequested).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a press during a run is carried through: the run goes again on release, reads in full, and the queued row survives the running run's finish", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s, ME.subject, STORED_SELLER);
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { drainLeaseToken: "owner-lease", drainLeaseExpiresAt: Date.now() + 60_000 });
    await record(s, { status: "running", leaseToken: "lease", leaseExpiresAt: Date.now() + 60_000, lastRunAt: Date.now() - 5_000 });
    // The row the running run's snapshot holds.
    const snapshotRowId = await queueOne(s);

    const pressed = await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId });
    expect(pressed.queued).toBe(true);
    expect((await states(s))[0].drainRequested).toBe(true);
    const [queued] = await outbox(s);
    expect(queued.cardId).toBe(s.fx.gooden1);
    expect(queued.seq).toBeGreaterThan(1);

    // The running run finishes, clearing the row it read: the press's row stays.
    const finished = await s.t.mutation(internal.listingDrain.finishVariant, {
      ownerId: ME.subject,
      platform: "bsc",
      variantId: s.fx.baseId,
      leaseToken: "lease",
      outcome: { kind: "ok", counts: { listed: 0, pushed: 0, zeroed: 0, skipped: 0 }, problems: [], problemsTotal: 0, conditionsPushed: [] },
      clear: [{ rowId: snapshotRowId, seq: 1 }],
      repoint: [],
    });
    expect(finished).toMatchObject({ cleared: 0, recorded: true });
    expect((await outbox(s)).map((r) => r._id)).toEqual([snapshotRowId]);

    // It releases and, since a kick landed while it ran, runs again.
    const released = await s.t.mutation(internal.listingDrain.releaseDrain, {
      ownerId: ME.subject,
      platform: "bsc",
      leaseToken: "owner-lease",
      next: "done",
    });
    expect(released).toMatchObject({ released: true });
    expect(released.scheduledInMs).not.toBeNull();
    expect(await drains(s)).toHaveLength(1);

    // That next run claims, and its claim of the variant reads every condition.
    expect(await s.t.mutation(internal.listingDrain.claimDrain, { ownerId: ME.subject, platform: "bsc", leaseToken: "lease-2" })).toEqual({ claimed: true });
    const claim = await s.t.mutation(internal.listingDrain.claimVariant, {
      ownerId: ME.subject,
      platform: "bsc",
      variantId: s.fx.baseId,
      leaseToken: "lease-2",
    });
    expect(claim).toMatchObject({ claimed: true, fullReadRequested: true });
  });

  test("a press inside a minute of the last with nothing waiting is still throttled while the set's run is under way", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { drainLeaseToken: "owner-lease", drainLeaseExpiresAt: Date.now() + 60_000 });
    await record(s, {
      status: "running",
      leaseToken: "lease",
      leaseExpiresAt: Date.now() + 60_000,
      lastRunAt: Date.now() - 20_000,
      resyncRequestedAt: Date.now() - 10_000,
    });

    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "throttled",
    });
    expect(await outbox(s)).toEqual([]);
    expect((await states(s))[0].drainRequested).toBeUndefined();
    expect(await drainsEver(s)).toEqual([]);
  });

  test("no record yet, a change boxed seconds ago: the press is taken (queued) and runs the drain, nothing re-queued", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    await queueOne(s);
    // Not "throttled": nothing has synced yet, and this press is what syncs it.
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
    expect(await drains(s)).toHaveLength(1);
  });

  test("throttled only when the press is dropped: a recent Sync press kicks nothing, a run under way no longer drops it", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    const id = await record(s, { resyncRequestedAt: Date.now() - 5_000 });
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
      queued: false,
      ignored: "throttled",
    });
    expect(await outbox(s)).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
    // The same record with its run under way and no recent press: taken.
    await s.t.run((ctx) =>
      ctx.db.patch(id, { resyncRequestedAt: undefined, status: "running", leaseToken: "l", leaseExpiresAt: Date.now() + 60_000 }),
    );
    const result = await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId });
    expect(result.queued).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect(await outbox(s)).toHaveLength(1);
  });

  test("a recent press with a change still pending: taken (queued), drain kicked once, nothing re-queued or re-stamped", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    const stamped = Date.now() - 10_000;
    const id = await record(s, { resyncRequestedAt: stamped });
    await queueOne(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
    expect(await drains(s)).toHaveLength(1);
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
  });

  test("a press while the set's run is under way, with a change pending and no recent press: taken, its rows re-queued and the press stamped", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s, ME.subject, { drainLeaseToken: "owner-lease", drainLeaseExpiresAt: Date.now() + 60_000 });
    const id = await record(s, { status: "running", leaseToken: "lease", leaseExpiresAt: Date.now() + 60_000 });
    await queueOne(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    const [row] = await outbox(s);
    expect(row.seq).toBeGreaterThan(1);
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBeDefined();
    expect((await states(s))[0].drainRequested).toBe(true);
  });

  describe("a press inside the minute while the set's run is under way (the last drain's time is the drain before this run)", () => {
    const pressedAgo = 10_000;
    /** A run under way, claimed after a press `pressedAgo` ago, with the owner's last finished drain `drainAgo` ago. */
    async function midRun(s: S, drainAgo: number) {
      holdDrains();
      await connect(s, ME.subject, STORED_SELLER);
      await addTo(s, s.fx.gooden1, s.box);
      await listOn(s, ME.subject, {
        drainLeaseToken: "owner-lease",
        drainLeaseExpiresAt: Date.now() + 60_000,
        lastDrainAt: Date.now() - drainAgo,
      });
      const stamped = Date.now() - pressedAgo;
      const id = await record(s, {
        status: "running",
        leaseToken: "lease",
        leaseExpiresAt: Date.now() + 60_000,
        lastRunAt: stamped - 10_000,
        resyncRequestedAt: stamped,
      });
      return { id, stamped };
    }
    const queueChangedAt = (s: S, changedAt: number) =>
      s.t.run((ctx) =>
        ctx.db.insert("listingOutbox", { ownerId: ME.subject, platform: "bsc", cardId: s.fx.gooden1, variantId: s.fx.baseId, seq: 1, changedAt }),
      );

    test("a row changed after that drain is untried: taken, the run goes round again, and the earlier press's full read still holds", async () => {
      const s = await fresh();
      const { id, stamped } = await midRun(s, 30_000);
      await queueChangedAt(s, Date.now() - 1_000);
      expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
      // Nothing re-queued, nothing re-stamped: this press asks for no new full read.
      expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
      expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
      expect((await states(s))[0].drainRequested).toBe(true);
      // The run ends with its lease released; the run the kick asked for reads in full.
      await s.t.run((ctx) => ctx.db.patch(id, { status: "idle", leaseToken: undefined, leaseExpiresAt: undefined }));
      const released = await s.t.mutation(internal.listingDrain.releaseDrain, {
        ownerId: ME.subject,
        platform: "bsc",
        leaseToken: "owner-lease",
        next: "done",
      });
      expect(released.scheduledInMs).not.toBeNull();
      expect(await s.t.mutation(internal.listingDrain.claimDrain, { ownerId: ME.subject, platform: "bsc", leaseToken: "lease-2" })).toEqual({ claimed: true });
      expect(
        await s.t.mutation(internal.listingDrain.claimVariant, {
          ownerId: ME.subject,
          platform: "bsc",
          variantId: s.fx.baseId,
          leaseToken: "lease-2",
        }),
      ).toMatchObject({ claimed: true, fullReadRequested: true });
    });

    test("a row no newer than a drain inside the minute was already tried: throttled, nothing asked of the run", async () => {
      const s = await fresh();
      const { id, stamped } = await midRun(s, 5_000);
      await queueChangedAt(s, Date.now() - 20_000);
      expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({
        queued: false,
        ignored: "throttled",
      });
      expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
      expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
      expect((await states(s))[0].drainRequested).toBeUndefined();
    });
  });

  test("a press, then the box goes in person and its walk queues it: a second press inside a minute is taken", async () => {
    const s = await fresh();
    holdDrains();
    await addTo(s, s.fx.gooden1, s.box);
    await listOn(s);
    const id = await record(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    const stamped = (await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt;
    expect(stamped).toBeDefined();
    // The first press's drain ran (simulated as a real one leaves things): its
    // scheduled copy is gone, its claim cleared `drainScheduledAt`, its release
    // stamped `lastDrainAt` before the flip below, and the outbox rows it
    // pushed were deleted.
    expect(await drains(s)).toHaveLength(1);
    await s.t.run(async (ctx) => {
      for (const d of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (d.name.includes("drainOwner") && d.state.kind === "pending") await ctx.scheduler.cancel(d._id);
      }
      for (const st of await ctx.db.query("marketplaceListingStates").collect()) {
        await ctx.db.patch(st._id, {
          drainScheduledAt: undefined,
          drainRequested: undefined,
          lastDrainAt: Date.now() - 1_000,
        });
      }
      for (const row of await ctx.db.query("listingOutbox").collect()) await ctx.db.delete(row._id);
    });
    expect(await drains(s)).toHaveLength(0);
    await s.me.mutation(api.collectionContainers.setContainerListed, { containerId: s.box, listed: false });
    await runWalks(s);
    const pending = await outbox(s);
    expect(pending.map((r) => r.cardId)).toEqual([s.fx.gooden1]);
    const seqs = pending.map((r) => r.seq);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.seq)).toEqual(seqs);
    expect(await drains(s)).toHaveLength(1);
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
  });

  describe("a row a recent drain already tried", () => {
    const press = (s: S) => s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId });
    const THROTTLED = { queued: false, ignored: "throttled" };
    /** One queued row for `owner` with its own change time. */
    const queueAt = (
      s: S,
      cardId: Id<"cardChecklist">,
      variantId: Id<"selectorOptions">,
      changedAt: number,
      owner = ME.subject,
    ) =>
      s.t.run((ctx) =>
        ctx.db.insert("listingOutbox", { ownerId: owner, platform: "bsc", cardId, variantId, seq: 1, changedAt }),
      );
    /** The set after a failed run: its record errored, its row kept, the drain released `drainAgo` ms ago. */
    async function afterFailedRun(s: S, drainAgo = 5_000) {
      holdDrains();
      await addTo(s, s.fx.gooden1, s.box);
      const lastDrainAt = Date.now() - drainAgo;
      await listOn(s, ME.subject, { lastDrainAt });
      const stamped = Date.now() - 10_000;
      const id = await record(s, { status: "error", lastError: "boom", resyncRequestedAt: stamped });
      return { id, stamped, lastDrainAt };
    }

    test("left behind by a failed run, pressed again inside a minute: throttled, no drain, nothing re-queued or re-stamped", async () => {
      const s = await fresh();
      const { id, stamped, lastDrainAt } = await afterFailedRun(s);
      // Changed exactly when the drain released: "no newer than" counts as tried.
      await queueAt(s, s.fx.gooden1, s.fx.baseId, lastDrainAt);
      expect(await press(s)).toEqual(THROTTLED);
      expect(await drainsEver(s)).toEqual([]);
      expect((await outbox(s)).map((r) => r.seq)).toEqual([1]);
      expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
    });

    test("hammering Sync: press, the run fails and releases, every press inside the minute is throttled, then past it the press is taken", async () => {
      const s = await fresh();
      holdDrains();
      await connect(s, ME.subject, STORED_SELLER);
      await addTo(s, s.fx.gooden1, s.box);
      await listOn(s);
      const id = await record(s);
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
      // The run, through the real claim and release: the sign-in fails and its row stays.
      const kicked = await drains(s);
      await s.t.run(async (ctx) => {
        for (const d of kicked) await ctx.scheduler.cancel(d._id);
      });
      const run ={ ownerId: ME.subject, platform: "bsc" as const, leaseToken: "failed-run" };
      expect(await s.t.mutation(internal.listingDrain.claimDrain, run)).toEqual({ claimed: true });
      const released = await s.t.mutation(internal.listingDrain.releaseDrain, { ...run, next: "stop" });
      expect(released).toEqual({ released: true, scheduledInMs: null });
      const [state] = await states(s);
      expect(state.lastDrainAt).toBeDefined();
      expect((await outbox(s)).map((r) => r.cardId)).toEqual([s.fx.gooden1]);
      for (let i = 0; i < 5; i += 1) expect(await press(s)).toEqual(THROTTLED);
      expect(await drains(s)).toEqual([]);
      // A minute on, for the press stamp and the release alike.
      const ago = Date.now() - 61_000;
      await s.t.run(async (ctx) => {
        await ctx.db.patch(id, { resyncRequestedAt: ago });
        await ctx.db.patch(state._id, { lastDrainAt: ago });
      });
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
    });

    test("the drain finished over a minute ago: a press inside a minute of the last press is taken", async () => {
      const s = await fresh();
      const { lastDrainAt } = await afterFailedRun(s, 61_000);
      await queueAt(s, s.fx.gooden1, s.fx.baseId, lastDrainAt - 1_000);
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
    });

    test("a new change after the failed run: taken, and the drain is kicked", async () => {
      const s = await fresh();
      const { id, stamped } = await afterFailedRun(s);
      await queueOne(s);
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
      expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBe(stamped);
    });

    test("an old failed row in front of a newer one in the same set: taken, the new change isn't hidden", async () => {
      const s = await fresh();
      const { lastDrainAt } = await afterFailedRun(s);
      await queueAt(s, s.fx.gooden1, s.fx.baseId, lastDrainAt - 1_000);
      await queueAt(s, s.fx.strawberry2, s.fx.baseId, Date.now());
      // The set's index order puts the old row first.
      const first = await s.t.run((ctx) =>
        ctx.db
          .query("listingOutbox")
          .withIndex("by_owner_platform_variant", (q) =>
            q.eq("ownerId", ME.subject).eq("platform", "bsc").eq("variantId", s.fx.baseId),
          )
          .first(),
      );
      expect(first?.cardId).toBe(s.fx.gooden1);
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
    });

    test("an old failed row here and a newer change in another set: taken, a drain is owed and it tries this set too", async () => {
      const s = await fresh();
      const { lastDrainAt } = await afterFailedRun(s);
      await queueAt(s, s.fx.gooden1, s.fx.baseId, lastDrainAt - 1_000);
      await queueAt(s, s.fx.gold1, s.fx.goldId, Date.now());
      expect(await press(s)).toEqual({ queued: true });
      expect(await drains(s)).toHaveLength(1);
    });

    test("another collector's newer change doesn't take my press", async () => {
      const s = await fresh();
      const { lastDrainAt } = await afterFailedRun(s);
      await queueAt(s, s.fx.gooden1, s.fx.baseId, lastDrainAt - 1_000);
      await queueAt(s, s.fx.gooden1, s.fx.baseId, Date.now(), THEM.subject);
      expect(await press(s)).toEqual(THROTTLED);
      expect(await drainsEver(s)).toEqual([]);
    });
  });

  test("a set I hold no copy of and never synced: nothing to sync here, nothing written or kicked", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: false });
    expect(await outbox(s)).toEqual([]);
    expect(await drainsEver(s)).toEqual([]);
  });

  test("a set I synced before but hold nothing of now: woken, so its run sets BSC to zero", async () => {
    const s = await fresh();
    holdDrains();
    await listOn(s);
    await record(s);
    expect(await s.me.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: true });
    expect((await outbox(s)).map((r) => r.variantId)).toEqual([s.fx.baseId]);
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
    // They hold no copy and never synced it: nothing to sync, and my record is untouched.
    expect(await s.them.mutation(api.listingSync.syncVariant, { variantId: s.fx.baseId })).toEqual({ queued: false });
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.resyncRequestedAt).toBeUndefined();
    expect(await outbox(s)).toEqual([]);
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

// NEO-483 — listing set-up arms the background read of the BuySportsCards
// seller account (30 s out) when none is stored. The drain refuses to run
// until it lands (`listingDrain.claimDrain`, `awaitingSeller`).
describe("setUpListing arms the seller-account read (NEO-483)", () => {
  const ticks = (s: S) => pendingNamed(s, "fetchTick");
  const rowOf = async (s: S) => (await states(s)).find((r) => r.platform === "bsc");

  test("a first save with no account stored: the read is armed, first try 30 s out", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s);
    const before = Date.now();

    await save(s);

    const row = await rowOf(s);
    expect(row?.listingStartedAt).toBeTypeOf("number");
    expect(row?.sellerIdFetch?.token).toMatch(/^[0-9a-f]{32}$/);
    const [tick] = await ticks(s);
    expect((tick.args as unknown as Array<Record<string, unknown>>)[0]).toEqual({
      ownerId: ME.subject,
      token: row?.sellerIdFetch?.token,
      attempt: 1,
    });
    expect(tick.scheduledTime).toBeGreaterThanOrEqual(before + 30_000);
    expect(tick.scheduledTime).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  test("a first save with the account already stored: nothing is armed", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s, ME.subject, STORED_SELLER);

    await save(s);

    expect((await rowOf(s))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(s)).toEqual([]);
  });

  test("a stored value that is not a seller id counts as no account", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s, ME.subject, "has spaces");

    await save(s);

    expect((await rowOf(s))?.sellerIdFetch).toBeDefined();
    expect(await ticks(s)).toHaveLength(1);
  });

  test("a save for an owner already listing with no account (the early return) arms it too", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s);
    await listOn(s);

    await save(s);

    expect((await rowOf(s))?.sellerIdFetch).toBeDefined();
    expect(await ticks(s)).toHaveLength(1);
  });

  test("a second save while the read runs does not start another", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s);
    await save(s);
    const first = (await rowOf(s))?.sellerIdFetch;

    await save(s);

    expect((await rowOf(s))?.sellerIdFetch).toEqual(first);
    expect(await ticks(s)).toHaveLength(1);
  });

  test("a save for an owner already listing with the account stored: nothing is armed", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s, ME.subject, STORED_SELLER);
    await listOn(s);

    await save(s);

    expect((await rowOf(s))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(s)).toEqual([]);
  });

  test("the E2E test marker: nothing is armed (the owner does not list)", async () => {
    const s = await fresh();
    holdDrains();
    await withTestingFlag(async () => {
      await connect(s);
      await save(s, ME.subject, "testOff");
    });

    expect((await rowOf(s))?.testListingOff).toBe(true);
    expect((await rowOf(s))?.sellerIdFetch).toBeUndefined();
    expect(await ticks(s)).toEqual([]);
  });

  test("BSC paused: nothing is armed", async () => {
    const s = await fresh();
    holdDrains();
    await connect(s);

    await withPaused(async () => {
      await save(s);
    });

    expect(await ticks(s)).toEqual([]);
  });
});
