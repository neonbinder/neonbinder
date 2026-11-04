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
 *     count that raises a box's number (never one that lowers it), an undo
 *     that restores or raises one (never one that only lowers), a removed
 *     line put back, a move into a listed box from a home that does not list,
 *     and a photo intake run into a listed box (whose Min price is checked);
 *   - `forHome`, the screens' subscribed read.
 *
 * The condition half is pinned in `lib/listingReadiness.test.ts`: since
 * NEO-380 every raw add takes the collector's default condition, so no
 * writer here can send a raw copy without one.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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

describe("a condition is never what a priced add lacks (NEO-380)", () => {
  // Every raw add takes the collector's default condition (Excellent until they
  // set another), so on the quick-count and intake doors only the PRICE can be
  // missing: a refusal names a price alone, and a priced add always passes.
  const PRICE_ONLY = listingGateMessage("Show box", { needsPrice: true, needsCondition: false });

  test("a quick count with no price is refused for the price alone, never the condition", async () => {
    const s = await setup();
    await syncOn(s);
    const refused = await refusal(raise(s, s.box, 1));
    expect(refused).toEqual({ code: LISTING_GATE_ERROR, message: PRICE_ONLY });
    expect(refused.message).not.toMatch(/condition/);
  });

  test("a priced quick count passes and writes the collector's default condition, whichever it is", async () => {
    const s = await setup();
    await syncOn(s);
    await priceBase(s);
    await raise(s, s.box, 1);
    expect((await copies(s)).map((c) => c.condition)).toEqual(["Excellent"]);
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Near Mint" });
    await s.me.mutation(api.collectionInventory.setBoxQuantity, {
      cardId: s.fx.strawberry2,
      boxId: s.box,
      quantity: 1,
    });
    expect((await copies(s)).map((c) => c.condition).sort()).toEqual(["Excellent", "Near Mint"]);
  });

  test("a photo intake run with no price is refused for the price alone, never the condition", async () => {
    const s = await setup();
    await syncOn(s);
    const refused = await refusal(
      s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.box, variantId: s.fx.baseId }),
    );
    expect(refused).toEqual({ code: LISTING_GATE_ERROR, message: PRICE_ONLY });
    expect(refused.message).not.toMatch(/condition/);
    expect(await s.t.run((ctx) => ctx.db.query("intakeRuns").collect())).toEqual([]);
  });

  test("a priced photo intake run passes with no condition of its own: the collector's default stands in", async () => {
    const s = await setup();
    await syncOn(s);
    await s.me.mutation(api.userProfile.setDefaultCondition, { condition: "Near Mint" });
    const runId = await s.me.mutation(api.intakeRuns.createIntakeRun, {
      jobId: JOB,
      homeId: s.box,
      defaults: { minPriceCents: 50 },
    });
    expect(await s.me.query(api.intakeRuns.getIntakeRun, { runId })).not.toBeNull();
  });
});

