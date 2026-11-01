/**
 * NEO-370 — the listing gate, end to end in convex-test: a collector set up
 * for syncing adds to a listed box only with a price and a condition, and
 * everyone else sees no change.
 *
 *   - when it applies: a listing state row that pushes counts, on a platform
 *     NB has not paused, and a home that lists (a box not set in-person);
 *     never with no row, the E2E test marker, a paused platform, a binder or
 *     an in-person box;
 *   - the price: the copy's own, else the common price for its variant (the
 *     drain's rule, `lib/listingReadiness.ts`);
 *   - the writers it holds: Have / a range / a line item into a box, a quick
 *     count that raises a box's number (never one that lowers it), and a
 *     photo intake run into a listed box;
 *   - `forHome`, the screens' subscribed read.
 *
 * The condition half is pinned in `lib/listingReadiness.test.ts`: since
 * NEO-380 every raw add takes the collector's default condition, so no
 * writer here can send a raw copy without one.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { PAUSED_PLATFORMS_ENV } from "./lib/marketplacePause";
import { LISTING_GATE_ERROR, listingGateMessage } from "./listingGate";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_370_gate" };
const THEM = { subject: "collector_them_370_gate" };
const JOB = "job-gate-1";

let harnesses: Array<ReturnType<typeof convexTest>> = [];
afterEach(async () => {
  for (const t of harnesses) await drainScheduled(t);
  harnesses = [];
});

async function setup() {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  await me.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" })).containerId;
  const binder = (await me.mutation(api.collectionContainers.create, { kind: "binder", name: "PC" })).containerId;
  const inPerson = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Table box" }))
    .containerId;
  await t.run((ctx) => ctx.db.patch(inPerson, { listedOnMarketplaces: false }));
  await t.run((ctx) =>
    ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: ME.subject,
      objectPath: `placeholders/${ME.subject}/${JOB}/`,
      createdAt: 0,
      mode: "stream",
      status: "collecting",
    }),
  );
  return { t, fx, me, them: t.withIdentity(THEM), box, binder, inPerson };
}
type S = Awaited<ReturnType<typeof setup>>;

/** BSC syncing for ME: the state row a saved sign-in stamps. */
const syncOn = (s: S, extra: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId: ME.subject,
      platform: "bsc",
      listingStartedAt: 1,
      lastUpdated: 0,
      ...extra,
    }),
  );

const priceBase = (s: S, priceCents = 25) =>
  s.t.run((ctx) =>
    ctx.db.insert("variantCommonPrices", { ownerId: ME.subject, variantId: s.fx.baseId, priceCents, lastUpdated: 0 }),
  );

async function paused(body: () => Promise<void>) {
  const before = process.env[PAUSED_PLATFORMS_ENV];
  process.env[PAUSED_PLATFORMS_ENV] = "buysportscards";
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env[PAUSED_PLATFORMS_ENV];
    else process.env[PAUSED_PLATFORMS_ENV] = before;
  }
}

const copies = (s: S) => s.t.run((ctx) => ctx.db.query("collectionCopies").collect());

