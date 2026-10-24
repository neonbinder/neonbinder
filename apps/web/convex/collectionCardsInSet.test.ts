/**
 * NEO-359 — `collection.cardsInSet`: whole-set browse, paged by hand across
 * the set's checklists in display order (the same walk as `setSummary`).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { MAX_SET_CARDS_PAGE } from "./collection";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME) };
}
type S = Awaited<ReturnType<typeof setup>>;

type Opts = { numItems: number; cursor: string | null; endCursor?: string | null };
const page = (s: S, setId: string, paginationOpts: Opts) =>
  s.me.query(api.collection.cardsInSet, { setId, paginationOpts });

async function readAll(s: S, setId: string, numItems: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const r: Awaited<ReturnType<typeof page>> = await page(s, setId, { numItems, cursor });
    ids.push(...r.page.map((c) => c._id as string));
    if (r.isDone) return ids;
    cursor = r.continueCursor;
  }
  throw new Error("never finished");
}

/** Three more Base cards sharing strawberry2's sortOrder (1): ties break by creation. */
async function addTies(s: S) {
  return s.t.run(async (ctx) => {
    const out: Array<Id<"cardChecklist">> = [];
    for (const n of ["2a", "2b", "2c"]) {
      out.push(await insertTestCard(ctx, {
        selectorOptionId: s.fx.baseId, cardNumber: n, cardName: n, playerIds: [],
        platformData: {}, isCustom: false, sortOrder: 1, lastUpdated: 0,
      } as never));
    }
    return out;
  });
}

