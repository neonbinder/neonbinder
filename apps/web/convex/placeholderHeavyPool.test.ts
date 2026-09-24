/**
 * The heavy warm-up fan-out itself (NEO-299).
 *
 * `placeholderWarmup.test.ts` and `placeholderEscalation.test.ts` can only
 * prove "zero heavy `/warmup` fetches fired directly" — convex-test cannot
 * mount the workpool's nested batch-worker component, so the real
 * `heavyPreprocessPool.enqueueActionBatch` RPC fails and is swallowed by
 * `enqueueHeavyWarmupsSafely` in placeholderBatch.ts. That property would
 * still hold if the heavy fan-out had been deleted outright — a batch that
 * never warms the heavy fleet also fires zero direct heavy fetches. This file
 * closes that gap by pinning the ENQUEUE itself, not just the absence of a
 * bypass.
 *
 * The seam that makes this observable without mounting the component:
 * `heavyPreprocessPool` (exported from placeholderHeavyPool.ts) is a real
 * `Workpool` *instance* — a plain JS object — so its `enqueueActionBatch`
 * method can be `vi.spyOn`'d directly, exactly like any other object method.
 * That is different from calling into the mounted component (which convex-test
 * cannot register): the spy replaces the client-side method before it ever
 * reaches the component RPC, and it is the SAME instance
 * `enqueueHeavyWarmups`'s handler closes over, because both this test file and
 * that handler resolve "./placeholderHeavyPool" to one cached module instance
 * within this file's environment.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { HEAVY_WARMUP_STATE_KEY, heavyPreprocessPool } from "./placeholderHeavyPool";
import { HEAVY_MAX_PARALLELISM } from "./preprocessCapacity";
import { HEAVY_WARMUP_WINDOW_MS } from "./lib/preprocessWarmup";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const FAST_URL = "http://localhost:9997";
const HEAVY_URL = "http://localhost:9998";

beforeEach(() => {
  // Loopback → the OIDC path short-circuits, so no google-auth-library.
  process.env.NEONBINDER_PREPROCESS_URL = HEAVY_URL;
  process.env.NEONBINDER_PREPROCESS_FAST_URL = FAST_URL;
});

afterEach(() => {
  delete process.env.NEONBINDER_PREPROCESS_URL;
  delete process.env.NEONBINDER_PREPROCESS_FAST_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * `warmupPreprocess` also fires PREPROCESS_MAX_PARALLELISM FAST warm-ups
 * directly (unrelated to this file's subject). Stub fetch to answer those and
 * throw loudly on anything that reaches the HEAVY url directly — the whole
 * point of routing heavy through the pool is that nothing does.
 */
function stubFastFetchOnly() {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith(HEAVY_URL)) {
        throw new Error(
          `unexpected DIRECT fetch to the heavy service (${u}) — heavy warm-ups must go through the pool`,
        );
      }
      return new Response(JSON.stringify({ status: "warm" }), { status: 200 });
    }) as unknown as typeof fetch,
  );
}

/** Spy on the pool's batch enqueue, returning one fake work id per item. */
function spyOnEnqueueActionBatch() {
  return vi
    .spyOn(heavyPreprocessPool, "enqueueActionBatch")
    .mockImplementation(async (_ctx: unknown, _fn: unknown, items: unknown[]) =>
      items.map((_, i) => `work-${i}`),
    );
}

