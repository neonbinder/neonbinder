/**
 * NEO-359 — the Want List (`convex/collectionWants.ts`): one want per card,
 * re-scope, the 2,000 cap, the card-delete sweep (never a refusal, a
 * scheduled continuation past 50), the test-state reset, caller isolation.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { MAX_WANTS } from "./collection";
import { WANT_SWEEP_BATCH } from "./cardRowDelete";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const ADMIN = { subject: "user_admin", role: "admin" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM), admin: t.withIdentity(ADMIN) };
}
type S = Awaited<ReturnType<typeof setup>>;

const wantRows = (s: S, ownerId?: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("collectionWants").collect()).filter((w) => !ownerId || w.ownerId === ownerId),
  );
const mk = (s: S, kind: "binder" | "box", name: string, who = s.me) =>
  who.mutation(api.collectionContainers.create, { kind, name }).then((r) => r.containerId);

describe("auth", () => {
  test("every want function refuses a signed-out caller", async () => {
    const { t, fx } = await setup();
    await expect(t.query(api.collectionWants.list, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.collectionWants.set, { cardId: fx.gooden1, on: true })).rejects.toThrow(/Not authenticated/);
    expect(await t.run(async (ctx) => ctx.db.query("collectionWants").collect())).toEqual([]);
  });
});

describe("set", () => {
  test("wants a card once, idempotently, and stops wanting it", async () => {
    const s = await setup();
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true })).toEqual({ changed: true });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true })).toEqual({ changed: false });
    expect(await wantRows(s)).toHaveLength(1);
    expect(await s.me.query(api.collectionWants.list, {})).toEqual([
      expect.objectContaining({ cardId: s.fx.gooden1 }),
    ]);
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: false })).toEqual({ changed: true });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: false })).toEqual({ changed: false });
    expect(await wantRows(s)).toHaveLength(0);
  });

  test("a different binderId re-scopes the one want; the same one changes nothing; none un-scopes it", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "A");
    const b = await mk(s, "box", "B");
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true })).toEqual({ changed: false });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: b, on: true })).toEqual({ changed: true });
    let rows = await wantRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].binderId).toBe(b);
    expect(await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true })).toEqual({ changed: true });
    rows = await wantRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].binderId).toBeUndefined();
  });

  test("turning off ignores the binderId named and removes the want", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "A");
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: false });
    expect(await wantRows(s)).toHaveLength(0);
  });

  test("refuses a foreign binder, a system container and a gone binder; writes nothing", async () => {
    const s = await setup();
    const sys = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const theirs = await mk(s, "binder", "T", s.them);
    const gone = await mk(s, "binder", "G");
    await s.me.mutation(api.collectionContainers.remove, { containerId: gone });
    const want = (binderId: Id<"collectionContainers">) =>
      s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId, on: true });
    await expect(want(theirs)).rejects.toThrow(/isn't in your collection/);
    await expect(want(gone)).rejects.toThrow(/isn't in your collection/);
    for (const id of [sys.mainId, sys.wantId, sys.tradeId]) await expect(want(id)).rejects.toThrow(/your own binders or boxes/);
    expect(await wantRows(s)).toHaveLength(0);
  });

  test("a foreign binder is refused even when re-scoping an existing want", async () => {
    const s = await setup();
    const theirs = await mk(s, "binder", "T", s.them);
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    await expect(
      s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: theirs, on: true }),
    ).rejects.toThrow(/isn't in your collection/);
    expect((await wantRows(s))[0].binderId).toBeUndefined();
  });

  test("refuses a card that left the catalog", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => ctx.db.delete(s.fx.strawberry2));
    await expect(s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true })).rejects.toThrow(/isn't in the catalog anymore/);
    expect(await wantRows(s)).toHaveLength(0);
  });

  test("a want needs no Want List row, and moves its count only when the row exists", async () => {
    const s = await setup();
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    expect(await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect())).toEqual([]);
    const { wantId } = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    const count = () => s.t.run(async (ctx) => (await ctx.db.get(wantId))!.count);
    expect(await count()).toEqual({ copies: 1, lines: 1 });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: true });
    expect(await count()).toEqual({ copies: 3, lines: 3 });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: false });
    // A re-scope does not move it.
    const a = await mk(s, "binder", "A");
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, binderId: a, on: true });
    expect(await count()).toEqual({ copies: 2, lines: 2 });
  });

  test("a drifted Want List count is recounted by hand when it would go negative", async () => {
    const s = await setup();
    const { wantId } = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true });
    await s.t.run(async (ctx) => ctx.db.patch(wantId, { count: { copies: 0, lines: 0 } }));
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: false });
    expect((await s.t.run(async (ctx) => ctx.db.get(wantId)))!.count).toEqual({ copies: 1, lines: 1 });
  });
});

describe("the 2,000 cap", () => {
  async function seedFull(s: S, withRow: boolean) {
    const ids = await s.t.run(async (ctx) => {
      const out: Array<Id<"cardChecklist">> = [];
      for (let i = 0; i < MAX_WANTS + 1; i++) {
        out.push(
          await insertTestCard(ctx, {
            selectorOptionId: s.fx.baseId, cardNumber: `W${i}`, cardName: `W${i}`,
            playerIds: [], platformData: {}, isCustom: false, sortOrder: 500 + i, lastUpdated: 0,
          } as never),
        );
      }
      for (const cardId of out.slice(0, MAX_WANTS)) {
        await ctx.db.insert("collectionWants", { ownerId: ME.subject, cardId, lastUpdated: 0 });
      }
      if (withRow) {
        await ctx.db.insert("collectionContainers", {
          ownerId: ME.subject, kind: "binder", system: "want", name: "Want List",
          count: { copies: MAX_WANTS, lines: MAX_WANTS }, lastUpdated: 0,
        });
      }
      return out;
    });
    return ids;
  }

  test.each([false, true])("refuses the 2,001st want (Want List row present: %s), still re-scopes and removes", async (withRow) => {
    const s = await setup();
    const ids = await seedFull(s, withRow);
    await expect(s.me.mutation(api.collectionWants.set, { cardId: ids[MAX_WANTS], on: true })).rejects.toThrow(/full at 2,000/);
    expect(await wantRows(s)).toHaveLength(MAX_WANTS);
    const a = await mk(s, "binder", "A");
    expect(await s.me.mutation(api.collectionWants.set, { cardId: ids[0], binderId: a, on: true })).toEqual({ changed: true });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: ids[1], on: false })).toEqual({ changed: true });
    expect(await s.me.mutation(api.collectionWants.set, { cardId: ids[MAX_WANTS], on: true })).toEqual({ changed: true });
    expect(await wantRows(s)).toHaveLength(MAX_WANTS);
  });

  test("the cap is per collector", async () => {
    const s = await setup();
    const ids = await seedFull(s, false);
    expect(await s.them.mutation(api.collectionWants.set, { cardId: ids[0], on: true })).toEqual({ changed: true });
  });
});

describe("a deleted card takes its wants with it", () => {
  const owners = (n: number) => Array.from({ length: n }, (_, i) => `owner_${i}`);
  async function wantOnCard(s: S, cardId: Id<"cardChecklist">, ownerIds: string[]) {
    await s.t.run(async (ctx) => {
      for (const ownerId of ownerIds) await ctx.db.insert("collectionWants", { ownerId, cardId, lastUpdated: 0 });
    });
  }
  const scheduled = (s: S) =>
    s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name));

  test("an admin card delete removes wants and moves each owner's Want List count; never refuses", async () => {
    const s = await setup();
    const { wantId } = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.futureStar, on: true });
    await s.them.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: true }); // them: no row
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 });
    expect((await wantRows(s)).map((w) => w.cardId)).toEqual([s.fx.futureStar]);
    expect((await s.t.run(async (ctx) => ctx.db.get(wantId)))!.count).toEqual({ copies: 1, lines: 1 });
    expect(await scheduled(s)).toEqual([]);
  });

  test("a drifted Want List count clears to uncounted, and the next want recounts it", async () => {
    const s = await setup();
    const { wantId } = await s.me.mutation(api.collectionContainers.ensureSystem, {});
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: true });
    await s.t.run(async (ctx) => ctx.db.patch(wantId, { count: { copies: 0, lines: 0 } }));
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 });
    expect((await s.t.run(async (ctx) => ctx.db.get(wantId)))!.count).toBeUndefined();
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.futureStar, on: true });
    // The next want recounted it in place; the last sweep then lands on zero.
    expect((await s.t.run(async (ctx) => ctx.db.get(wantId)))!.count).toEqual({ copies: 1, lines: 1 });
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.futureStar });
    expect((await s.t.run(async (ctx) => ctx.db.get(wantId)))!.count).toEqual({ copies: 0, lines: 0 });
  });

  test("a card a collector OWNS is still refused, and its wants survive the refusal", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gold1 });
    await s.them.mutation(api.collectionWants.set, { cardId: s.fx.gold1, on: true });
    await expect(s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 })).rejects.toThrow();
    expect(await wantRows(s)).toHaveLength(1);
    expect(await s.t.run(async (ctx) => ctx.db.get(s.fx.gold1))).not.toBeNull();
  });

  test("exactly the sweep batch is removed in one transaction, no continuation", async () => {
    const s = await setup();
    await wantOnCard(s, s.fx.gold1, owners(WANT_SWEEP_BATCH));
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 });
    expect(await wantRows(s)).toHaveLength(0);
    expect(await scheduled(s)).toEqual([]);
  });

  test("past the batch the rest is swept by a scheduled continuation that reschedules itself", async () => {
    const s = await setup();
    const n = WANT_SWEEP_BATCH * 2 + 7;
    await wantOnCard(s, s.fx.gold1, owners(n));
    await wantOnCard(s, s.fx.futureStar, ["owner_0"]);
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 });
    expect(await wantRows(s)).toHaveLength(n - WANT_SWEEP_BATCH + 1);
    expect(await scheduled(s)).toHaveLength(1);
    await drainScheduled(s.t);
    const left = await wantRows(s);
    expect(left.map((w) => w.cardId)).toEqual([s.fx.futureStar]);
  });

  test("the continuation moves the Want List count of owners swept after the first batch", async () => {
    const s = await setup();
    const many = owners(WANT_SWEEP_BATCH + 5);
    await wantOnCard(s, s.fx.gold1, many);
    await s.t.run(async (ctx) => {
      for (const ownerId of many) {
        await ctx.db.insert("collectionContainers", {
          ownerId, kind: "binder", system: "want", name: "Want List", count: { copies: 1, lines: 1 }, lastUpdated: 0,
        });
      }
    });
    await s.admin.mutation(api.selectorOptions.deleteCard, { id: s.fx.gold1 });
    await drainScheduled(s.t);
    const rows = await s.t.run(async (ctx) => ctx.db.query("collectionContainers").collect());
    expect(rows).toHaveLength(many.length);
    expect(rows.every((r) => r.count?.lines === 0)).toBe(true);
  });
});

describe("resetMyTestState", () => {
  beforeEach(() => {
    process.env.TESTING_RESET_SECRET = "test-enabled";
  });
  afterEach(() => {
    delete process.env.TESTING_RESET_SECRET;
  });

  test("drains the caller's wants (scoped ones too) and leaves other collectors' wants", async () => {
    const s = await setup();
    const a = await mk(s, "binder", "A");
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: a, on: true });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true });
    await s.them.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    const result = await s.me.mutation(api.testing.resetMyTestState, {});
    expect(result.collectionWants).toBe(2);
    expect(await wantRows(s, ME.subject)).toEqual([]);
    expect(await wantRows(s, THEM.subject)).toHaveLength(1);
  });
});

describe("caller isolation", () => {
  test("list shows only my wants; another collector's set never touches mine", async () => {
    const s = await setup();
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    await s.them.mutation(api.collectionWants.set, { cardId: s.fx.strawberry2, on: true });
    expect((await s.me.query(api.collectionWants.list, {})).map((w) => w.cardId)).toEqual([s.fx.gooden1]);
    expect((await s.them.query(api.collectionWants.list, {})).map((w) => w.cardId)).toEqual([s.fx.strawberry2]);
    // Them turning off a card only they do not want changes nothing for me.
    expect(await s.them.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: false })).toEqual({ changed: false });
    expect(await wantRows(s, ME.subject)).toHaveLength(1);
  });
});
