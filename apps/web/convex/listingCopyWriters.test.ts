/**
 * NEO-370 — the two copy writers that skip `collection.applyCopyChanges` and
 * so queue listing work themselves:
 *
 *   1. an operator's card move (`setShapeMove.moveCards` and its
 *      `repointMovedCardCopies` chain) hands the re-pointed copies to
 *      `queueMovedCopyListings`, which queues BOTH variants for every owner
 *      who lists and holds the card in a box: the card at its new variant,
 *      and the old variant through a card still in it (or, when none is
 *      left, the moved card's own row at the old variant, which the drainer
 *      re-points after syncing it);
 *   2. the armed condition backfill (`backfillCopyCondition.run`) queues the
 *      box copies it gives a condition, for owners who list.
 *
 * Owners who list nowhere, and binder copies, queue nothing. The drain itself
 * is scheduled a minute out and never runs here: each test drains the
 * `runAfter(0)` hand-offs and cancels the delayed drain.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { moveCards, MOVED_LISTING_PAGE } from "./setShapeMove";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_370_writers" };
const THEM = { subject: "collector_them_370_writers" };
const NOW = 1_700_000_000_000;

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const them = t.withIdentity(THEM);
  const mine = await me.mutation(api.collectionContainers.ensureSystem, {});
  await them.mutation(api.collectionContainers.ensureSystem, {});
  const box = (await me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" })).containerId;
  const theirBox = (await them.mutation(api.collectionContainers.create, { kind: "box", name: "Their box" }))
    .containerId;
  return { t, fx, me, them, box, theirBox, main: mine.mainId as Id<"collectionContainers"> };
}
type S = Awaited<ReturnType<typeof setup>>;

const listOn = (s: S, owner = ME.subject) =>
  s.t.run((ctx) => ctx.db.insert("marketplaceListingStates", { ownerId: owner, platform: "bsc", lastUpdated: 0 }));
const outbox = (s: S) => s.t.run((ctx) => ctx.db.query("listingOutbox").collect());
const rowsOf = async (s: S) =>
  (await outbox(s)).map((r) => ({ ownerId: r.ownerId, cardId: r.cardId, variantId: r.variantId }));
async function drains(s: S) {
  const rows = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.name.includes("drainOwner") && r.state.kind === "pending");
}

/** A copy written straight to the table (no hook), the way a stored one sits. */
function copy(
  s: S,
  cardId: Id<"cardChecklist">,
  homeId: Id<"collectionContainers">,
  extra: { ownerId?: string; condition?: "Excellent" } = { condition: "Excellent" },
) {
  return s.t.run(async (ctx) => {
    const card = await ctx.db.get(cardId);
    return ctx.db.insert("collectionCopies", {
      ownerId: extra.ownerId ?? ME.subject,
      cardId,
      variantId: card!.selectorOptionId,
      setId: s.fx.setId,
      homeId,
      quantity: 1,
      ...(extra.condition ? { condition: extra.condition } : {}),
      lastUpdated: 1,
    });
  });
}

const move = (s: S, destId: Id<"selectorOptions">, ids: Array<Id<"cardChecklist">>, after?: () => Promise<void>) =>
  s.t.run(async (ctx) => {
    const cards = await Promise.all(ids.map((id) => ctx.db.get(id)));
    await moveCards(ctx, destId, cards.map((card) => ({ card: card!, slotMap: {} })), NOW);
  }).then(async () => {
    await after?.();
    await drainScheduled(s.t);
  });

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