describe("enqueueHeavyWarmups — the fan-out itself", () => {
  test("enqueues exactly HEAVY_MAX_PARALLELISM x warmHeavyWorker, with retry:false and no onComplete", async () => {
    const t = convexTest(schema, modules);
    const spy = spyOnEnqueueActionBatch();

    const result = await t.mutation(internal.placeholderHeavyPool.enqueueHeavyWarmups, {});

    expect(result).toEqual({ enqueued: HEAVY_MAX_PARALLELISM });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, fnRef, items, opts] = spy.mock.calls[0] as [unknown, unknown, unknown[], unknown];
    expect(getFunctionName(fnRef as never)).toBe("placeholderBatch:warmHeavyWorker");
    expect(items).toHaveLength(HEAVY_MAX_PARALLELISM);
    expect(opts).toEqual({ retry: false });
    expect(opts).not.toHaveProperty("onComplete");
  });

  test("warmupPreprocess (batch start / warm-on-intent) routes the heavy fan-out through the pool", async () => {
    const t = convexTest(schema, modules);
    stubFastFetchOnly();
    const spy = spyOnEnqueueActionBatch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.action(internal.placeholderBatch.warmupPreprocess, {});
    warn.mockRestore();

    expect(spy).toHaveBeenCalledTimes(1);
    const items = spy.mock.calls[0][2] as unknown[];
    expect(items).toHaveLength(HEAVY_MAX_PARALLELISM);
  });

  test("warmupHeavyPreprocess (the first-escalation warm-gate) routes through the pool the same way", async () => {
    const t = convexTest(schema, modules);
    const spy = spyOnEnqueueActionBatch();

    await t.action(internal.placeholderBatch.warmupHeavyPreprocess, {});

    expect(spy).toHaveBeenCalledTimes(1);
    const items = spy.mock.calls[0][2] as unknown[];
    expect(items).toHaveLength(HEAVY_MAX_PARALLELISM);
  });
});

// ---------------------------------------------------------------------------
// Retry ladder (NEO-299) — pinned so a future edit that shortens it fails
// loudly, with a message that explains why the shape matters.
// ---------------------------------------------------------------------------

describe("heavy pool retry configuration", () => {
  test("pins maxAttempts 5, initialBackoffMs 40000, base 2", () => {
    expect(heavyPreprocessPool.options.defaultRetryBehavior).toEqual({
      maxAttempts: 5,
      initialBackoffMs: 40_000,
      base: 2,
    });
    expect(heavyPreprocessPool.options.retryActionsByDefault).toBe(true);
    expect(heavyPreprocessPool.options.maxParallelism).toBe(HEAVY_MAX_PARALLELISM);
  });

  test("the ladder's minimum total backoff outlasts a ~240s cold model load", () => {
    // Mirrors the arithmetic in the placeholderHeavyPool.ts comment: after the
    // k-th failed attempt the next start is delayed by
    //   initialBackoffMs * base^(k-1) * jitter,  jitter uniform in [0.5, 1.5)
    // so across the 4 backoffs between 5 attempts (k=1..4, i.e. base^0..base^3)
    // even the SHORTEST jitter must still clear a cold load. If a future edit
    // shortens maxAttempts, initialBackoffMs or base, this is the test that
    // explains why the number moved is a regression, not a cleanup.
    const { maxAttempts, initialBackoffMs, base } = heavyPreprocessPool.options
      .defaultRetryBehavior as { maxAttempts: number; initialBackoffMs: number; base: number };

    const backoffCount = maxAttempts - 1; // attempts are separated by (maxAttempts - 1) backoffs
    const nominalTotalMs = Array.from({ length: backoffCount }, (_, k) => initialBackoffMs * base ** k).reduce(
      (a, b) => a + b,
      0,
    );
    const MIN_JITTER = 0.5;
    const minTotalBackoffMs = nominalTotalMs * MIN_JITTER;

    const COLD_LOAD_MS = 240_000;
    expect(minTotalBackoffMs).toBeGreaterThanOrEqual(COLD_LOAD_MS);
  });
});

// ---------------------------------------------------------------------------
// The deployment-wide warm-up window (security review C1, NEO-299).
//
// `warmPreprocess` is public to any signed-in user, and every heavy fan-out
// puts HEAVY_MAX_PARALLELISM items on the SHARED heavy pool, ahead of every
// user's escalations. Without a window, a caller looping it grows that queue
// without bound. These pin that only the first fan-out in a window reaches the
// pool, from every entry point, and that the window really does reopen.
// ---------------------------------------------------------------------------

/** Total warm-up items handed to the pool across every spied call. */
function itemsEnqueued(spy: ReturnType<typeof spyOnEnqueueActionBatch>): number {
  return spy.mock.calls.reduce((sum, call) => sum + (call[2] as unknown[]).length, 0);
}

