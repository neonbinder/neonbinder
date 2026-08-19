/**
 * Warm-on-start / warm-on-intent tests (NEO-170).
 *
 * Cold-starting the preprocess service costs a multi-minute BiRefNet load, and
 * the fix is to trigger that load BEFORE the first real image needs it:
 *
 *   - `warmupPreprocess` (internal): fires PREPROCESS_MAX_PARALLELISM warm-ups
 *     CONCURRENTLY. One warm-up warms one instance (container_concurrency = 1),
 *     so N concurrent calls spread across all N instances Cloud Run will run.
 *   - Both start paths schedule it fire-and-forget, so the model loads while a
 *     zip extracts / a scanner collects.
 *   - `warmPreprocess` (public, authed): lets a client fire the same fan-out
 *     even earlier — on upload-page mount, or at CLI `yarn start` — before a job
 *     exists at all.
 *
 * The properties that matter and are pinned here:
 *   - the fan-out is genuinely CONCURRENT and exactly N wide (a barrier stub
 *     that only completes if all N are in flight at once);
 *   - nothing about warm-up can fail a start or a page mount (throwing fetch is
 *     swallowed; a start still succeeds; the job row is untouched);
 *   - the public action refuses an unauthenticated caller and returns promptly.
 *
 * The adapter-level `callWarmup` (headers, telemetry, 2xx handling, swallowing)
 * is tested in convex/adapters.preprocess.test.ts; this file is the pipeline
 * wiring.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { PREPROCESS_MAX_PARALLELISM } from "./preprocessCapacity";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_warmAAAA1111" };

const WARMUP_FN = "placeholderBatch:warmupPreprocess";

beforeEach(() => {
  process.env.TESTING_RESET_SECRET = "test-enabled";
  // Loopback → the OIDC path short-circuits, so no google-auth-library.
  process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
});

afterEach(() => {
  delete process.env.TESTING_RESET_SECRET;
  delete process.env.NEONBINDER_PREPROCESS_URL;
  vi.unstubAllGlobals();
  // Belt-and-suspenders against a test that enabled fake timers leaving pending
  // timers (or the fake-timer mode itself) visible to the next test's drain.
  vi.useRealTimers();
});

/**
 * A fetch stub that PROVES concurrency: every call blocks until all `n` have
 * entered, then they all release together. If the warm-ups were fired
 * sequentially (await each before the next), the first would block waiting for
 * an `n`th that never starts — so a passing test is proof they overlapped.
 * `maxInFlight` records the peak.
 */
function makeWarmupBarrier(n: number, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((r) => {
    release = r;
  });

  const stub = async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (!u.endsWith("/warmup")) throw new Error(`unexpected fetch: ${u}`);
    calls.push(u);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started += 1;
    if (started >= n) release();
    await allStarted;
    inFlight -= 1;
    if (opts.fail) throw new TypeError("network down");
    return new Response(JSON.stringify({ status: "warm" }), { status: 200 });
  };
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);

  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/**
 * A plain counting stub, for tests that drive the fan-out through
 * `finishAllScheduledFunctions` rather than a direct `t.action`. The barrier
 * above deadlock-proves concurrency but its promise-blocking does not play well
 * with the drainer's fake-timer loop; concurrency is proven directly in the
 * `warmupPreprocess` test, so the drain tests only need to count and swallow.
 */
function makeWarmupCounter(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const stub = async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (!u.endsWith("/warmup")) throw new Error(`unexpected fetch: ${u}`);
    calls.push(u);
    if (opts.fail) throw new TypeError("network down");
    return new Response(JSON.stringify({ status: "warm", was_cold: true }), { status: 200 });
  };
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
  return { calls };
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

/**
 * A stub for draining a zip-batch start: /warmup 2xx, and /extract a terminal
 * 404 so `runExtract` fails fast and the batch settles without a deep cascade.
 * Lets the startPlaceholderBatch test assert the warm-up schedule AND drain
 * cleanly (the shared scheduler queue must be left empty for the next test).
 */
function makeBatchStartStub() {
  const warmups: string[] = [];
  const stub = async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u.endsWith("/warmup")) {
      warmups.push(u);
      return new Response(JSON.stringify({ status: "warm" }), { status: 200 });
    }
    // /extract → terminal, so runExtract marks the job failed and stops.
    return new Response(JSON.stringify({ error_code: "INPUT_NOT_FOUND" }), { status: 404 });
  };
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
  return { warmups };
}

/** The scheduled-function rows convex-test exposes, by function name. */
async function scheduledNames(t: ReturnType<typeof convexTest>): Promise<string[]> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: { system: { query: (n: string) => { collect: () => Promise<Array<{ name: string }>> } } };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.map((r) => r.name);
  });
}

// ---------------------------------------------------------------------------
// warmupPreprocess — the shared N-concurrent fan-out
// ---------------------------------------------------------------------------

