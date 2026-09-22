/**
 * NEO-296 — the six transaction bounds added to `convex/selectorOptions.ts`.
 *
 * ## What is actually being defended
 *
 * Convex counts one system operation per database CALL, so a `.collect()` of a
 * thousand rows is ONE operation and the only thing that can run away is a
 * per-row loop. Every bound here sits on such a loop, and every one of them
 * was reachable by an ordinary operator action on an ordinary-sized set: a
 * full checklist sync, adding one card to the front of a big set, pasting a
 * checklist into the cross-listing importer, a year's worth of re-homes, a
 * team picked on a set with several hundred inserts. The house calibration
 * (`CARDS_PER_COMMIT_CHUNK`) is ~900 operations comfortable, ~1,800 straining,
 * ~4,000 failing; each bound's own doc comment does the arithmetic that lands
 * it under ~900.
 *
 * A test that only asserted "it stops" would pass against a bound that threw
 * the tail away, which is the failure mode that matters. So each bound is
 * pinned by the property that makes stopping SAFE, and those properties are
 * not the same shape:
 *
 *  - `storeSelectorOptions` and `restampCardChecklistSortOrdersBatch` are
 *    RESUMABLE. The store resumes by REPLAY — the caller re-sends the
 *    identical list, the stored prefix re-matches by marketplace id and costs
 *    no writes, and the call walks into the tail — which is why its budget
 *    counts writes rather than items. The restamp resumes by INDEX, handed
 *    back as `nextFrom`. Both are asserted to converge and to write nothing on
 *    a replay of completed work.
 *  - `rehomeSetRowsForSync`, `addCrossListingsByCardNumbers` and
 *    `applyParallelGroupings` REFUSE instead, because a silently short result
 *    would be indistinguishable from a real one on the screen that reports it
 *    (a set left under Unknown, a card number that reads as `notFound`). The
 *    first two are sliced by their callers; the third is deliberately atomic,
 *    so its refusal is also asserted to have written nothing.
 *  - `cascadeSelectorOptionTeams`'s node pass pages and reschedules. Its extra
 *    obligation is ORDER: every node's `teamIds` must be settled before the
 *    first card is visited, because `teamFollowVerdict` asks whether a node
 *    still follows the root and a half-settled subtree answers that
 *    differently depending on where the last page stopped.
 *
 * Sizes are derived from the exported constants, never typed in, so raising a
 * bound cannot quietly turn a multi-page test into a single-page one. The one
 * module-private bound (`TEAM_CASCADE_NODE_PAGE`) is crossed by a subtree
 * comfortably larger than it and pinned by the OBSERVABLE consequence —
 * "after one invocation some node is still unsettled" — rather than by a
 * number copied out of the source.
 *
 * Kept out of the feature files it touches (`selectorSyncAdditive.test.ts`,
 * `selectorOptions.crossListings.test.ts`,
 * `selectorOptions.setSelectorOptionTeams.test.ts`) on purpose: those cover
 * what each function MEANS, and this file covers what one transaction is
 * allowed to cost. Fixtures follow their conventions.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  CROSS_LISTING_LINKS_PER_CALL,
  REHOME_MOVES_PER_CALL,
  RESTAMP_SORT_ORDER_PAGE,
  SELECTOR_STORE_WRITE_BUDGET,
} from "./selectorOptions";
import { compareCardNumbers } from "../lib/cards/card-number";
import { teamRowFields } from "./lib/teamRow";

// convex-test discovers modules through import.meta.glob, and the glob must be
// called from a file directly under convex/ or sibling modules (adapters/…)
// silently drop out of the registry.
const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo296_selector_budgets",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo296_selector_budgets",
  name: "Admin User",
  role: "admin",
};

/**
 * A fixed, far-in-the-past `lastUpdated`. A real patch replaces it with
 * `Date.now()` (~1.7e12), so its survival is the observable proof that a row
 * was NOT written — which is how the refusal tests show atomicity.
 */