describe("a card move re-syncs both variants", () => {
  test("the card queues at its new variant, and a card still in the old one queues there", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.gooden1, s.box);
    await copy(s, s.fx.gooden1, s.theirBox, { ownerId: THEM.subject, condition: "Excellent" });

    await move(s, s.fx.goldId, [s.fx.gooden1]);

    const rows = await rowsOf(s);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ ownerId: ME.subject, cardId: s.fx.gooden1, variantId: s.fx.goldId });
    // The old variant's trigger is a card still in it that carries a BSC id.
    const wake = rows.find((r) => r.variantId === s.fx.baseId);
    expect(wake?.ownerId).toBe(ME.subject);
    expect([s.fx.strawberry2, s.fx.gooden1Sliding]).toContain(wake?.cardId);
    // THEM lists nowhere: nothing of theirs.
    expect(rows.every((r) => r.ownerId === ME.subject)).toBe(true);
    expect(await drains(s)).toHaveLength(1);
  });

  test("an old variant left with no linked card: the moved card's row waits at the old variant", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.futureStar, s.box);

    await move(s, s.fx.goldId, [s.fx.futureStar]);

    expect(await rowsOf(s)).toEqual([
      { ownerId: ME.subject, cardId: s.fx.futureStar, variantId: s.fx.futureStarsId },
    ]);
    // The drainer syncs the old variant, then re-points the row to the card's
    // current one (`settleRows` reads it from the snapshot).
    const snapshot = await s.t.query(internal.listingDrain.outboxSnapshot, {
      ownerId: ME.subject,
      platform: "bsc",
      variantId: s.fx.futureStarsId,
    });
    expect(snapshot).toMatchObject([{ cardId: s.fx.futureStar, currentVariantId: s.fx.goldId }]);
  });

  test("an old variant the move deleted is not woken; the card queues at its new variant", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.futureStar, s.box);

    await s.t.run(async (ctx) => {
      const card = await ctx.db.get(s.fx.futureStar);
      await moveCards(ctx, s.fx.goldId, [{ card: card!, slotMap: {} }], NOW);
      await ctx.db.delete(s.fx.futureStarsId);
    });
    await drainScheduled(s.t);

    expect(await rowsOf(s)).toEqual([{ ownerId: ME.subject, cardId: s.fx.futureStar, variantId: s.fx.goldId }]);
  });

  test("binder copies and owners who list nowhere queue nothing", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.gooden1, s.main);
    await copy(s, s.fx.strawberry2, s.theirBox, { ownerId: THEM.subject, condition: "Excellent" });

    await move(s, s.fx.goldId, [s.fx.gooden1, s.fx.strawberry2]);

    expect(await outbox(s)).toEqual([]);
    expect(await drains(s)).toEqual([]);
  });

  test("a move with no collectors' copies schedules no listing hand-off", async () => {
    const s = await fresh();
    await listOn(s);
    await s.t.run(async (ctx) => {
      const card = await ctx.db.get(s.fx.strawberry2);
      await moveCards(ctx, s.fx.goldId, [{ card: card!, slotMap: {} }], NOW);
    });
    const scheduled = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("queueMovedCopyListings"))).toEqual([]);
  });

  test("many owners: the hand-off pages, and a listing owner past the first page is still queued", async () => {
    const s = await fresh();
    const lister = "collector_far_down_the_list";
    await listOn(s, lister);
    // MOVED_LISTING_PAGE owners who list nowhere first (ids sort them ahead), then the lister.
    await s.t.run(async (ctx) => {
      const owners = [
        ...Array.from({ length: MOVED_LISTING_PAGE }, (_, i) => `collector_${String(i).padStart(3, "0")}`),
        lister,
      ];
      for (const ownerId of owners) {
        const homeId = await ctx.db.insert("collectionContainers", {
          ownerId,
          kind: "box",
          name: "Box",
          lastUpdated: NOW,
        });
        await ctx.db.insert("collectionCopies", {
          ownerId,
          cardId: s.fx.gooden1,
          variantId: s.fx.baseId,
          setId: s.fx.setId,
          homeId,
          quantity: 1,
          condition: "Excellent",
          lastUpdated: 1,
        });
      }
    });

    await move(s, s.fx.goldId, [s.fx.gooden1]);

    const rows = await rowsOf(s);
    expect(rows.every((r) => r.ownerId === lister)).toBe(true);
    expect(rows.map((r) => r.variantId).sort()).toEqual([s.fx.baseId, s.fx.goldId].sort());
  });

  test("the copy chain hands its re-pointed copies on too", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.futureStar, s.box);
    // The card moved by some path; its copy still names the old variant.
    await s.t.run((ctx) => ctx.db.patch(s.fx.futureStar, { selectorOptionId: s.fx.goldId }));

    await s.t.mutation(internal.setShapeMove.repointMovedCardCopies, {
      cardIds: [s.fx.futureStar],
      index: 0,
      cursor: null,
    });
    await drainScheduled(s.t);

    expect(await rowsOf(s)).toEqual([
      { ownerId: ME.subject, cardId: s.fx.futureStar, variantId: s.fx.futureStarsId },
    ]);
  });
});

describe("the condition backfill queues the box copies it sets", () => {
  test("armed: a lister's box copy queues; their binder copy and a non-lister's box copy don't", async () => {
    const s = await fresh();
    await listOn(s);
    await copy(s, s.fx.gooden1, s.box, {});
    await copy(s, s.fx.strawberry2, s.main, {});
    await copy(s, s.fx.futureStar, s.theirBox, { ownerId: THEM.subject });

    const dry = await s.t.mutation(internal.backfillCopyCondition.run, {});
    expect(dry).toMatchObject({ set: 3 });
    await drainScheduled(s.t);
    expect(await outbox(s)).toEqual([]);

    const armed = await s.t.mutation(internal.backfillCopyCondition.run, { arm: true });
    expect(armed).toMatchObject({ set: 3, isDone: true });
    await drainScheduled(s.t);

    expect(await rowsOf(s)).toEqual([{ ownerId: ME.subject, cardId: s.fx.gooden1, variantId: s.fx.baseId }]);
    expect(await drains(s)).toHaveLength(1);
  });

  test("an owner who lists nowhere: armed sets the condition and queues nothing", async () => {
    const s = await fresh();
    const id = await copy(s, s.fx.gooden1, s.box, {});
    await s.t.mutation(internal.backfillCopyCondition.run, { arm: true });
    await drainScheduled(s.t);
    expect((await s.t.run((ctx) => ctx.db.get(id)))!.condition).toBe("Excellent");
    expect(await outbox(s)).toEqual([]);
    const scheduled = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("queueOwnerCards"))).toEqual([]);
  });
});