describe("the other add doors (security review)", () => {
  const codeOf = async (p: Promise<unknown>) => (await refusal(p)).code;

  test("a removed line put back (restoreCopy) is an add: held into a listed box, free into a binder", async () => {
    const s = await setup();
    await raise(s, s.box, 2); // stocked before the collector synced
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2, homeId: s.binder });
    await syncOn(s);
    const [inBox, inBinder] = await Promise.all([
      copies(s).then((all) => all.find((c) => c.homeId === s.box)!),
      copies(s).then((all) => all.find((c) => c.homeId === s.binder)!),
    ]);
    const boxGone = await s.me.mutation(api.collection.removeCopy, { copyId: inBox._id });
    const binderGone = await s.me.mutation(api.collection.removeCopy, { copyId: inBinder._id });
    expect(await codeOf(s.me.mutation(api.collection.restoreCopy, boxGone.removed))).toBe(LISTING_GATE_ERROR);
    await s.me.mutation(api.collection.restoreCopy, binderGone.removed);
    expect((await copies(s)).map((c) => c.homeId)).toEqual([s.binder]);
    await priceBase(s);
    await s.me.mutation(api.collection.restoreCopy, boxGone.removed);
    expect(await copies(s)).toHaveLength(2);
  });

  test("an undo that raises a box's count is held; one that only lowers never is", async () => {
    const s = await setup();
    await raise(s, s.box, 2);
    await syncOn(s);
    // Lowering 2 → 1 goes through; its undo (1 → 2) is a raise, held.
    const lowered = await raise(s, s.box, 1);
    expect(await codeOf(s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: lowered.inverse }))).toBe(
      LISTING_GATE_ERROR,
    );
    expect((await copies(s)).map((c) => c.quantity)).toEqual([1]);
    // A forged inverse that restores a line is held the same way.
    const forged = { cardId: s.fx.gooden1, boxId: s.box, steps: [{ op: "restore" as const, quantity: 5 }] };
    expect(await codeOf(s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: forged }))).toBe(
      LISTING_GATE_ERROR,
    );
    // Priced, a raise goes through; with the price gone again, its undo (a lower) still does.
    await priceBase(s);
    const raised = await raise(s, s.box, 3);
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query("variantCommonPrices").collect()) await ctx.db.delete(row._id);
    });
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: raised.inverse });
    expect((await copies(s)).map((c) => c.quantity)).toEqual([1]);
  });

  test("NEO-431: a line with photos obeys the gate as any other: a raise and the Undo that puts it back are held, a count to 0 never is", async () => {
    const s = await setup();
    await raise(s, s.box, 1);
    const [line] = await copies(s);
    const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId: line._id,
      side: "front",
      contentType: "image/jpeg",
      imageBytes: 1,
      thumbBytes: 1,
    });
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
    await syncOn(s);
    expect(await codeOf(raise(s, s.box, 2))).toBe(LISTING_GATE_ERROR);
    expect((await copies(s)).map((c) => c.quantity)).toEqual([1]);
    const zero = await raise(s, s.box, 0);
    expect(await copies(s)).toEqual([]);
    // Held: nothing comes back, and the photo keeps waiting for a later Undo.
    expect(await codeOf(s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: zero.inverse }))).toBe(
      LISTING_GATE_ERROR,
    );
    expect(await copies(s)).toEqual([]);
    expect((await s.t.run((ctx) => ctx.db.get(photoId)))?.status).toBe("detached");
    await priceBase(s);
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: zero.inverse });
    expect((await copies(s)).map((c) => [c.quantity, c.hasPhotos])).toEqual([[1, true]]);
    expect((await s.t.run((ctx) => ctx.db.get(photoId)))?.status).toBe("live");
  });

  test("a move INTO a listed box from a home that does not list is held; graded, out, and box to box are not", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: s.binder });
    await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.strawberry2,
      details: { quantity: 1, homeId: s.inPerson, grading: { grader: "PSA", grade: "9" } },
    });
    await raise(s, s.box, 1); // a raw card already in the listed box, stocked before syncing
    const other = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Back stock" })).containerId;
    await syncOn(s);
    const all = await copies(s);
    const raw = all.find((c) => c.homeId === s.binder)!;
    const slab = all.find((c) => c.homeId === s.inPerson)!;
    const boxed = all.find((c) => c.homeId === s.box)!;
    const refused = await refusal(s.me.mutation(api.collection.moveCopy, { copyId: raw._id, toHomeId: s.box }));
    expect(refused).toEqual({
      code: LISTING_GATE_ERROR,
      message: listingGateMessage("Show box", { needsPrice: true, needsCondition: false }),
    });
    // A slab is never held; a card already listed moves between listed boxes; taking one out always works.
    await s.me.mutation(api.collection.moveCopy, { copyId: slab._id, toHomeId: s.box });
    await s.me.mutation(api.collection.moveCopy, { copyId: boxed._id, toHomeId: other });
    const moved = (await copies(s)).find((c) => c.cardId === boxed.cardId && c.homeId === other)!;
    await s.me.mutation(api.collection.moveCopy, { copyId: moved._id, toHomeId: s.binder });
    // With a price of its own, the raw card moves in.
    await s.t.run((ctx) => ctx.db.patch(raw._id, { minPriceCents: 10 }));
    await s.me.mutation(api.collection.moveCopy, { copyId: raw._id, toHomeId: s.box });
    expect((await copies(s)).some((c) => c.cardId === raw.cardId && c.homeId === s.box && c.minPriceCents === 10)).toBe(true);
  });

  test("a photo intake run with a Min price that is not a price is refused at its start", async () => {
    const s = await setup();
    for (const minPriceCents of [1.5, -1, Number.MAX_SAFE_INTEGER]) {
      const refused = await refusal(
        s.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: s.binder, defaults: { minPriceCents } }),
      );
      expect(refused.message).toBe("Minimum price needs to be a dollar amount of zero or more.");
    }
    expect(await s.t.run((ctx) => ctx.db.query("intakeRuns").collect())).toEqual([]);
  });
});