const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  // Fake timers so a scheduled continuation fires only when a test asks for
  // it: two tests here assert on the state BETWEEN pages, and a background
  // `runAfter(0)` racing that assertion would make them flaky rather than
  // wrong. Matches selectorOptions.setSelectorOptionTeams.test.ts.
  vi.useFakeTimers();
  // NEO-188/NEO-247: `addCustomCard` and the team cascade can schedule a BSC
  // team lookup. This file has nothing to say about team resolution. A
  // THROWING stub rather than a canned 200, the convention
  // commitCardChecklist.chunking.test.ts sets: the adapter already treats a
  // request failure as a state it handles, and it cannot write anything
  // derived from a payload this file invented.
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-296: this test file must not reach the network: ${String(url)}`,
      );
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const admin = (t: T) => t.withIdentity(ADMIN_IDENTITY);

// ===========================================================================
// 1 — storeSelectorOptions: bounded by WRITES, resumable by REPLAY
// ===========================================================================

async function insertManufacturer(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps Inc",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function setRowsUnder(t: T, parentId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .collect(),
  );
}

/**
 * Distinct, id-carrying setName options. Each carries its own BSC id, so a
 * replay matches it at the id tier rather than by name — the path a real
 * re-sync takes, and the one the replay property depends on.
 */
function storeBatch(size: number) {
  return Array.from({ length: size }, (_, i) => ({
    value: `Set ${i}`,
    platformData: { bsc: `bsc-${i}` },
  }));
}

describe("storeSelectorOptions is bounded by its writes (NEO-296)", () => {
  test("a batch inside the budget is stored in one call and reports no more", async () => {
    const t = convexTest(schema, modules);
    const parentId = await insertManufacturer(t);

    const res = await admin(t).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: storeBatch(10),
    });

    expect(res.hasMore).toBe(false);
    expect(res.itemsProcessed).toBe(10);
    expect(res.optionsCount).toBe(10);
    // Ten inserts. The parent's `children` union patch is one of the ~60 fixed
    // operations the budget sets aside for and is deliberately not counted.
    expect(res.writeOps).toBe(10);
    expect(await setRowsUnder(t, parentId)).toHaveLength(10);
  });

  test("a batch past the budget stops on WRITES, commits the prefix, and says so", async () => {
    const t = convexTest(schema, modules);
    const parentId = await insertManufacturer(t);
    const size = SELECTOR_STORE_WRITE_BUDGET + 25;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await admin(t).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options: storeBatch(size),
    });

    // Every item in this batch is an insert, so the budget is spent exactly
    // one write per item and the bound — checked BEFORE each item — admits
    // precisely a budget's worth.
    expect(res.hasMore).toBe(true);
    expect(res.itemsProcessed).toBe(SELECTOR_STORE_WRITE_BUDGET);
    expect(res.writeOps).toBe(SELECTOR_STORE_WRITE_BUDGET);
    // What it did store is COMMITTED, not rolled back with the tail.
    expect(await setRowsUnder(t, parentId)).toHaveLength(
      SELECTOR_STORE_WRITE_BUDGET,
    );
    // Never silent: a truncated store is the one result a caller must not read
    // as "done", so it is a structured warn as well as a flag.
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("selector_sync_store_truncated"),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  test("replaying the IDENTICAL payload finishes the job and duplicates nothing", async () => {
    const t = convexTest(schema, modules);
    const parentId = await insertManufacturer(t);
    const size = SELECTOR_STORE_WRITE_BUDGET + 25;
    const options = storeBatch(size);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await admin(t).mutation(
      api.selectorOptions.storeSelectorOptions,
      { level: "setName", parentId, options },
    );
    expect(first.hasMore).toBe(true);

    // The caller keeps no cursor: the same list, again. This is the whole
    // reason the budget counts writes instead of items — the stored prefix
    // re-matches by BSC id, changes nothing, spends no budget, and the call
    // walks into the tail.
    const second = await admin(t).mutation(
      api.selectorOptions.storeSelectorOptions,
      { level: "setName", parentId, options },
    );

    expect(second.hasMore).toBe(false);
    expect(second.itemsProcessed).toBe(size);
    // Only the 25 rows the first call never reached were written.
    expect(second.writeOps).toBe(25);

    const rows = await setRowsUnder(t, parentId);
    expect(rows).toHaveLength(size);
    // The prefix was re-MATCHED, not re-inserted.
    expect(new Set(rows.map((r) => r.value)).size).toBe(size);
    vi.mocked(console.warn).mockRestore?.();
  });

  test("a replay of an already-complete store writes nothing and reports done", async () => {
    const t = convexTest(schema, modules);
    const parentId = await insertManufacturer(t);
    const options = storeBatch(5);

    await admin(t).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "setName",
      parentId,
      options,
    });
    const again = await admin(t).mutation(
      api.selectorOptions.storeSelectorOptions,
      { level: "setName", parentId, options },
    );

    // NEO-85's write-if-changed guard means a matched, unchanged item costs
    // neither an insert nor a patch. Without that, a truncated call could
    // never be finished by replaying the same list.
    expect(again.writeOps).toBe(0);
    expect(again.hasMore).toBe(false);
    expect(again.itemsProcessed).toBe(5);
    expect(await setRowsUnder(t, parentId)).toHaveLength(5);
  });
});

// ===========================================================================
// 2 — rehomeSetRowsForSync: refused above REHOME_MOVES_PER_CALL
// ===========================================================================

/**
 * A year with a flagged brand-unknown row holding `count` sets, plus an empty
 * target brand under the same year. The flag matters: `rehomeSetRowsForSync`
 * moves a row only while it is still under a brand-unknown parent.
 */
async function seedRehomePlan(t: T, count: number) {
  return t.run(async (ctx) => {
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const unknownId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Unknown",
      metadata: { isBrandUnknown: true },
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const brandId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const rowIds: Array<Id<"selectorOptions">> = [];
    for (let i = 0; i < count; i++) {
      rowIds.push(
        await ctx.db.insert("selectorOptions", {
          level: "setName",
          value: `Topps Set ${i}`,
          platformData: {},
          parentId: unknownId,
          children: [],
          lastUpdated: SENTINEL,
        }),
      );
    }
    await ctx.db.patch(unknownId, { children: rowIds });
    await ctx.db.patch(yearId, { children: [unknownId, brandId] });
    return { yearId, unknownId, brandId, rowIds };
  });
}

describe("rehomeSetRowsForSync moves per call (NEO-296)", () => {
  test("refuses a plan longer than the per-call limit rather than truncating it", async () => {
    const t = convexTest(schema, modules);
    const { brandId, rowIds } = await seedRehomePlan(
      t,
      REHOME_MOVES_PER_CALL + 1,
    );

    await expect(
      t.mutation(internal.selectorOptions.rehomeSetRowsForSync, {
        moves: rowIds.map((rowId) => ({ rowId, toId: brandId })),
      }),
    ).rejects.toThrow(/exceeds/);

    // A move that did not happen leaves a set under Unknown where the operator
    // was told it had been filed, so the refusal must also be a no-op.
    const rows = await t.run(async (ctx) =>
      Promise.all(rowIds.map((id) => ctx.db.get(id))),
    );
    expect(rows.every((r) => r!.lastUpdated === SENTINEL)).toBe(true);
  });

  test("a plan exactly at the cap re-homes every row", async () => {
    const t = convexTest(schema, modules);
    const { brandId, rowIds } = await seedRehomePlan(t, REHOME_MOVES_PER_CALL);

    const res = await t.mutation(
      internal.selectorOptions.rehomeSetRowsForSync,
      { moves: rowIds.map((rowId) => ({ rowId, toId: brandId })) },
    );

    expect(res).toEqual({ rehomed: REHOME_MOVES_PER_CALL, clashes: 0 });
    const brand = await t.run(async (ctx) => ctx.db.get(brandId));
    expect(brand!.children).toHaveLength(REHOME_MOVES_PER_CALL);
  });
});

// ===========================================================================
// 3 — restampCardChecklistSortOrdersBatch: paged, resumable by index
// ===========================================================================

/**
 * A variant-level set holding `count` cards whose `sortOrder` runs BACKWARDS
 * against card-number order and is offset past the end of the list, so no row
 * accidentally already holds the index it will be restamped to. Every row
 * therefore costs a patch, and the page budget — which counts PATCHES, not
 * rows examined — is spent on every one of them.
 */
async function seedChecklist(t: T, count: number) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "1995 Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: String(i + 1),
        cardName: `Card ${i + 1}`,
        platformData: {},
        sortOrder: 2 * count - i,
        lastUpdated: SENTINEL,
      });
    }
    return { sportId, setNameId, variantTypeId };
  });
}

/** True when every row's `sortOrder` is its index in card-number order. */
async function sortOrdersAreCanonical(t: T, id: Id<"selectorOptions">) {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", id))
      .collect(),
  );
  const sorted = [...rows].sort((a, b) =>
    compareCardNumbers(a.cardNumber, b.cardNumber),
  );
  return sorted.every((row, i) => row.sortOrder === i);
}

describe("restampCardChecklistSortOrders pages (NEO-296)", () => {
  test("a checklist inside one page is restamped in a single call reporting done", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedChecklist(t, 12);

    const res = await t.mutation(
      internal.selectorOptions.restampCardChecklistSortOrdersBatch,
      { selectorOptionId: variantTypeId, from: 0, pagesLeft: 12 },
    );

    expect(res.done).toBe(true);
    expect(res.nextFrom).toBeUndefined();
    expect(res.patched).toBe(12);
    expect(await sortOrdersAreCanonical(t, variantTypeId)).toBe(true);
  });

  test(
    "a checklist past one page pages across calls and converges on card-number order",
    async () => {
      const t = convexTest(schema, modules);
      // Comfortably past one page, and NOT a multiple of it, so the last page
      // is a partial one rather than landing exactly on the boundary.
      const total = RESTAMP_SORT_ORDER_PAGE + 37;
      const { variantTypeId } = await seedChecklist(t, total);

      // convex-test does not auto-run scheduled functions, which is exactly
      // why the mutation hands `nextFrom` back: the chain is driven by hand.
      const first = await t.mutation(
        internal.selectorOptions.restampCardChecklistSortOrdersBatch,
        { selectorOptionId: variantTypeId, from: 0, pagesLeft: 12 },
      );
      expect(first.done).toBe(false);
      expect(first.patched).toBe(RESTAMP_SORT_ORDER_PAGE);
      expect(first.nextFrom).toBe(RESTAMP_SORT_ORDER_PAGE);
      // Mid-chain the checklist is PARTLY re-numbered — a display-order
      // wobble, committed, with no card lost and no number changed.
      expect(await sortOrdersAreCanonical(t, variantTypeId)).toBe(false);

      const second = await t.mutation(
        internal.selectorOptions.restampCardChecklistSortOrdersBatch,
        {
          selectorOptionId: variantTypeId,
          from: first.nextFrom!,
          pagesLeft: 11,
        },
      );
      expect(second.done).toBe(true);
      expect(second.patched).toBe(37);
      expect(await sortOrdersAreCanonical(t, variantTypeId)).toBe(true);

      // Replaying a completed restamp writes nothing: each page re-reads,
      // re-sorts and patches only what differs, so a retried page is free.
      const replay = await t.mutation(
        internal.selectorOptions.restampCardChecklistSortOrdersBatch,
        { selectorOptionId: variantTypeId, from: 0, pagesLeft: 12 },
      );
      expect(replay).toEqual({ patched: 0, done: true });
    },
    // ~840 card rows are seeded in ONE transaction and then walked twice.
    // Comfortable in isolation, but this file runs under 8-way parallelism
    // where the default 5s can be tight; the ceiling is not a symptom.
    20_000,
  );

  test("addCustomCard restamps inline and schedules nothing when one page is enough", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedChecklist(t, 5);

    // A card at the FRONT shifts every row behind it — the shape that used to
    // make the whole `addCustomCard` transaction fail on a big set.
    await admin(t).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "0",
      cardName: "Inserted first",
    });

    expect(await sortOrdersAreCanonical(t, variantTypeId)).toBe(true);
    const pending = await t.run(async (ctx) =>
      (
        ctx as unknown as {
          db: {
            system: {
              query: (n: string) => {
                collect: () => Promise<
                  Array<{ name: string; state: { kind: string } }>
                >;
              };
            };
          };
        }
      ).db.system
        .query("_scheduled_functions")
        .collect(),
    );
    expect(
      pending.filter((row) => row.name.includes("restampCardChecklist")),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// 4 — addCrossListingsByCardNumbers: refused above CROSS_LISTING_LINKS_PER_CALL
// ===========================================================================

/** Two variant-level sets under one setName, the source holding `count` cards. */
async function seedCrossListingSets(t: T, count: number) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "1995 Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const sourceId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const targetId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Traded",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(setNameId, { children: [sourceId, targetId] });
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: sourceId,
        cardNumber: String(i + 1),
        cardName: `Card ${i + 1}`,
        platformData: {},
        sortOrder: i,
        lastUpdated: SENTINEL,
      });
    }
    return { sourceId, targetId };
  });
}

describe("addCrossListingsByCardNumbers per-call cap (NEO-296)", () => {
  test("refuses more numbers than one transaction may link", async () => {
    const t = convexTest(schema, modules);
    const { sourceId, targetId } = await seedCrossListingSets(t, 1);

    await expect(
      admin(t).mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: sourceId,
        targetSelectorOptionId: targetId,
        cardNumbers: Array.from(
          { length: CROSS_LISTING_LINKS_PER_CALL + 1 },
          (_, i) => String(i + 1),
        ),
      }),
    ).rejects.toThrow(/per call/);

    // Refused, not partly applied: a fourth silent "not attempted" category
    // would be indistinguishable from `notFound` on the importer's screen.
    const links = await t.run(async (ctx) =>
      ctx.db.query("cardCrossListings").collect(),
    );
    expect(links).toHaveLength(0);
  });

  test(
    "a slice at the cap links every number, and re-sending it links nothing twice",
    async () => {
      const t = convexTest(schema, modules);
      const { sourceId, targetId } = await seedCrossListingSets(
        t,
        CROSS_LISTING_LINKS_PER_CALL,
      );
      const slice = Array.from(
        { length: CROSS_LISTING_LINKS_PER_CALL },
        (_, i) => String(i + 1),
      );

      const first = await admin(t).mutation(
        api.selectorOptions.addCrossListingsByCardNumbers,
        {
          sourceSelectorOptionId: sourceId,
          targetSelectorOptionId: targetId,
          cardNumbers: slice,
        },
      );
      expect(first.linked).toHaveLength(CROSS_LISTING_LINKS_PER_CALL);
      expect(first.alreadyLinked).toEqual([]);
      expect(first.notFound).toEqual([]);

      // Each slice commits on its own and a link is idempotent, so an
      // interrupted import re-run keeps what landed instead of doubling it.
      const again = await admin(t).mutation(
        api.selectorOptions.addCrossListingsByCardNumbers,
        {
          sourceSelectorOptionId: sourceId,
          targetSelectorOptionId: targetId,
          cardNumbers: slice,
        },
      );
      expect(again.linked).toEqual([]);
      expect(again.alreadyLinked).toHaveLength(CROSS_LISTING_LINKS_PER_CALL);

      const links = await t.run(async (ctx) =>
        ctx.db.query("cardCrossListings").collect(),
      );
      expect(links).toHaveLength(CROSS_LISTING_LINKS_PER_CALL);
    },
    // A cap-sized slice is 400 index lookups plus 400 inserts, twice over.
    20_000,
  );
});

// ===========================================================================
// 5 — applyParallelGroupings: refused, and ATOMIC — nothing written
// ===========================================================================

describe("applyParallelGroupings entry cap (NEO-296)", () => {
  test("refuses an over-cap plan before reading or writing anything", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId, parallelId, insertId } = await t.run(async (ctx) => {
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      });
      const insertId = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Stars",
        platformData: {},
        parentId: variantTypeId,
        children: [],
        lastUpdated: SENTINEL,
      });
      const parallelId = await ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold",
        platformData: {},
        parentId: insertId,
        children: [],
        lastUpdated: SENTINEL,
      });
      await ctx.db.patch(insertId, { children: [parallelId] });
      await ctx.db.patch(variantTypeId, { children: [insertId] });
      return { variantTypeId, insertId, parallelId };
    });

    // The cap is on promotions + demotions + reparentings together. 400
    // demotions is past it whatever the (module-private) number is, and is
    // named as a count derived from nothing this test can get wrong.
    await expect(
      admin(t).mutation(api.selectorOptions.applyParallelGroupings, {
        variantTypeId,
        promotions: [],
        demotions: Array.from({ length: 400 }, () => ({ parallelId })),
        reparentings: [],
      }),
    ).rejects.toThrow(/exceeds/);

    // This one is deliberately atomic rather than paged, so the refusal has to
    // leave the subtree exactly as it was — no half-applied grouping.
    const [parallel, insertRow] = await t.run(async (ctx) => [
      await ctx.db.get(parallelId),
      await ctx.db.get(insertId),
    ]);
    expect(parallel!.level).toBe("parallel");
    expect(parallel!.parentId).toBe(insertId);
    expect(parallel!.lastUpdated).toBe(SENTINEL);
    expect(insertRow!.children).toEqual([parallelId]);
    expect(insertRow!.lastUpdated).toBe(SENTINEL);
  });
});

// ===========================================================================
// 6 — cascadeSelectorOptionTeams: the NODE pass pages, and finishes FIRST
// ===========================================================================

/**
 * A subtree deliberately wider than `TEAM_CASCADE_NODE_PAGE` (module-private,
 * 300): setName → variantType → `inserts` insert rows. Nothing here names
 * that number — the tests assert the observable consequence of crossing it
 * (after one invocation, some node is still unsettled) instead.
 *
 * One card is seeded under the FIRST insert, which the card pass would reach
 * within its own page budget on its very first invocation. Its state is how
 * "the card pass has not started" is observed.
 */
async function seedWideSubtree(t: T, inserts: number) {
  const teamId = await t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    return {
      sportId,
      teamId: await ctx.db.insert("teams", {
        ...teamRowFields({ location: "Toledo", name: "Mud Hens" }),
        sportId,
        lastUpdated: SENTINEL,
      }),
    };
  });
  return t.run(async (ctx) => {
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "1995 Topps",
      platformData: {},
      parentId: teamId.sportId,
      children: [],
      // The root is written by the caller before the cascade is scheduled;
      // the node pass starts at index 1 for exactly that reason.
      teamIds: [teamId.teamId],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    const insertIds: Array<Id<"selectorOptions">> = [];
    for (let i = 0; i < inserts; i++) {
      insertIds.push(
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Insert ${i}`,
          platformData: {},
          parentId: variantTypeId,
          children: [],
          lastUpdated: SENTINEL,
        }),
      );
    }
    await ctx.db.patch(variantTypeId, { children: insertIds });
    const cardId = await ctx.db.insert("cardChecklist", {
      selectorOptionId: insertIds[0],
      cardNumber: "1",
      cardName: "Card 1",
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
    });
    return {
      teamId: teamId.teamId,
      setNameId,
      variantTypeId,
      insertIds,
      cardId,
    };
  });
}

