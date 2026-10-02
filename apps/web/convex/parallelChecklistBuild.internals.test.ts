/**
 * NEO-312 — the internal mutations behind `buildParallelChecklist`, exercised
 * directly rather than through the action: the insert-page concurrency guard,
 * the delete-page per-page block guard, and clearing a parallel's abandoned
 * review state (stale vs. a live session).
 *
 * No marketplace adapter is involved here, so unlike
 * `parallelChecklistBuild.test.ts` this file mocks nothing — every call goes
 * straight at the internal mutation/query under test.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BLOCKED_SCANS,
  REVIEW_ACTIVE_WINDOW_MS,
} from "./parallelChecklistBuild";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

async function seedTree(t: T) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const insert = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Anime",
      parentId: sport,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const parallel = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Anime Kanji",
      parentId: insert,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(insert, { children: [parallel] });
    return { sport, insert, parallel };
  });
}

async function insertCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  card: Partial<Doc<"cardChecklist">> & { cardNumber: string; cardName: string },
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
      ...card,
    }),
  );
}

const cardsOn = (t: T, selectorOptionId: Id<"selectorOptions">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", selectorOptionId))
      .collect(),
  );

// ---------------------------------------------------------------------------

describe("insertParallelCardsPage — the concurrency guard", () => {
  test("with no firstCreatedId, the parallel must hold no cards — one already there means changed", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const sourceId = await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });
    // Simulate a concurrent build that already created a card on the parallel.
    await insertCard(t, parallel, { cardNumber: "1", cardName: "Someone" });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        copies: [
          {
            sourceCardId: sourceId,
            expect: { cardNumber: "1", cardName: "Someone", namesOnCard: [] },
            bsc: { ref: "bsc-1" },
          },
        ],
        remap: [],
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.created).toEqual([]);
  });

  test("with no firstCreatedId and the parallel genuinely empty, the page proceeds", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const sourceId = await insertCard(t, insert, { cardNumber: "1", cardName: "Someone" });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        copies: [
          {
            sourceCardId: sourceId,
            expect: { cardNumber: "1", cardName: "Someone", namesOnCard: [] },
            bsc: { ref: "bsc-1" },
          },
        ],
        remap: [],
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.created).toHaveLength(1);
  });

  test("a later page requires the run's own firstCreatedId to still exist on the parallel", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const sourceId = await insertCard(t, insert, { cardNumber: "2", cardName: "Someone Else" });
    // A card claiming to be "this run's first created card" that does not
    // exist at all — the run that made it must have lost the race.
    const fakeFirstCreatedId = sourceId as unknown as Id<"cardChecklist">; // any id, just not on the parallel

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        firstCreatedId: fakeFirstCreatedId,
        copies: [
          {
            sourceCardId: sourceId,
            expect: { cardNumber: "2", cardName: "Someone Else", namesOnCard: [] },
            bsc: { ref: "bsc-2" },
          },
        ],
        remap: [],
      }),
    );
    // sourceId lives on the INSERT, not the parallel — the guard rejects it.
    expect(result.changed).toBe(true);
  });

  test("a later page proceeds once the run's own firstCreatedId is confirmed still on the parallel", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const firstCreatedId = await insertCard(t, parallel, { cardNumber: "1", cardName: "First" });
    const sourceId = await insertCard(t, insert, { cardNumber: "2", cardName: "Second" });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        firstCreatedId,
        copies: [
          {
            sourceCardId: sourceId,
            expect: { cardNumber: "2", cardName: "Second", namesOnCard: [] },
            bsc: { ref: "bsc-2" },
          },
        ],
        remap: [],
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.created).toHaveLength(1);
  });

  test("a source card that changed since it was linked is skipped, not copied on a stale match", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const sourceId = await insertCard(t, insert, { cardNumber: "1", cardName: "Edited Since" });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        copies: [
          {
            sourceCardId: sourceId,
            // The action linked it under a DIFFERENT name than it now holds.
            expect: { cardNumber: "1", cardName: "Original Name", namesOnCard: [] },
            bsc: { ref: "bsc-1" },
          },
        ],
        remap: [],
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.skippedChangedSource).toBe(1);
    expect(result.created).toEqual([]);
  });

  test("a source card gone entirely is counted missing", async () => {
    const t = convexTest(schema, modules);
    const { insert, parallel } = await seedTree(t);
    const sourceId = await insertCard(t, insert, { cardNumber: "1", cardName: "Gone Soon" });
    await t.run((ctx) => ctx.db.delete(sourceId));

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
        parallelId: parallel,
        insertId: insert,
        copies: [
          {
            sourceCardId: sourceId,
            expect: { cardNumber: "1", cardName: "Gone Soon", namesOnCard: [] },
            bsc: { ref: "bsc-1" },
          },
        ],
        remap: [],
      }),
    );
    expect(result.missing).toBe(1);
    expect(result.created).toEqual([]);
  });
});

describe("deleteParallelCardsPage — the per-page block guard", () => {
  test("a page with a scanned card refuses to delete anything on it, including its fine siblings", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    const fine = await insertCard(t, parallel, { cardNumber: "1", cardName: "Fine" });
    const scanned = await insertCard(t, parallel, {
      cardNumber: "2",
      cardName: "Scanned",
      imageUrls: { front: "gs://bucket/front.jpg" },
    });

    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.deleteParallelCardsPage, { parallelId: parallel }),
    );
    expect(page.deleted).toBe(0);
    expect(page.blockedReason).toBe(BLOCKED_SCANS);
    const remaining = await cardsOn(t, parallel);
    expect(remaining.map((c) => c._id).sort()).toEqual([fine, scanned].sort());
  });

  test("a card scanned in between two calls blocks only the page it appears on, after the first page already deleted cleanly", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    const untouched = await insertCard(t, parallel, { cardNumber: "1", cardName: "Fine" });

    const firstPage = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.deleteParallelCardsPage, { parallelId: parallel }),
    );
    expect(firstPage.deleted).toBe(1);
    expect(firstPage.blockedReason).toBeUndefined();
    expect(await cardsOn(t, parallel)).toHaveLength(0);

    // A scan "appears" between the two calls — an operator uploaded one while
    // the rebuild was mid-flight.
    const laterCard = await insertCard(t, parallel, {
      cardNumber: "2",
      cardName: "Scanned Mid-Build",
      imageUrls: { front: "gs://bucket/front.jpg" },
    });

    const secondPage = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.deleteParallelCardsPage, { parallelId: parallel }),
    );
    expect(secondPage.deleted).toBe(0);
    expect(secondPage.blockedReason).toBe(BLOCKED_SCANS);
    // The caller (buildParallelChecklist) would see deletedTotal=1 (from the
    // first page) and this second page's block, which is exactly the
    // BLOCKED_CHANGED_MID_BUILD condition (`deletedTotal > 0`).
    expect(await cardsOn(t, parallel)).toEqual([expect.objectContaining({ _id: laterCard })]);
    expect(untouched).not.toBe(laterCard);
  });
});

describe("clearStaleReviewState / clearParallelReviewPage — abandoned vs live review", () => {
  async function seedCandidate(t: T, parallel: Id<"selectorOptions">, creationOffsetMs: number) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("checklistCandidates", {
        selectorOptionId: parallel,
        batchId: "batch-1",
        createdByUserId: "user-1",
        cardNumber: "1",
        cardName: "Whoever",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL,
      });
      // convex-test's `_creationTime` is the real insert time; there is no
      // supported way to backdate it, so "stale" is simulated with a cutoff
      // computed forward of `Date.now()` instead of backdating the row — see
      // the test below for how cutoff is derived.
      return { id, creationOffsetMs };
    });
  }

  test("a candidate row older than the review window is cleared, and the build proceeds", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await seedCandidate(t, parallel, 0);

    // Emulate "older than 15 minutes" by using a cutoff in the FUTURE relative
    // to the row's real creation time, exactly as `clearStaleReviewState`
    // computes `Date.now() - REVIEW_ACTIVE_WINDOW_MS` would if 15 minutes had
    // actually passed.
    const cutoff = Date.now() + 1;
    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.clearParallelReviewPage, {
        parallelId: parallel,
        cutoff,
      }),
    );
    expect(page.live).toBe(false);
    expect(page.candidates).toBe(1);
    const remaining = await t.run((ctx) =>
      ctx.db
        .query("checklistCandidates")
        .withIndex("by_selector_option_and_user", (q) => q.eq("selectorOptionId", parallel))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  test("a candidate row fresh within the window is left alone and reported live", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await seedCandidate(t, parallel, 0);

    // A cutoff BEFORE the row's real creation time — i.e. the row is within
    // the active window relative to it, the fresh-tab case.
    const cutoff = Date.now() - REVIEW_ACTIVE_WINDOW_MS;
    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.clearParallelReviewPage, {
        parallelId: parallel,
        cutoff,
      }),
    );
    expect(page.live).toBe(true);
    expect(page.candidates).toBe(0);
    const remaining = await t.run((ctx) =>
      ctx.db
        .query("checklistCandidates")
        .withIndex("by_selector_option_and_user", (q) => q.eq("selectorOptionId", parallel))
        .collect(),
    );
    expect(remaining).toHaveLength(1);
  });

  test("clearing review state never touches players, teams, cardChecklist rows or entityReviewSkips", async () => {
    const t = convexTest(schema, modules);
    const { sport, parallel } = await seedTree(t);
    await seedCandidate(t, parallel, 0);
    const playerId = await t.run((ctx) =>
      ctx.db.insert("players", {
        name: "Ken Griffey Jr.",
        nameNormalized: "ken griffey",
        sportId: sport,
        lastUpdated: SENTINEL,
      }),
    );
    const teamId = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sportId: sport,
        lastUpdated: SENTINEL,
      }),
    );
    const skipId = await t.run((ctx) =>
      ctx.db.insert("entityReviewSkips", {
        selectorOptionId: parallel,
        kind: "player",
        nameNormalized: "some skipped name",
        name: "Some Skipped Name",
        skippedAt: SENTINEL,
        skippedByUserId: "user-1",
      }),
    );
    const cardId = await insertCard(t, parallel, { cardNumber: "1", cardName: "Untouched" });

    const cutoff = Date.now() + 1;
    await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.clearParallelReviewPage, {
        parallelId: parallel,
        cutoff,
      }),
    );

    expect(await t.run((ctx) => ctx.db.get(playerId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(teamId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(skipId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(cardId))).not.toBeNull();
  });

  test("an entityReviewQueue row older than the window is cleared once the candidates page is empty", async () => {
    const t = convexTest(schema, modules);
    const { sport, parallel } = await seedTree(t);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: parallel,
        batchId: "batch-1",
        createdByUserId: "user-1",
        kind: "player",
        name: "Some Unresolved Name",
        sportId: sport,
        status: "pending",
      }),
    );

    const cutoff = Date.now() + 1;
    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.clearParallelReviewPage, {
        parallelId: parallel,
        cutoff,
      }),
    );
    expect(page.live).toBe(false);
    expect(page.reviewRows).toBe(1);
    expect(await t.run((ctx) => ctx.db.get(rowId))).toBeNull();
  });

  test("a live entityReviewQueue row (touched within the window) blocks and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sport, parallel } = await seedTree(t);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: parallel,
        batchId: "batch-1",
        createdByUserId: "user-1",
        kind: "player",
        name: "Someone Actively Being Reviewed",
        sportId: sport,
        status: "pending",
        lastTouchedAt: Date.now(),
      }),
    );

    const cutoff = Date.now() - REVIEW_ACTIVE_WINDOW_MS;
    const page = await t.run((ctx) =>
      ctx.runMutation(internal.parallelChecklistBuild.clearParallelReviewPage, {
        parallelId: parallel,
        cutoff,
      }),
    );
    expect(page.live).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(rowId))).not.toBeNull();
  });
});
