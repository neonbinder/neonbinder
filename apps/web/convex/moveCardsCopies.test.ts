/**
 * NEO-358 — `setShapeMove.moveCards` never refuses an operator's move because
 * of collectors' copies.
 *
 * It re-points the first `MAX_COPIES_PER_MOVE` copies in the move's own
 * transaction and hands the rest to the scheduled `repointMovedCardCopies`
 * chain, which pages through them. Pinned here:
 *  - one account's pile (more copies than the inline budget, on one card)
 *    does not block the move, and every copy lands on the destination once
 *    the chain drains;
 *  - the card counts move in the move's transaction, whatever the copies do;
 *  - a copy still waiting on the chain never inflates a completion count;
 *  - the chain reads the card's CURRENT row (safe to retry, safe against a
 *    second move in between) and skips a card that is gone.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { recountCards } from "./cardCounts";
import { COPY_REPOINT_PAGE, MAX_COPIES_PER_MOVE, moveCards } from "./setShapeMove";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_700_000_000_000;
const OWNER = "collector_pile";
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: T) {
  return t.run(async (ctx) => {
    const row = (
      level: Doc<"selectorOptions">["level"],
      value: string,
      parentId?: Id<"selectorOptions">,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const fromSet = await row("setName", "Chrome", brand);
    const toSet = await row("setName", "Finest", brand);
    const fromBase = await row("variantType", "Base", fromSet);
    const toBase = await row("variantType", "Base", toSet);
    const home = await ctx.db.insert("collectionContainers", {
      ownerId: OWNER,
      kind: "binder",
      system: "main",
      name: "Main",
      lastUpdated: NOW,
    });
    const card = (cardNumber: string) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: fromBase,
        cardNumber,
        cardName: `Card ${cardNumber}`,
        listingTitle: `Card ${cardNumber}`,
        platformData: {},
        sortOrder: Number.parseInt(cardNumber, 10),
        lastUpdated: NOW,
      });
    const a = await card("1");
    const b = await card("2");
    for (const id of [fromBase, toBase]) {
      await ctx.db.patch(id, (await recountCards(ctx, id))!);
    }
    return { fromSet, toSet, fromBase, toBase, home, a, b };
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** `n` copy rows of `cardId` for OWNER, each a distinct pile (its own note). */
async function pile(t: T, s: Seeded, cardId: Id<"cardChecklist">, n: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("collectionCopies", {
        ownerId: OWNER,
        cardId,
        variantId: s.fromBase,
        setId: s.fromSet,
        homeId: s.home,
        quantity: 1,
        notes: `pile ${i}`,
        lastUpdated: NOW,
      });
    }
  });
}

