/**
 * NEO-221 — `sweepAbandonedBatches` (convex/entityReviewQueue.ts), the hourly
 * cron that deletes review sessions nobody is coming back to.
 *
 * ## What makes this worth its own file
 *
 * Every other function in `entityReviewQueue.ts` is driven by an operator and
 * tested against what they just did. This one is driven by the CLOCK, and its
 * failure mode is asymmetric: sweeping too eagerly destroys an operator's
 * in-progress review (the exact loss NEO-220/221 exist to prevent), while
 * sweeping too late costs a few rows in a throwaway table. So most of what is
 * pinned below is the sweep DECLINING to delete.
 *
 * ## Why the clock is moved forward, not backward
 *
 * convex-test clamps `_creationTime` to be strictly increasing, so a row
 * inserted under a fake clock set into the PAST comes back stamped with real
 * wall-clock time and is never old enough for a 24-hour threshold. The base
 * here is therefore set AFTER the real `Date.now()`, and the test then moves
 * the clock forward from it — which is the only way a fake-timer test of a
 * time-based sweep behaves the way it reads.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  ENTITY_REVIEW_ABANDONED_MS,
  ENTITY_REVIEW_ABANDONED_SCAN,
} from "./entityReviewQueue";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_review_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_review_001",
  role: "admin",
};

/** Comfortably after real wall-clock now — see the file header. */
const BASE = Date.now() + 365 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedSelectorOption(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    name: string;
    createdByUserId?: string;
    lastTouchedAt?: number;
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: opts.createdByUserId ?? "user_review_001",
      kind: "player" as const,
      name: opts.name,
      sportId: opts.selectorOptionId,
      status: "ready" as const,
      ...(opts.lastTouchedAt !== undefined
        ? { lastTouchedAt: opts.lastTouchedAt }
        : {}),
    }),
  );
}

async function allRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("entityReviewQueue").collect());
}