async function settledNodeCount(
  t: T,
  ids: Array<Id<"selectorOptions">>,
  teamId: Id<"teams">,
) {
  const rows = await t.run(async (ctx) =>
    Promise.all(ids.map((id) => ctx.db.get(id))),
  );
  return rows.filter(
    (r) => r!.teamIds?.length === 1 && r!.teamIds[0] === teamId,
  ).length;
}

describe("cascadeSelectorOptionTeams node pass (NEO-296)", () => {
  test(
    "a subtree wider than one node page settles every node, and no card until it has",
    async () => {
      const t = convexTest(schema, modules);
      // Comfortably past the node page, and not a multiple of it.
      const { teamId, setNameId, variantTypeId, insertIds, cardId } =
        await seedWideSubtree(t, 420);
      const descendants = [variantTypeId, ...insertIds];

      // One invocation, by hand. Under fake timers the continuation it
      // schedules cannot fire until the drain below asks for it.
      await t.mutation(internal.selectorOptions.cascadeSelectorOptionTeams, {
        rootId: setNameId,
        previousTeamIds: [],
        teamIds: [teamId],
      });

      const afterFirst = await settledNodeCount(t, descendants, teamId);
      // The bound: one transaction settles a page, not the subtree.
      expect(afterFirst).toBeGreaterThan(0);
      expect(afterFirst).toBeLessThan(descendants.length);
      // And the ORDER: `teamFollowVerdict` asks whether a node still follows
      // the root, so a card must not be visited while the subtree is half
      // settled. This card sits under the first insert — well inside the card
      // pass's own page — so if that pass had started it would already carry
      // the team.
      const card = await t.run(async (ctx) => ctx.db.get(cardId));
      expect(card!.teamOnCardIds).toBeUndefined();

      // Drive the rest of the chain.
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await settledNodeCount(t, descendants, teamId)).toBe(
        descendants.length,
      );
      const done = await t.run(async (ctx) => ctx.db.get(cardId));
      expect(done!.teamOnCardIds).toEqual([teamId]);
    },
    // 422 nodes seeded in one transaction, then a multi-page chain drained.
    20_000,
  );
});