const gateOf = (s: S, homeId: Id<"collectionContainers"> | string | undefined, variantId?: string) =>
  s.me.query(api.listingGate.forHome, {
    ...(homeId !== undefined ? { homeId } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
  });

const raise = (s: S, homeId: Id<"collectionContainers">, quantity = 1) =>
  s.me.mutation(api.collectionInventory.setBoxQuantity, {
    cardId: s.fx.gooden1,
    boxId: homeId,
    quantity,
  });

/** The refusal as the screens show it. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (error) {
    return (error as { data: { code: string; message: string } }).data;
  }
  throw new Error("expected a refusal");
}

describe("when the gate applies", () => {
  test("no listing state: nothing applies, and a box takes cards with no price", async () => {
    const s = await setup();
    expect(await gateOf(s, s.box, s.fx.baseId)).toEqual({ syncing: false, applies: false, commonPriceCents: null });
    await raise(s, s.box, 2);
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2, homeId: s.box });
    expect((await copies(s)).reduce((n, c) => n + c.quantity, 0)).toBe(3);
  });

  test("syncing into a listed box: applies, and the common price is read for the variant", async () => {
    const s = await setup();
    await syncOn(s);
    expect(await gateOf(s, s.box, s.fx.baseId)).toEqual({ syncing: true, applies: true, commonPriceCents: null });
    await priceBase(s, 40);
    expect(await gateOf(s, s.box, s.fx.baseId)).toEqual({ syncing: true, applies: true, commonPriceCents: 40 });
  });

  test("the E2E test marker holds the owner off: nothing applies", async () => {
    const s = await setup();
    await syncOn(s, { testListingOff: true });
    expect(await gateOf(s, s.box, s.fx.baseId)).toMatchObject({ syncing: false, applies: false });
    await raise(s, s.box);
  });

  test("a dormant row (a removed sign-in, a seller conflict) is not syncing", async () => {
    const s = await setup();
    await syncOn(s, { dormant: "noCredentials" });
    expect(await gateOf(s, s.box, s.fx.baseId)).toMatchObject({ syncing: false, applies: false });
  });

  test("a platform NB paused for everyone: nothing applies, and adds go through", async () => {
    const s = await setup();
    await syncOn(s);
    await paused(async () => {
      expect(await gateOf(s, s.box, s.fx.baseId)).toMatchObject({ syncing: false, applies: false });
      await raise(s, s.box);
    });
    expect(await copies(s)).toHaveLength(1);
  });

  test("a binder and an in-person box never list: syncing, but no gate", async () => {
    const s = await setup();
    await syncOn(s);
    expect(await gateOf(s, s.binder, s.fx.baseId)).toEqual({ syncing: true, applies: false, commonPriceCents: null });
    expect(await gateOf(s, s.inPerson, s.fx.baseId)).toEqual({ syncing: true, applies: false, commonPriceCents: null });
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: s.binder });
    await raise(s, s.inPerson, 3);
    expect((await copies(s)).reduce((n, c) => n + c.quantity, 0)).toBe(4);
  });

  test("no home, a junk id, or someone else's box reads as no gate", async () => {
    const s = await setup();
    await syncOn(s);
    const theirs = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: THEM.subject, kind: "box", name: "Theirs", lastUpdated: 0 }),
    );
    for (const homeId of [undefined, "not-an-id", theirs]) {
      expect(await gateOf(s, homeId, s.fx.baseId)).toEqual({ syncing: true, applies: false, commonPriceCents: null });
    }
  });

  test("forHome is signed-in only", async () => {
    const s = await setup();
    await expect(s.t.query(api.listingGate.forHome, {})).rejects.toThrow(/Not authenticated/);
  });
});

describe("the writers it holds", () => {
  test("a quick count raise into a listed box needs the variant's common price; a lower never does", async () => {
    const s = await setup();
    await raise(s, s.box, 2); // stocked before the collector synced
    await syncOn(s);
    const refused = await refusal(raise(s, s.box, 3));
    expect(refused).toEqual({
      code: LISTING_GATE_ERROR,
      message: listingGateMessage("Show box", { needsPrice: true, needsCondition: false }),
    });
    expect(refused.message).toBe(
      "Show box sells on your marketplaces, so cards going in need a price first. Set a common price for the checklist, or give the card a price of its own.",
    );
    // Nothing was written.
    expect((await copies(s)).map((c) => c.quantity)).toEqual([2]);
    // Taking cards out always works.
    await raise(s, s.box, 1);
    await priceBase(s);
    await raise(s, s.box, 5);
    expect((await copies(s)).reduce((n, c) => n + c.quantity, 0)).toBe(5);
  });

  test("a range into a listed box is refused whole, writing nothing", async () => {
    const s = await setup();
    await syncOn(s);
    await expect(
      s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.gooden1, s.fx.strawberry2], homeId: s.box }),
    ).rejects.toThrow(/sells on your marketplaces/);
    expect(await copies(s)).toEqual([]);
    await priceBase(s);
    await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.gooden1, s.fx.strawberry2], homeId: s.box });
    expect(await copies(s)).toHaveLength(2);
  });

  test("the price is the copy's own, else the common price: a line with its own price needs no common one", async () => {
    const s = await setup();
    await syncOn(s);
    await expect(
      s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: s.box } }),
    ).rejects.toThrow(/need a price/);
    await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 1, homeId: s.box, minPriceCents: 0 },
    });
    expect((await copies(s))[0]).toMatchObject({ minPriceCents: 0, condition: "Excellent" });
  });

  test("a common price on another variant does not count", async () => {
    const s = await setup();
    await syncOn(s);
    await s.t.run((ctx) =>
      ctx.db.insert("variantCommonPrices", {
        ownerId: ME.subject,
        variantId: s.fx.futureStarsId,
        priceCents: 25,
        lastUpdated: 0,
      }),
    );
    await expect(raise(s, s.box)).rejects.toThrow(/need a price/);
  });

  test("a graded copy is never held here (slabs list another way)", async () => {
    const s = await setup();
    await syncOn(s);
    await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 1, homeId: s.box, grading: { grader: "PSA", grade: "9" } },
    });
    expect(await copies(s)).toHaveLength(1);
  });

  test("a photo intake run into a listed box starts with a price: its own, or the picked set's common price", async () => {
    const s = await setup();
    await syncOn(s);
    await expect(
      s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.box, variantId: s.fx.baseId }),
    ).rejects.toThrow(/need a price/);
    // No set picked yet: only the run's own price can answer.
    await expect(s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.box })).rejects.toThrow(
      /need a price/,
    );
    const runId = await s.me.mutation(api.intakeRuns.createIntakeRun, {
      jobId: JOB,
      homeId: s.box,
      defaults: { minPriceCents: 50 },
    });
    const run = await s.me.query(api.intakeRuns.getIntakeRun, { runId });
    expect(run?.defaults).toMatchObject({ minPriceCents: 50 });
  });

  test("a photo intake run picks up the set's common price", async () => {
    const s = await setup();
    await syncOn(s);
    await priceBase(s);
    await s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.box, variantId: s.fx.baseId });
  });

  test("a photo intake run into a binder or an in-person box needs no price", async () => {
    const s = await setup();
    await syncOn(s);
    await s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.inPerson, variantId: s.fx.baseId });
  });
});