/** Run all scheduled functions to completion under fake timers. */
async function drain(t: ReturnType<typeof convexTest>): Promise<void> {
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

describe("enqueueHeavyWarmups — deployment-wide window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("two back-to-back warmPreprocess calls put exactly N heavy items on the pool, not 2N", async () => {
    const t = convexTest(schema, modules);
    stubFastFetchOnly();
    const spy = spyOnEnqueueActionBatch();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const user = t.withIdentity({ subject: "user_windowAAAA1111" });

    await user.action(api.placeholderPipeline.warmPreprocess, {});
    await user.action(api.placeholderPipeline.warmPreprocess, {});
    await drain(t);

    expect(itemsEnqueued(spy)).toBe(HEAVY_MAX_PARALLELISM);
    // The second fan-out was skipped, and said so in the operator log.
    const skipped = log.mock.calls
      .map((c) => c[0])
      .filter((l): l is string => typeof l === "string" && l.includes("preprocess_heavy_warmup_skipped"))
      .map((l) => JSON.parse(l) as { msg: string; reason: string });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ msg: "preprocess_heavy_warmup_skipped", reason: "window" });
  });

  test("the window reopens exactly HEAVY_WARMUP_WINDOW_MS after the last fan-out", async () => {
    const t = convexTest(schema, modules);
    const spy = spyOnEnqueueActionBatch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Only Date is faked: convex-test's own scheduling runs on real timers.
    // The base is AFTER real wall-clock now, because convex-test clamps
    // _creationTime to be strictly increasing.
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now() + 60_000;
    vi.setSystemTime(base);

    const call = () => t.mutation(internal.placeholderHeavyPool.enqueueHeavyWarmups, {});

    expect(await call()).toEqual({ enqueued: HEAVY_MAX_PARALLELISM });

    vi.setSystemTime(base + HEAVY_WARMUP_WINDOW_MS - 1);
    expect(await call()).toEqual({ enqueued: 0 });

    vi.setSystemTime(base + HEAVY_WARMUP_WINDOW_MS);
    expect(await call()).toEqual({ enqueued: HEAVY_MAX_PARALLELISM });

    // …and the reopened fan-out starts a NEW window from its own time.
    vi.setSystemTime(base + HEAVY_WARMUP_WINDOW_MS + 1);
    expect(await call()).toEqual({ enqueued: 0 });

    expect(itemsEnqueued(spy)).toBe(2 * HEAVY_MAX_PARALLELISM);
    const rows = await t.run(async (ctx) => ctx.db.query("preprocessWarmupState").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: HEAVY_WARMUP_STATE_KEY,
      heavyWarmEnqueuedAt: base + HEAVY_WARMUP_WINDOW_MS,
    });
  });

  test("the first-escalation warm-gate goes through the same window", async () => {
    const t = convexTest(schema, modules);
    stubFastFetchOnly();
    const spy = spyOnEnqueueActionBatch();
    vi.spyOn(console, "log").mockImplementation(() => {});

    // A batch start (or page mount) warms the fleet…
    await t.action(internal.placeholderBatch.warmupPreprocess, {});
    // …then two batches escalate for the first time inside the same window.
    await t.action(internal.placeholderBatch.warmupHeavyPreprocess, {});
    await t.action(internal.placeholderBatch.warmupHeavyPreprocess, {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(itemsEnqueued(spy)).toBe(HEAVY_MAX_PARALLELISM);
  });

  test("a fan-out whose enqueue fails does not hold the window shut", async () => {
    // The timestamp is written in the same transaction as the enqueue, so a
    // throwing enqueue rolls it back and the next caller still warms.
    const t = convexTest(schema, modules);
    const spy = spyOnEnqueueActionBatch();
    spy.mockRejectedValueOnce(new Error("pool unavailable"));

    await expect(
      t.mutation(internal.placeholderHeavyPool.enqueueHeavyWarmups, {}),
    ).rejects.toThrow(/pool unavailable/);
    expect(await t.run(async (ctx) => ctx.db.query("preprocessWarmupState").collect())).toHaveLength(0);

    expect(await t.mutation(internal.placeholderHeavyPool.enqueueHeavyWarmups, {})).toEqual({
      enqueued: HEAVY_MAX_PARALLELISM,
    });
  });
});