describe("cardsInSet", () => {
  test("refuses a signed-out caller", async () => {
    const { t, fx } = await setup();
    await expect(
      t.query(api.collection.cardsInSet, { setId: fx.setId, paginationOpts: { numItems: 5, cursor: null } }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("lists checklists in display order (Base, Inserts, Parallels), each in sortOrder", async () => {
    const s = await setup();
    const r = await page(s, s.fx.setId, { numItems: 100, cursor: null });
    expect(r.page.map((c) => c._id)).toEqual([
      s.fx.gooden1, s.fx.strawberry2, s.fx.gooden1Sliding, s.fx.futureStar, s.fx.gold1,
    ]);
    expect(r.page.map((c) => c.variantId)).toEqual([
      s.fx.baseId, s.fx.baseId, s.fx.baseId, s.fx.futureStarsId, s.fx.goldId,
    ]);
    expect(r.isDone).toBe(true);
  });

  test("paging by 1, 2, 3 and one big page return the same cards, once each", async () => {
    const s = await setup();
    const ties = await addTies(s);
    const big = await readAll(s, s.fx.setId, 1000);
    expect(big).toHaveLength(8);
    expect(new Set(big).size).toBe(8);
    // Ties on sortOrder 1 come after strawberry2 by creation order.
    expect(big.slice(0, 6)).toEqual([s.fx.gooden1, s.fx.strawberry2, ...ties, s.fx.gooden1Sliding]);
    for (const size of [1, 2, 3, 4, 7]) expect(await readAll(s, s.fx.setId, size)).toEqual(big);
  });

  test("a page can cross a variant boundary", async () => {
    const s = await setup();
    const r = await page(s, s.fx.setId, { numItems: 4, cursor: null });
    expect(r.page).toHaveLength(4);
    expect(new Set(r.page.map((c) => c.variantId)).size).toBe(2);
    expect(r.isDone).toBe(false);
  });

  test("re-running a page with its own continueCursor as endCursor returns the same page", async () => {
    const s = await setup();
    await addTies(s);
    const first = await page(s, s.fx.setId, { numItems: 3, cursor: null });
    const second = await page(s, s.fx.setId, { numItems: 3, cursor: first.continueCursor });
    const rerun1 = await page(s, s.fx.setId, { numItems: 3, cursor: null, endCursor: first.continueCursor });
    expect(rerun1.page.map((c) => c._id)).toEqual(first.page.map((c) => c._id));
    expect(rerun1.continueCursor).toBe(first.continueCursor);
    const rerun2 = await page(s, s.fx.setId, { numItems: 3, cursor: first.continueCursor, endCursor: second.continueCursor });
    expect(rerun2.page.map((c) => c._id)).toEqual(second.page.map((c) => c._id));
    expect(rerun2.continueCursor).toBe(second.continueCursor);
  });

  test("a bounded re-run across a variant boundary stops at the end cursor, and picks up a card added inside it", async () => {
    const s = await setup();
    const first = await page(s, s.fx.setId, { numItems: 4, cursor: null });
    const inserted = await s.t.run(async (ctx) =>
      insertTestCard(ctx, {
        selectorOptionId: s.fx.baseId, cardNumber: "1x", cardName: "1x", playerIds: [],
        platformData: {}, isCustom: false, sortOrder: 0.5, lastUpdated: 0,
      } as never),
    );
    const rerun = await page(s, s.fx.setId, { numItems: 4, cursor: null, endCursor: first.continueCursor });
    expect(rerun.page.map((c) => c._id)).toEqual([
      s.fx.gooden1, inserted, s.fx.strawberry2, s.fx.gooden1Sliding, s.fx.futureStar,
    ]);
    expect(rerun.continueCursor).toBe(first.continueCursor);
    // The next page is untouched by the insert.
    const next = await page(s, s.fx.setId, { numItems: 4, cursor: first.continueCursor });
    expect(next.page.map((c) => c._id)).toEqual([s.fx.gold1]);
  });

  test("a checklist known to be empty is skipped, and the rows beneath it are still walked", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.fx.baseId, { cardCount: 0, nonVariationCardCount: 0, subtreeCardCount: 0 } as never);
    });
    const r = await page(s, s.fx.setId, { numItems: 100, cursor: null });
    expect(r.page.map((c) => c._id)).toEqual([s.fx.futureStar, s.fx.gold1]);
    expect(await readAll(s, s.fx.setId, 1)).toEqual([s.fx.futureStar, s.fx.gold1]);
  });

  test("an unknown, non-set or empty-string setId reads as an empty finished page", async () => {
    const s = await setup();
    for (const setId of ["garbage", "", s.fx.baseId as string, s.fx.sportId as string, s.fx.gooden1 as string]) {
      const r = await page(s, setId, { numItems: 10, cursor: null });
      expect(r).toEqual({ page: [], isDone: true, continueCursor: "" });
    }
  });

  test("a cursor naming a variant that is gone, or junk, reads as empty and done", async () => {
    const s = await setup();
    const first = await page(s, s.fx.setId, { numItems: 4, cursor: null });
    await s.t.run(async (ctx) => {
      // Gold is in the walk; park the cursor on a variant, then drop it.
      await ctx.db.delete(s.fx.gold1);
    });
    const gone = JSON.stringify({ v: s.fx.set86Id });
    const r = await page(s, s.fx.setId, { numItems: 10, cursor: gone });
    expect(r.page).toEqual([]);
    expect(r.isDone).toBe(true);
    // Junk is read as no cursor: it starts from the top rather than throwing.
    const junk = await page(s, s.fx.setId, { numItems: 100, cursor: "not json" });
    expect(junk.page.length).toBeGreaterThan(0);
    expect(first.page).toHaveLength(4);
  });

  test("numItems is clamped: zero and negatives give one card, a huge ask is capped", async () => {
    const s = await setup();
    for (const numItems of [0, -5, Number.NaN]) {
      const r = await page(s, s.fx.setId, { numItems, cursor: null });
      expect(r.page).toHaveLength(1);
    }
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_SET_CARDS_PAGE + 5; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: s.fx.baseId, cardNumber: `Z${i}`, cardName: `Z${i}`, playerIds: [],
          platformData: {}, isCustom: false, sortOrder: 10 + i, lastUpdated: 0,
        } as never);
      }
    });
    const big = await page(s, s.fx.setId, { numItems: 100_000, cursor: null });
    expect(big.page).toHaveLength(MAX_SET_CARDS_PAGE);
    expect(big.isDone).toBe(false);
    const all = await readAll(s, s.fx.setId, 100_000);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(MAX_SET_CARDS_PAGE + 5 + 5);
  });

  test("a different set's cards never appear", async () => {
    const s = await setup();
    const r = await page(s, s.fx.set86Id, { numItems: 100, cursor: null });
    expect(r.page).toEqual([]);
    expect(r.isDone).toBe(true);
  });

  test("results carry NB fields only", async () => {
    const s = await setup();
    const r = await page(s, s.fx.setId, { numItems: 100, cursor: null });
    const text = JSON.stringify(r);
    for (const key of ["platformData", "platformLabels", "isCustom", "sku", "bscTeamName", "pendingTeamNames", "pendingPlayerNames", "attributes", "autographType"]) {
      expect(text, `leaked ${key}`).not.toContain(`"${key}"`);
    }
    expect(text).not.toMatch(/bsc-slug|bsc-ref|BSC label|SKU-|BSC Team|Pending|platform-attr/i);
  });
});