/** Where every copy of `cardId` points: counts per `variantId`. */
const copyPlaces = (t: T, cardId: Id<"cardChecklist">) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_card", (q) => q.eq("cardId", cardId))
      .collect();
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.variantId}|${r.setId}`] = (out[`${r.variantId}|${r.setId}`] ?? 0) + 1;
    return out;
  });

const move = (t: T, s: Seeded, ids: Array<Id<"cardChecklist">>) =>
  t.run(async (ctx) => {
    const cards = await Promise.all(ids.map((id) => ctx.db.get(id)));
    await moveCards(
      ctx,
      s.toBase,
      cards.map((card) => ({ card: card!, slotMap: {} })),
      NOW,
    );
  });

describe("moveCards and collectors' copies", () => {
  test("one account's pile past the inline budget does not block the move; the chain finishes it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const total = MAX_COPIES_PER_MOVE + COPY_REPOINT_PAGE + 37; // three chain pages' worth
    await pile(t, s, s.a, total);

    await move(t, s, [s.a, s.b]); // a refusal would throw here

    // The cards and their counts moved in the move's own transaction.
    const cards = await t.run(async (ctx) => [(await ctx.db.get(s.a))!, (await ctx.db.get(s.b))!]);
    expect(cards.map((c) => c.selectorOptionId)).toEqual([s.toBase, s.toBase]);
    const counts = await t.run(async (ctx) => ({
      from: (await ctx.db.get(s.fromBase))!.cardCount,
      to: (await ctx.db.get(s.toBase))!.cardCount,
    }));
    expect(counts).toEqual({ from: 0, to: 2 });

    // The first MAX_COPIES_PER_MOVE copies are already re-pointed; the rest wait.
    const dest = `${s.toBase}|${s.toSet}`;
    const src = `${s.fromBase}|${s.fromSet}`;
    expect(await copyPlaces(t, s.a)).toEqual({
      [dest]: MAX_COPIES_PER_MOVE,
      [src]: total - MAX_COPIES_PER_MOVE,
    });

    // In that window no completion over-reads: the old variant owns nothing
    // (its card has gone), the new one owns the card through the copies that
    // already moved.
    const as = t.withIdentity({ subject: OWNER });
    expect(await as.query(api.collection.variantCompletion, { variantId: s.fromBase })).toMatchObject({
      owned: 0,
      ownedAll: 0,
      total: 0,
    });
    expect(await as.query(api.collection.variantCompletion, { variantId: s.toBase })).toMatchObject({
      owned: 1,
      ownedAll: 1,
      total: 2,
    });
    const fromSetCompletion = await as.query(api.collection.setCompletion, { setId: s.fromSet });
    expect(fromSetCompletion).toMatchObject({ owned: 0, ownedAll: 0 });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await copyPlaces(t, s.a)).toEqual({ [dest]: total });
  });

  test("copies across many cards: the budget is shared, the overflow cards are chained", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await pile(t, s, s.a, MAX_COPIES_PER_MOVE - 1);
    await pile(t, s, s.b, 5);
    await move(t, s, [s.a, s.b]);
    const dest = `${s.toBase}|${s.toSet}`;
    expect(await copyPlaces(t, s.a)).toEqual({ [dest]: MAX_COPIES_PER_MOVE - 1 });
    // One of card 2's copies fit; the other four wait for the chain.
    expect(Object.values(await copyPlaces(t, s.b)).sort()).toEqual([1, 4]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await copyPlaces(t, s.b)).toEqual({ [dest]: 5 });
  });

  test("within the budget nothing is scheduled for copies", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await pile(t, s, s.a, 3);
    await move(t, s, [s.a]);
    expect(await copyPlaces(t, s.a)).toEqual({ [`${s.toBase}|${s.toSet}`]: 3 });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("repointMovedCardCopies"))).toHaveLength(0);
  });

  test("the chain reads the card's current row, is idempotent, and skips a gone card", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await pile(t, s, s.a, 4);
    await pile(t, s, s.b, 2);
    // The card moved to toBase by some other path; its copies still say fromBase.
    await t.run((ctx) => ctx.db.patch(s.a, { selectorOptionId: s.toBase }));
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: s.fromBase,
        cardNumber: "9",
        cardName: "Card 9",
        listingTitle: "Card 9",
        platformData: {},
        sortOrder: 9,
        lastUpdated: NOW,
      });
      await ctx.db.delete(id);
      return id;
    });
    const args = { cardIds: [gone, s.a, s.b], index: 0, cursor: null };
    const first = await t.mutation(internal.setShapeMove.repointMovedCardCopies, args);
    expect(first).toEqual({ repointed: 0, done: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await copyPlaces(t, s.a)).toEqual({ [`${s.toBase}|${s.toSet}`]: 4 });
    // Card 2 never moved: its copies already match its row, so nothing changes.
    expect(await copyPlaces(t, s.b)).toEqual({ [`${s.fromBase}|${s.fromSet}`]: 2 });

    // A re-run writes nothing.
    const again = await t.mutation(internal.setShapeMove.repointMovedCardCopies, {
      ...args,
      index: 1,
    });
    expect(again).toEqual({ repointed: 0, done: false });
    // An index past the end, or a negative one, does not throw.
    expect(
      await t.mutation(internal.setShapeMove.repointMovedCardCopies, { ...args, index: 3 }),
    ).toEqual({ repointed: 0, done: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