describe("sweepAbandonedBatches", () => {
  test("deletes a batch whose every row has been silent past the threshold", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await insertRow(t, { selectorOptionId, batchId: "abandoned", name: "A" });
    await insertRow(t, { selectorOptionId, batchId: "abandoned", name: "B" });

    vi.setSystemTime(BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR);
    const result = await t.mutation(
      internal.entityReviewQueue.sweepAbandonedBatches,
      {},
    );

    expect(result).toEqual({ batches: 1, rows: 2, done: true });
    expect(await allRows(t)).toHaveLength(0);
  });

  test("leaves a batch alone while it is younger than the threshold", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await insertRow(t, { selectorOptionId, batchId: "fresh", name: "A" });

    // 23 hours in: a long review day is not an abandoned session.
    vi.setSystemTime(BASE + 23 * HOUR);
    const result = await t.mutation(
      internal.entityReviewQueue.sweepAbandonedBatches,
      {},
    );

    expect(result.batches).toBe(0);
    expect(await allRows(t)).toHaveLength(1);
  });

  test("ONE recently-touched row spares the whole batch", async () => {
    // The load-bearing rule. A batch is one session: a decision recorded ten
    // minutes ago is proof the operator is still working, even if the other
    // two hundred rows were inserted yesterday and never touched again.
    // Judging on the newest row alone, or on any row, would delete a review in
    // progress — the loss this whole ticket exists to prevent.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR;
    await insertRow(t, { selectorOptionId, batchId: "live", name: "A" });
    await insertRow(t, { selectorOptionId, batchId: "live", name: "B" });
    await insertRow(t, {
      selectorOptionId,
      batchId: "live",
      name: "C",
      // Decided a minute ago.
      lastTouchedAt: now - 60_000,
    });

    vi.setSystemTime(now);
    const result = await t.mutation(
      internal.entityReviewQueue.sweepAbandonedBatches,
      {},
    );

    expect(result.batches).toBe(0);
    expect(await allRows(t)).toHaveLength(3);
  });

  test("`lastTouchedAt` older than the threshold does NOT spare a batch", async () => {
    // The field is proof of life, not an exemption: a session touched 30 hours
    // ago is as over as one never touched at all.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + 6 * HOUR;
    await insertRow(t, {
      selectorOptionId,
      batchId: "abandoned",
      name: "A",
      lastTouchedAt: now - ENTITY_REVIEW_ABANDONED_MS - HOUR,
    });

    vi.setSystemTime(now);
    expect(
      (await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {}))
        .batches,
    ).toBe(1);
    expect(await allRows(t)).toHaveLength(0);
  });

  test("deletes only the abandoned batch, leaving a live one beside it untouched", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR;
    await insertRow(t, { selectorOptionId, batchId: "abandoned", name: "A" });
    await insertRow(t, {
      selectorOptionId,
      batchId: "live",
      name: "B",
      lastTouchedAt: now - 60_000,
    });

    vi.setSystemTime(now);
    await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {});

    const rows = await allRows(t);
    expect(rows.map((r) => r.batchId)).toEqual(["live"]);
  });

  test("two users' batches over the SAME set are judged separately", async () => {
    // Batches are scoped per (selectorOptionId, user) precisely so concurrent
    // sessions do not collide; the sweep has to keep that separation or one
    // operator walking away takes the other's review with them.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR;
    await insertRow(t, {
      selectorOptionId,
      batchId: "user-a-batch",
      name: "A",
      createdByUserId: "user_a",
    });
    await insertRow(t, {
      selectorOptionId,
      batchId: "user-b-batch",
      name: "B",
      createdByUserId: "user_b",
      lastTouchedAt: now - 60_000,
    });

    vi.setSystemTime(now);
    await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {});

    const rows = await allRows(t);
    expect(rows.map((r) => r.batchId)).toEqual(["user-b-batch"]);
  });

  test("an empty table is a no-op and schedules no continuation", async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR);

    expect(
      await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {}),
    ).toEqual({ batches: 0, rows: 0, done: true });
    expect(await scheduledSweeps(t)).toHaveLength(0);
  });

  test("a batch LARGER than one page is judged on all of its rows, and the walk continues", async () => {
    // Both halves of the pagination design in one fixture.
    //
    // (a) The page is a window over the table, and a first-time sync of a real
    //     set surfaces more names than fit in it. Judging a batch on the rows
    //     that happened to land inside the window would delete a live session
    //     whose recent activity sat just outside — so a page only NOMINATES,
    //     and the decision is taken over the batch re-read in full.
    //
    // (b) The rows this sweep does not delete stay exactly where they are, so
    //     without a cursor a deployment whose oldest page is one long review
    //     would re-examine it forever and never reach the abandoned batch
    //     behind it.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR;

    const bigBatch = ENTITY_REVIEW_ABANDONED_SCAN + 1;
    await t.run(async (ctx) => {
      for (let i = 0; i < bigBatch; i++) {
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId,
          batchId: "big-live",
          createdByUserId: "user_review_001",
          kind: "player" as const,
          name: `Name ${i}`,
          sportId: selectorOptionId,
          status: "ready" as const,
          // Only the very LAST row — the one guaranteed to fall outside the
          // first page — carries proof of life.
          ...(i === bigBatch - 1 ? { lastTouchedAt: now - 60_000 } : {}),
        });
      }
    });

    vi.setSystemTime(now);
    const first = await t.mutation(
      internal.entityReviewQueue.sweepAbandonedBatches,
      {},
    );

    // Nothing deleted: the out-of-page row said the session is alive.
    expect(first.batches).toBe(0);
    expect(first.done).toBe(false);
    // And the walk continues rather than restarting on the same page.
    const scheduled = await scheduledSweeps(t);
    expect(scheduled).toHaveLength(1);
    expect(typeof scheduled[0].cursor).toBe("string");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await allRows(t)).toHaveLength(bigBatch);
  });

  test("the continuation reaches a batch sitting behind a full page of live rows", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const now = BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR;

    await t.run(async (ctx) => {
      for (let i = 0; i < ENTITY_REVIEW_ABANDONED_SCAN; i++) {
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId,
          batchId: "big-live",
          createdByUserId: "user_review_001",
          kind: "player" as const,
          name: `Name ${i}`,
          sportId: selectorOptionId,
          status: "ready" as const,
          lastTouchedAt: now - 60_000,
        });
      }
    });
    // Inserted last, so it sits strictly behind that full first page.
    await insertRow(t, { selectorOptionId, batchId: "behind", name: "Z" });

    vi.setSystemTime(now);
    await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await allRows(t);
    expect(rows.every((r) => r.batchId === "big-live")).toBe(true);
    expect(rows).toHaveLength(ENTITY_REVIEW_ABANDONED_SCAN);
  });

  test("a cancelled or committed batch cannot be resumed after the sweep has run", async () => {
    // The point of the sweep, stated end to end: `startBatch` resumes any
    // batch it finds for a (selectorOptionId, user) pair, so an abandoned one
    // silently becomes the NEXT fetch's starting point — complete with
    // decisions taken against a card list that has moved on. After the sweep,
    // the next fetch is a fresh question with a new batchId.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const oldBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Long Forgotten"],
      teamNames: [],
    });

    vi.setSystemTime(BASE + ENTITY_REVIEW_ABANDONED_MS + HOUR);
    await t.mutation(internal.entityReviewQueue.sweepAbandonedBatches, {});

    const newBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Someone New"],
      teamNames: [],
    });

    expect(newBatchId).not.toBe(oldBatchId);
    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: newBatchId,
    });
    expect(rows.map((r) => r.name)).toEqual(["Someone New"]);
  });
});

/**
 * The pending self-scheduled continuations of this sweep, with their args —
 * the cursor is the whole point, so the function name alone is not enough.
 */
async function scheduledSweeps(
  t: ReturnType<typeof convexTest>,
): Promise<Array<{ cursor?: string }>> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<
                Array<{ name: string; args: Array<{ cursor?: string }> }>
              >;
            };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows
      .filter((r) => r.name === "entityReviewQueue:sweepAbandonedBatches")
      .map((r) => r.args[0]);
  });
}
