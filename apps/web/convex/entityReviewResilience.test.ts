/**
 * NEO-99: the resilience layer that keeps the entity-review wizard from hanging
 * on "Looking up…" — everything EXCEPT the lookup itself, which is covered in
 * convex/wikidataEntityReviewQueue.test.ts.
 *
 *   - the deployment-wide Wikidata throttle constant (wikidataPool.ts): the pool
 *     is pinned to ≤5 concurrent SPARQL requests, Wikidata's per-IP ceiling. The
 *     workpool enforces `maxParallelism` at runtime inside the component (which
 *     convex-test cannot mount), so the testable surface is the configured value
 *     — the same shape as convex/preprocessCapacity.test.ts asserting the
 *     resolved parallelism constant rather than the pool's internal scheduler.
 *   - `backstopEntityReviewRowImpl` (entityReviewQueue.ts): the pool `onComplete`
 *     backstop that ages any still-`pending` row to "error", so an uncaught
 *     throw / action timeout / cancellation can never strand a row. Proven SAFE
 *     under batched-inline completions (the trap that stranded the NEO-170
 *     placeholder counter) because every completion writes its OWN distinct row.
 *   - `sweepStalePendingRows` (entityReviewQueue.ts): the cron last-resort that
 *     ages rows stuck `pending` past the staleness threshold, for the case where
 *     even the completion callback is lost.
 *   - streaming: `getBatch` reflects PARTIAL resolution (some ready, some still
 *     pending), which is what lets the wizard show "N of M reviewed · X still
 *     being looked up" advancing one row at a time instead of blocking on the
 *     whole batch.
 *
 * Root-level filename so convex-test's module registry resolves the function
 * paths, per the note on convex/placeholderCounterRace.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { RunResult } from "@convex-dev/workpool";
import {
  backstopEntityReviewRowImpl,
  ENTITY_REVIEW_STALE_MS,
} from "./entityReviewQueue";
import { WIKIDATA_MAX_PARALLELISM } from "./wikidataPool";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_review_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_review_001",
  role: "admin",
};

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

async function seedRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    name: string;
    status?: "pending" | "ready" | "error";
    enrichment?: { wikidataId?: string };
    decision?: { action: "create" };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: "user_review_001",
      kind: "player",
      name: opts.name,
      sportId: opts.selectorOptionId,
      status: opts.status ?? "pending",
      ...(opts.enrichment ? { enrichment: opts.enrichment } : {}),
      ...(opts.decision ? { decision: opts.decision } : {}),
    }),
  );
}

const getRow = (t: ReturnType<typeof convexTest>, id: Id<"entityReviewQueue">) =>
  t.run(async (ctx) => ctx.db.get(id));

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Throttle configuration — ≤5 concurrent Wikidata requests, deployment-wide
// ===========================================================================

describe("Wikidata throttle", () => {
  test("the pool is pinned to Wikidata's documented 5-parallel-per-IP ceiling", () => {
    // The whole fix rests on this being exactly 5: higher re-opens the hang
    // (Wikidata throttles the IP past 5 parallel), lower needlessly slows every
    // batch. The workpool enforces it at runtime; this locks the value the pool
    // is constructed with.
    expect(WIKIDATA_MAX_PARALLELISM).toBe(5);
  });
});

// ===========================================================================
// backstopEntityReviewRowImpl — no row can stay "pending" after completion
// ===========================================================================

const FAILED: RunResult = { kind: "failed", error: "boom" };
const CANCELED: RunResult = { kind: "canceled" };
const SUCCESS: RunResult = { kind: "success", returnValue: null };

describe("backstopEntityReviewRowImpl", () => {
  test("ages a still-pending row to 'error' when its work item ended in failure", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedRow(t, { selectorOptionId, batchId: "b", name: "Stranded", status: "pending" });

    await t.run((ctx) => backstopEntityReviewRowImpl(ctx, row, FAILED));

    expect((await getRow(t, row))!.status).toBe("error");
  });

  test("ages a still-pending row to 'error' when its work item was canceled", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedRow(t, { selectorOptionId, batchId: "b", name: "Canceled", status: "pending" });

    await t.run((ctx) => backstopEntityReviewRowImpl(ctx, row, CANCELED));

    expect((await getRow(t, row))!.status).toBe("error");
  });

  test("leaves an already-resolved 'ready' row untouched — never downgrades a real result", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedRow(t, {
      selectorOptionId,
      batchId: "b",
      name: "Resolved",
      status: "ready",
      enrichment: { wikidataId: "Q42" },
    });

    // The action already resolved it; the completion callback fires afterward
    // and must be a no-op.
    await t.run((ctx) => backstopEntityReviewRowImpl(ctx, row, SUCCESS));

    const r = await getRow(t, row);
    expect(r!.status).toBe("ready");
    expect(r!.enrichment?.wikidataId).toBe("Q42");
  });

  test("no-ops on a row deleted before completion (a Cancel raced the pool)", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedRow(t, { selectorOptionId, batchId: "b", name: "Gone", status: "pending" });
    await t.run(async (ctx) => ctx.db.delete(row));

    await expect(
      t.run((ctx) => backstopEntityReviewRowImpl(ctx, row, FAILED)),
    ).resolves.toBeNull();
  });

  test("preserves a decision on a pending row it ages (a bulk-created, still-looking-up row)", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const row = await seedRow(t, {
      selectorOptionId,
      batchId: "b",
      name: "BulkCreated",
      status: "pending",
      decision: { action: "create" },
    });

    await t.run((ctx) => backstopEntityReviewRowImpl(ctx, row, FAILED));

    const r = await getRow(t, row);
    expect(r!.status).toBe("error");
    // The user's "Add All Remaining as New" decision must survive the backstop.
    expect(r!.decision).toEqual({ action: "create" });
  });

  test("several completions in ONE transaction each resolve their OWN distinct row", async () => {
    // The NEO-170 placeholder counter bug was that the workpool settles several
    // onCompletes inside ONE transaction (Promise.all), and a shared-doc
    // read-modify-write there loses all but one update. This backstop is immune
    // because each completion writes only its own row — reproduce the batched
    // settle exactly and prove every row resolves.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const ids: Id<"entityReviewQueue">[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        await seedRow(t, { selectorOptionId, batchId: "b", name: `Row ${i}`, status: "pending" }),
      );
    }

    await t.run(async (ctx) => {
      await Promise.all(ids.map((id) => backstopEntityReviewRowImpl(ctx, id, FAILED)));
    });

    for (const id of ids) {
      expect((await getRow(t, id))!.status).toBe("error");
    }
  });
});

// ===========================================================================
// sweepStalePendingRows — the cron last-resort net
// ===========================================================================

describe("sweepStalePendingRows", () => {
  test("ages a row pending past the staleness threshold to 'error', leaving fresh and non-pending rows alone", async () => {
    // convex-test stamps `_creationTime` from Date.now() and clamps it to be
    // strictly increasing, so `base` must be AFTER real wall-clock now — a past
    // base would be clamped forward to now and the "old" rows would not be old.
    const base = Date.now() + 10 * 365 * 24 * 3600 * 1000; // ~10 years ahead
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const stale = await seedRow(t, { selectorOptionId, batchId: "b", name: "Stale", status: "pending" });
    // A row already resolved long ago must not be touched even though it is old.
    const oldResolved = await seedRow(t, { selectorOptionId, batchId: "b", name: "OldReady", status: "ready" });

    // Jump past the staleness threshold, then add a fresh pending row.
    vi.setSystemTime(base + ENTITY_REVIEW_STALE_MS + 60_000);
    const fresh = await seedRow(t, { selectorOptionId, batchId: "b", name: "Fresh", status: "pending" });

    const result = await t.mutation(internal.entityReviewQueue.sweepStalePendingRows, {});

    expect(result.aged).toBe(1);
    expect((await getRow(t, stale))!.status).toBe("error");
    expect((await getRow(t, fresh))!.status).toBe("pending"); // too young to age
    expect((await getRow(t, oldResolved))!.status).toBe("ready"); // not pending
  });

  test("a run with no stale rows ages nothing and does not self-schedule", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await seedRow(t, { selectorOptionId, batchId: "b", name: "Fresh1", status: "pending" });
    await seedRow(t, { selectorOptionId, batchId: "b", name: "Fresh2", status: "pending" });

    const result = await t.mutation(internal.entityReviewQueue.sweepStalePendingRows, {});

    expect(result).toEqual({ aged: 0, done: true });
  });
});

// ===========================================================================
// Streaming — getBatch reflects partial resolution as the pool drains
// ===========================================================================

describe("streaming via getBatch", () => {
  test("getBatch exposes a mix of resolved and still-pending rows so the wizard can stream progress", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const ids: Id<"entityReviewQueue">[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedRow(t, { selectorOptionId, batchId: "stream", name: `P${i}`, status: "pending" }),
      );
    }

    // The pool resolves rows one-by-one; simulate two landing.
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: ids[0],
      status: "ready",
      enrichment: { wikidataId: "Q1" },
    });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, { id: ids[2], status: "error" });

    const partial = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "stream",
    });
    // 2 resolved (1 ready + 1 error), 3 still pending — exactly the partial
    // state the wizard renders as "N of M reviewed · 3 still being looked up".
    expect(partial.filter((r) => r.status !== "pending")).toHaveLength(2);
    expect(partial.filter((r) => r.status === "pending")).toHaveLength(3);

    // One more resolves — the reactive query advances rather than waiting for
    // the whole batch, which is the anti-hang property.
    await t.mutation(internal.entityReviewQueue.applyLookupResult, { id: ids[1], status: "ready" });
    const advanced = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "stream",
    });
    expect(advanced.filter((r) => r.status === "pending")).toHaveLength(2);
  });
});