describe("warmupPreprocess", () => {
  test("fires exactly PREPROCESS_MAX_PARALLELISM warm-ups, all concurrently", async () => {
    const t = convexTest(schema, modules);
    const N = PREPROCESS_MAX_PARALLELISM;
    const barrier = makeWarmupBarrier(N);

    await t.action(internal.placeholderBatch.warmupPreprocess, {});

    // One warm-up per instance the pool will run, and all in flight at once —
    // which is the whole point, because one warm-up warms one instance.
    expect(barrier.calls).toHaveLength(N);
    expect(barrier.maxInFlight).toBe(N);
  });

  test("a throwing fetch is swallowed — the action still resolves", async () => {
    const t = convexTest(schema, modules);
    const N = PREPROCESS_MAX_PARALLELISM;
    makeWarmupBarrier(N, { fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Every warm-up throws inside; the fan-out must not.
    await expect(
      t.action(internal.placeholderBatch.warmupPreprocess, {}),
    ).resolves.toBeNull();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// warmPreprocess — the public, authed, warm-on-intent action
// ---------------------------------------------------------------------------

describe("warmPreprocess", () => {
  test("refuses an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(api.placeholderPipeline.warmPreprocess, {}),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("returns { warming: true } and schedules the fan-out, without running it inline", async () => {
    const t = convexTest(schema, modules);
    const counter = makeWarmupCounter();

    const result = await t
      .withIdentity(USER_A)
      .action(api.placeholderPipeline.warmPreprocess, {});

    expect(result).toEqual({ warming: true });
    // NOT run inline — zero warm-ups have fired at the point the action returns.
    // This is what "returns promptly / never blocks" means: the up-to-a-minute
    // warm-ups are queued for the background.
    expect(counter.calls).toHaveLength(0);
    expect(await scheduledNames(t)).toContain(WARMUP_FN);

    // Drain to clean up (the scheduler queue is shared across `t` within a file
    // run, so a left-behind schedule would leak into the next test).
    await drain(t);
    expect(counter.calls).toHaveLength(PREPROCESS_MAX_PARALLELISM);
  });

  test("end to end, fires PREPROCESS_MAX_PARALLELISM warm-ups when the scheduled fan-out runs", async () => {
    // The public action → scheduled fan-out → N warm-up calls, proven through a
    // real drain. Concurrency of those N is proven by the direct
    // `warmupPreprocess` test; here we prove the wiring and the count.
    const t = convexTest(schema, modules);
    const N = PREPROCESS_MAX_PARALLELISM;
    const counter = makeWarmupCounter();

    await t.withIdentity(USER_A).action(api.placeholderPipeline.warmPreprocess, {});
    await drain(t);

    expect(counter.calls).toHaveLength(N);
  });

  test("a warm-up failure never reaches the caller", async () => {
    const t = convexTest(schema, modules);
    makeWarmupCounter({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The action returns before the fan-out runs, so it is unaffected regardless;
    // draining then exercises the swallow, which must also not throw.
    const result = await t
      .withIdentity(USER_A)
      .action(api.placeholderPipeline.warmPreprocess, {});
    expect(result).toEqual({ warming: true });

    await expect(drain(t)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Warm on start — a backstop for clients that never call warmPreprocess
// ---------------------------------------------------------------------------

describe("both start paths warm the service", () => {
  test("startPlaceholderStream schedules the warm-up fan-out", async () => {
    const t = convexTest(schema, modules);
    const counter = makeWarmupCounter();

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    expect(result.started).toBe(true);

    expect(await scheduledNames(t)).toContain(WARMUP_FN);

    // Drain to clean up, and confirm end to end that it warms N instances.
    await drain(t);
    expect(counter.calls).toHaveLength(PREPROCESS_MAX_PARALLELISM);
  });

  test("startPlaceholderBatch schedules the warm-up fan-out", async () => {
    const t = convexTest(schema, modules);
    const stub = makeBatchStartStub();
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderJobs", {
        jobId: "job-warm",
        userId: USER_A.subject,
        objectPath: `placeholders/${USER_A.subject}/job-warm/input.zip`,
        createdAt: 1_700_000_000_000,
        mode: "zip",
        status: "uploaded",
      });
    });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-warm" });
    expect(result.started).toBe(true);

    expect(await scheduledNames(t)).toContain(WARMUP_FN);

    // Drain (runExtract fails terminally on the 404, warm-up fires) to leave the
    // shared queue empty for the next test.
    await drain(t);
    expect(stub.warmups).toHaveLength(PREPROCESS_MAX_PARALLELISM);
  });

  test("a start returns promptly and stays successful even when every warm-up fails", async () => {
    // The fire-and-forget guarantee: the start already returned before the
    // warm-up runs, and draining a throwing fan-out neither throws nor disturbs
    // the job. Stream path, because it schedules ONLY the warm-up (no extract),
    // so draining exercises exactly the warm-up.
    const t = convexTest(schema, modules);
    makeWarmupCounter({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    // The start succeeded regardless of what the (not-yet-run) warm-up will do.
    expect(result.started).toBe(true);
    const jobId = result.jobId!;

    await expect(drain(t)).resolves.toBeUndefined();
    warn.mockRestore();

    // The job is exactly where the start left it — warm-up touched no state.
    const job = await t.run(async (ctx) => {
      const jobs = await ctx.db.query("placeholderJobs").collect();
      return jobs.find((j) => j.jobId === jobId) ?? null;
    });
    expect(job?.status).toBe("collecting");
  });
});
