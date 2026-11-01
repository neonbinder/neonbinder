/**
 * NEO-370 Revision 4 — the Sync status tab's reads (`convex/listingSync.ts`):
 * `syncStatus`, `syncSetProblems`, and the admin's read-only view of them
 * (`adminSyncOwners`, `adminSyncStatus`, `adminSyncSetProblems`).
 *
 * The rules pinned here:
 *   - every label comes from NB's own rows (the set's season and name, the
 *     variant, the card's number and players), never a marketplace value;
 *   - the queue reads oldest first and the sets most recent run first, each
 *     capped (`STATUS_CAPS`) with the first few problems per set, so the
 *     subscription stays a few hundred reads;
 *   - "running" is the owner's drain lease, plus the set whose run holds its
 *     lease now; a run whose lease lapsed reads as its last result;
 *   - a lease token, a marketplace card id and a seller account id never
 *     reach a client;
 *   - the admin functions refuse anyone who is not an admin, and the
 *     all-collectors view is capped by owners and by per-owner lists.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { ADMIN_ALL_CAPS, ADMIN_STATUS_OWNERS, STATUS_CAPS } from "./listingSync";
import { DRAIN_LEASE_MS } from "./listingDrain";
import { MISSING_SET_LABEL } from "./lib/listingLabels";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_370s" };
const THEM = { subject: "collector_them_370s" };
const ADMIN = { subject: "admin", role: "admin" };

const BASE_LABEL = "2024 Topps Chrome";
const GOLD_LABEL = "2024 Topps Chrome Gold Refractor";

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM), admin: t.withIdentity(ADMIN) };
}
type S = Awaited<ReturnType<typeof setup>>;

const listOn = (s: S, owner = ME.subject, extra: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId: owner,
      platform: "bsc",
      listingStartedAt: 1,
      platformAccountId: "seller-secret-acct",
      lastUpdated: 0,
      ...extra,
    }),
  );

const queue = (s: S, cardId: Id<"cardChecklist">, variantId: Id<"selectorOptions">, changedAt: number, owner = ME.subject) =>
  s.t.run((ctx) =>
    ctx.db.insert("listingOutbox", { ownerId: owner, platform: "bsc", cardId, variantId, seq: 1, changedAt }),
  );

const record = (s: S, variantId: Id<"selectorOptions">, extra: Record<string, unknown> = {}, owner = ME.subject) =>
  s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingSyncs", {
      ownerId: owner,
      variantId,
      platform: "bsc",
      status: "idle",
      problems: [],
      conditionsPushed: [],
      lastUpdated: 1,
      ...extra,
    }),
  );

const bsc = async (s: S, who: "me" | "them" = "me") => {
  const status = await s[who].query(api.listingSync.syncStatus, {});
  expect(status.platforms.map((p) => p.platform)).toEqual(["bsc"]);
  return status.platforms[0];
};

describe("syncStatus", () => {
  test("signed out: refused", async () => {
    const s = await setup();
    await expect(s.t.query(api.listingSync.syncStatus, {})).rejects.toThrow();
    await expect(
      s.t.query(api.listingSync.syncSetProblems, { variantId: s.fx.baseId, platform: "bsc" }),
    ).rejects.toThrow();
  });

  test("a collector who never listed: an empty BSC entry", async () => {
    const s = await setup();
    expect(await bsc(s)).toEqual({
      platform: "bsc",
      connected: false,
      listing: false,
      needsReauth: false,
      paused: false,
      sellerConflict: false,
      running: null,
      queued: { cards: [], more: false },
      sets: [],
    });
  });

  test("names queued cards and sets from NB rows, oldest change first, and hides every secret", async () => {
    const s = await setup();
    await listOn(s, ME.subject, { drainScheduledAt: 4000, lastDrainAt: 3000 });
    await queue(s, s.fx.strawberry2, s.fx.baseId, 200);
    await queue(s, s.fx.gold1, s.fx.goldId, 100);
    await queue(s, s.fx.gooden1, s.fx.baseId, 50, THEM.subject);
    await record(s, s.fx.baseId, {
      lastRunAt: 900,
      lastSuccessAt: 900,
      counts: { listed: 3, pushed: 2, zeroed: 1, skipped: 1 },
      leaseToken: "lease-secret",
      problems: [
        { cardId: s.fx.gooden1, platformCardId: "bsc-secret-card", reason: "rejected", detail: "Price too low" },
        { reason: "notOnSheet", platformCardId: "bsc-secret-card-2" },
      ],
      problemsTotal: 2,
    });
    const p = await bsc(s);
    expect(p).toMatchObject({ listing: true, running: null, scheduledAt: 4000, lastDrainAt: 3000 });
    expect(p.queued).toEqual({
      cards: [
        { cardId: s.fx.gold1, cardNo: "1", cardLabel: "Dwight Gooden", variantId: s.fx.goldId, setLabel: GOLD_LABEL, changedAt: 100 },
        {
          cardId: s.fx.strawberry2,
          cardNo: "2",
          cardLabel: "Darryl Strawberry",
          variantId: s.fx.baseId,
          setLabel: BASE_LABEL,
          changedAt: 200,
        },
      ],
      more: false,
    });
    expect(p.sets).toEqual([
      {
        variantId: s.fx.baseId,
        setLabel: BASE_LABEL,
        status: "idle",
        lastRunAt: 900,
        lastSuccessAt: 900,
        counts: { listed: 3, pushed: 2, zeroed: 1, skipped: 1 },
        problemsTotal: 2,
        problems: [
          { cardNo: "1", cardLabel: "Dwight Gooden", reason: "rejected", detail: "Price too low" },
          { reason: "notOnSheet" },
        ],
      },
    ]);
    const json = JSON.stringify(p);
    for (const secret of ["lease-secret", "bsc-secret-card", "seller-secret-acct", "bsc-ref-"]) {
      expect(json).not.toContain(secret);
    }
    // Each collector sees their own queue and sets only.
    const theirs = await bsc(s, "them");
    expect(theirs.queued.cards.map((c) => c.cardId)).toEqual([s.fx.gooden1]);
    expect(theirs.sets).toEqual([]);
  });

  test("running: from the drain lease, and the set whose run holds its lease", async () => {
    const s = await setup();
    const expires = Date.now() + 5 * 60_000;
    await listOn(s, ME.subject, { drainLeaseToken: "drain-secret", drainLeaseExpiresAt: expires });
    expect((await bsc(s)).running).toEqual({ startedAt: expires - DRAIN_LEASE_MS });
    await record(s, s.fx.goldId, {
      status: "running",
      lastRunAt: 1000,
      leaseToken: "lease-secret",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const p = await bsc(s);
    expect(p.running).toEqual({ startedAt: expires - DRAIN_LEASE_MS, variantId: s.fx.goldId, setLabel: GOLD_LABEL });
    expect(p.sets.map((x) => x.status)).toEqual(["running"]);
    expect(JSON.stringify(p)).not.toContain("drain-secret");
  });

  test("a lapsed drain lease is not running; a run whose lease lapsed reads as its last result", async () => {
    const s = await setup();
    await listOn(s, ME.subject, { drainLeaseToken: "drain", drainLeaseExpiresAt: Date.now() - 1 });
    await record(s, s.fx.baseId, { status: "running", lastRunAt: 20, leaseExpiresAt: Date.now() - 1 });
    await record(s, s.fx.goldId, {
      status: "running",
      lastRunAt: 10,
      leaseExpiresAt: Date.now() - 1,
      lastError: "It stopped.",
    });
    const p = await bsc(s);
    expect(p.running).toBeNull();
    expect(p.sets.map((x) => [x.variantId, x.status])).toEqual([
      [s.fx.baseId, "idle"],
      [s.fx.goldId, "error"],
    ]);
  });

  test("a running set record alone (no drain lease) still reads as running since its run began", async () => {
    const s = await setup();
    await listOn(s);
    await record(s, s.fx.baseId, { status: "running", lastRunAt: 1234, leaseExpiresAt: Date.now() + 60_000 });
    expect((await bsc(s)).running).toEqual({ startedAt: 1234, variantId: s.fx.baseId, setLabel: BASE_LABEL });
  });

  test("a set gone from NB reads as such; a queued card gone from the catalog keeps its id only", async () => {
    const s = await setup();
    await listOn(s);
    await record(s, s.fx.goldId, { lastRunAt: 5 });
    await queue(s, s.fx.strawberry2, s.fx.baseId, 1);
    await s.t.run(async (ctx) => {
      await ctx.db.delete(s.fx.goldId);
      await ctx.db.delete(s.fx.strawberry2);
    });
    const p = await bsc(s);
    expect(p.sets[0].setLabel).toBe(MISSING_SET_LABEL);
    expect(p.queued.cards).toEqual([
      { cardId: s.fx.strawberry2, variantId: s.fx.baseId, setLabel: BASE_LABEL, changedAt: 1 },
    ]);
  });

  test("caps: queued cards and sets at their limits with `more`, the latest run first, five problems a set", async () => {
    const s = await setup();
    await listOn(s);
    await s.t.run(async (ctx) => {
      for (let i = 0; i < STATUS_CAPS.queued + 1; i += 1) {
        await ctx.db.insert("listingOutbox", {
          ownerId: ME.subject,
          platform: "bsc",
          cardId: s.fx.gooden1,
          variantId: s.fx.baseId,
          seq: 1,
          changedAt: 10_000 - i,
        });
      }
      for (let i = 0; i < STATUS_CAPS.sets + 1; i += 1) {
        await ctx.db.insert("marketplaceListingSyncs", {
          ownerId: ME.subject,
          variantId: s.fx.baseId,
          platform: "bsc",
          status: "idle",
          lastRunAt: i,
          problems: Array.from({ length: 8 }, () => ({ cardId: s.fx.gooden1, reason: "noPrice" as const })),
          problemsTotal: 12,
          conditionsPushed: [],
          lastUpdated: 1,
        });
      }
    });
    const p = await bsc(s);
    expect(p.queued.cards).toHaveLength(STATUS_CAPS.queued);
    expect(p.queued.more).toBe(true);
    const changed = p.queued.cards.map((c) => c.changedAt);
    expect(changed).toEqual([...changed].sort((a, b) => a - b));
    expect(changed[0]).toBe(10_000 - STATUS_CAPS.queued);
    expect(p.sets).toHaveLength(STATUS_CAPS.sets);
    expect(p.sets[0].lastRunAt).toBe(STATUS_CAPS.sets);
    expect(p.sets.map((x) => x.lastRunAt)).not.toContain(0);
    expect(p.sets.every((x) => x.problems.length === STATUS_CAPS.problemsPerSet && x.problemsTotal === 12)).toBe(true);
    // Card names are read for the first `problemCards` problems; the rest carry the reason alone.
    const named = p.sets.flatMap((x) => x.problems).filter((x) => x.cardNo !== undefined);
    expect(named).toHaveLength(STATUS_CAPS.problemCards);
  });
});

describe("syncSetProblems", () => {
  test("every held-back card of one of my sets, named from NB, no marketplace id", async () => {
    const s = await setup();
    await record(s, s.fx.baseId, {
      problems: [
        ...Array.from({ length: 7 }, () => ({ cardId: s.fx.strawberry2, platformCardId: "bsc-secret", reason: "noPrice" as const })),
        { reason: "sharedLink" as const, detail: "Two cards" },
      ],
      problemsTotal: 9,
    });
    const got = await s.me.query(api.listingSync.syncSetProblems, { variantId: s.fx.baseId, platform: "bsc" });
    expect(got.problemsTotal).toBe(9);
    expect(got.problems).toHaveLength(8);
    expect(got.problems[0]).toEqual({ cardNo: "2", cardLabel: "Darryl Strawberry", reason: "noPrice" });
    expect(got.problems[7]).toEqual({ reason: "sharedLink", detail: "Two cards" });
    expect(JSON.stringify(got)).not.toContain("bsc-secret");
  });

  test("no record, or another collector's: empty", async () => {
    const s = await setup();
    await record(s, s.fx.baseId, { problems: [{ reason: "noPrice" }], problemsTotal: 1 }, THEM.subject);
    expect(await s.me.query(api.listingSync.syncSetProblems, { variantId: s.fx.baseId, platform: "bsc" })).toEqual({
      problems: [],
      problemsTotal: 0,
    });
  });
});

describe("admin Sync status", () => {
  test("refused signed out and for a signed-in collector who is not an admin", async () => {
    const s = await setup();
    for (const caller of [s.t, s.me]) {
      await expect(caller.query(api.listingSync.adminSyncOwners, {})).rejects.toThrow();
      await expect(caller.query(api.listingSync.adminSyncStatus, {})).rejects.toThrow();
      await expect(caller.query(api.listingSync.adminSyncStatus, { ownerId: ME.subject })).rejects.toThrow();
      await expect(
        caller.query(api.listingSync.adminSyncSetProblems, {
          ownerId: THEM.subject,
          variantId: s.fx.baseId,
          platform: "bsc",
        }),
      ).rejects.toThrow();
    }
  });

  test("the owner picker: every collector with a listing row, named by public profile, else the id", async () => {
    const s = await setup();
    await listOn(s, ME.subject);
    await listOn(s, THEM.subject, { listingStartedAt: undefined, dormant: "noCredentials" });
    await listOn(s, "collector_third");
    await s.t.run(async (ctx) => {
      await ctx.db.insert("publicProfiles", { userId: ME.subject, username: "mets86", displayName: "Doc's Cards", createdAt: 0, updatedAt: 0 } as never);
      await ctx.db.insert("publicProfiles", { userId: THEM.subject, username: "kidcards", createdAt: 0, updatedAt: 0 } as never);
    });
    const owners = await s.admin.query(api.listingSync.adminSyncOwners, {});
    expect([...owners].sort((a, b) => a.ownerId.localeCompare(b.ownerId))).toEqual(
      [
        { ownerId: ME.subject, label: "Doc's Cards" },
        { ownerId: THEM.subject, label: "@kidcards" },
        { ownerId: "collector_third", label: "collector_third" },
      ].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    );
  });

  test("one collector: their full status, read-only; their set's problems", async () => {
    const s = await setup();
    await listOn(s, THEM.subject);
    await queue(s, s.fx.gooden1, s.fx.baseId, 5, THEM.subject);
    await record(
      s,
      s.fx.baseId,
      { lastRunAt: 9, problems: [{ cardId: s.fx.gooden1, platformCardId: "bsc-secret", reason: "rejected" }], problemsTotal: 1 },
      THEM.subject,
    );
    const got = await s.admin.query(api.listingSync.adminSyncStatus, { ownerId: THEM.subject });
    expect(got.more).toBe(false);
    expect(got.owners).toHaveLength(1);
    expect(got.owners[0]).toMatchObject({ ownerId: THEM.subject, label: THEM.subject });
    const p = got.owners[0].status.platforms[0];
    expect(p.queued.cards.map((c) => c.cardLabel)).toEqual(["Dwight Gooden"]);
    expect(p.sets[0].problems).toEqual([{ cardNo: "1", cardLabel: "Dwight Gooden", reason: "rejected" }]);
    expect(JSON.stringify(got)).not.toContain("seller-secret-acct");
    expect(JSON.stringify(got)).not.toContain("bsc-secret");
    expect(
      await s.admin.query(api.listingSync.adminSyncSetProblems, {
        ownerId: THEM.subject,
        variantId: s.fx.baseId,
        platform: "bsc",
      }),
    ).toEqual({ problems: [{ cardNo: "1", cardLabel: "Dwight Gooden", reason: "rejected" }], problemsTotal: 1 });
    // Read-only: nothing written.
    expect((await s.t.run((ctx) => ctx.db.query("listingOutbox").collect())).map((r) => r.seq)).toEqual([1]);
  });

  test("every collector: capped by owners (`more`) and by the shorter per-owner lists", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < ADMIN_STATUS_OWNERS + 1; i += 1) {
        await ctx.db.insert("marketplaceListingStates", {
          ownerId: `collector_${String(i).padStart(2, "0")}`,
          platform: "bsc",
          listingStartedAt: 1,
          lastUpdated: 0,
        });
      }
      for (let i = 0; i < ADMIN_ALL_CAPS.queued + 2; i += 1) {
        await ctx.db.insert("listingOutbox", {
          ownerId: "collector_00",
          platform: "bsc",
          cardId: s.fx.gooden1,
          variantId: s.fx.baseId,
          seq: 1,
          changedAt: i,
        });
      }
      for (let i = 0; i < ADMIN_ALL_CAPS.sets + 2; i += 1) {
        await ctx.db.insert("marketplaceListingSyncs", {
          ownerId: "collector_00",
          variantId: s.fx.baseId,
          platform: "bsc",
          status: "idle",
          lastRunAt: i,
          problems: Array.from({ length: 4 }, () => ({ cardId: s.fx.gooden1, reason: "noPrice" as const })),
          conditionsPushed: [],
          lastUpdated: 1,
        });
      }
    });
    const got = await s.admin.query(api.listingSync.adminSyncStatus, {});
    expect(got.owners).toHaveLength(ADMIN_STATUS_OWNERS);
    expect(got.more).toBe(true);
    const first = got.owners.find((o) => o.ownerId === "collector_00");
    const p = first!.status.platforms[0];
    expect(p.queued.cards).toHaveLength(ADMIN_ALL_CAPS.queued);
    expect(p.queued.more).toBe(true);
    expect(p.sets).toHaveLength(ADMIN_ALL_CAPS.sets);
    expect(p.sets.every((x) => x.problems.length === ADMIN_ALL_CAPS.problemsPerSet && x.problemsTotal === 4)).toBe(true);
    // Filtering to that collector shows the full lists.
    const one = await s.admin.query(api.listingSync.adminSyncStatus, { ownerId: "collector_00" });
    expect(one.owners[0].status.platforms[0].sets).toHaveLength(ADMIN_ALL_CAPS.sets + 2);
  });
});
