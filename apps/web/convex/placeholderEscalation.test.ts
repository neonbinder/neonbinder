/**
 * Escalation routing, the heavy warm-gate, and the cold-start notification
 * (NEO-175 Phase 2).
 *
 * The seam under test is the same one the fast/heavy onComplete hooks call —
 * `recordImageOutcomeImpl` — driven directly, exactly as convex/placeholderPipeline.test.ts
 * drives the non-escalation completion path. convex-test cannot mount either
 * workpool component, so the escalation branch SCHEDULES the heavy enqueue and
 * the heavy warm-gate rather than touching the heavy pool inline; these tests
 * assert on the scheduled-function rows (never draining them, which would run
 * `enqueueHeavyImage` → the unmounted heavy component). The actual heavy enqueue
 * and the cancel-of-an-escalated-row are the two pool-touching paths left to
 * integration, mirroring how the fast `enqueueImageChunk` is.
 *
 * Filename lives at the `convex/` root so convex-test's module registry resolves
 * the function paths, per the note on convex/placeholderPipeline.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  deriveHeavyWarming,
  readNeedsEscalation,
  recordImageOutcomeImpl,
} from "./placeholderPipeline";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_escAAAA1111" };

const ENQUEUE_HEAVY_FN = "placeholderHeavyPool:enqueueHeavyImage";
const HEAVY_WARMUP_FN = "placeholderBatch:warmupHeavyPreprocess";
/**
 * NEO-239 — the third thing a settle can queue, and the one nothing asserted.
 * A batch whose last image settles goes to `pairing` and schedules this; that
 * unasserted, unowned action is what leaked past teardown.
 */
const PAIRING_FN = "placeholderPairing:runPairing";

const HEAVY_URL = "http://localhost:9998";

/**
 * NEO-239 — the SECOND scheduled-work leak in this file, and a different
 * function from the first.
 *
 * `drain()` below was added for `placeholderBatch:warmupHeavyPreprocess`. It
 * covers the three tests that call it and nothing else, and the settle path
 * these tests drive queues more than the warm-gate: when the last image of a
 * batch settles, `recordImageOutcomeImpl` schedules
 * `placeholderPairing:runPairing`. Nothing owned that, so it fired after the
 * file's environment had been torn down and surfaced in a full run as
 *
 *   Error when running scheduled function placeholderPairing:runPairing
 *   EnvironmentTeardownError: Cannot load '/convex/lib/pairing/pool.ts'
 *   imported from …/convex/lib/pairing/pairBatch.ts after the environment was
 *   torn down
 *
 * `pool.ts` and `pairBatch.ts` are the same import chain one level apart —
 * `pairBatch` imports `pool` — so the module the message names says how far
 * loading had got, not which test queued the work. This is the SAME class as
 * placeholderPipeline.test.ts's `runPairing` leak, in a second file.
 *
 * CANCELLED rather than drained, and this file is the reason the distinction
 * exists: as its header says, these tests assert on the scheduled-function
 * ROWS and must not run them, because draining would reach
 * `placeholderHeavyPool:enqueueHeavyImage` on a workpool component convex-test
 * cannot mount. Cancelling settles the queue without running anything, so the
 * assertions above it are untouched and no unmounted component is reached.
 *
 * It reproduces about one full run in three on this machine — the pending
 * action only outlives teardown when the worker is loaded enough for its timer
 * to fire late — which is why it is fixed from the mechanism (a job left
 * `pending` in `_scheduled_functions`) rather than from a repro.
 */
let harnesses: Array<ReturnType<typeof convexTest>> = [];

/** Every test builds its world through this so `afterEach` can settle it. */
function harness(): ReturnType<typeof convexTest> {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  return t;
}

beforeEach(() => {
  // Loopback → the OIDC path short-circuits, so no google-auth-library and
  // nothing can reach GCP.
  process.env.NEONBINDER_PREPROCESS_URL = HEAVY_URL;
  vi.unstubAllGlobals();
  harnesses = [];
});

afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system
        .query("_scheduled_functions")
        .collect()) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id);
        }
      }
    });
  }
  harnesses = [];
  vi.unstubAllGlobals();
  // Belt-and-suspenders: a test that enabled fake timers to drain must not
  // leave the fake-timer mode visible to the next one.
  vi.useRealTimers();
});

/**
 * Records every outbound call the drained schedule makes.
 *
 * `/warmup` answers like the real service; anything else is a terminal 404 so a
 * cascade settles fast instead of recursing. Mirrors `makeBatchStartStub` in
 * placeholderWarmup.test.ts.
 */
function stubPreprocess() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL): Promise<Response> => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/warmup")) {
        return new Response(
          JSON.stringify({ status: "warm", was_cold: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

/**
 * Run the scheduled work this test caused, to completion.
 *
 * NOT optional tidying. These tests assert what was SCHEDULED and used to stop
 * there, leaving `placeholderBatch:warmupHeavyPreprocess` in the queue to fire
 * after the file's environment had been torn down — which surfaced as
 * `EnvironmentTeardownError: Cannot load '/convex/lib/cloudRunAuth.ts' … after
 * the environment was torn down` in a full run. convex-test catches that and
 * only prints it, so the run stayed green while the defect sat one timing
 * change away from failing it, exactly as the sibling
 * `bscTeamEnrichmentQueue.tolerance.test.ts` leak did on CI run 9.
 *
 * Fake timers are entered and left HERE rather than file-wide: the other tests
 * in this file assert on real `Date.now()` timestamps.
 */
async function drain(t: ReturnType<typeof convexTest>): Promise<void> {
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

// A completed fast crop (no escalation) in the service's snake_case wire shape.
const CROP_BODY = {
  players: ["Ken Griffey Jr."],
  team: "Seattle Mariners",
  card_number: "24",
  side: "back",
  rotation_degrees: 0,
  orient_confidence: 0.9,
  text_count: 40,
  cropped_source: "tiered",
  dhash: "0f1e2d3c4b5a6978",
  output_written: true,
  needs_escalation: false,
};

/** The fast role's decline: a 200 whose only meaningful field is the flag. */
const DECLINED_BODY = { needs_escalation: true };

/**
 * NEO-315 D4: a decline from a fast revision that hands its own measurements to
 * heavy, as the workpool delivers it — i.e. as `callProcessEntryFast` RETURNED
 * it, with the wire `baseline` already narrowed and camelCased by the adapter
 * (adapters/preprocess.ts `normalizeProcessEntry`).
 */
const DECLINED_WITH_BASELINE = {
  needs_escalation: true,
  baseline: { rotationDegrees: 270, orientConfidence: 0.42, textCount: 7 },
  dhash: "a1b2c3d4e5f60718",
};

const BASELINE = { rotationDegrees: 270, orientConfidence: 0.42, textCount: 7 };

async function seedJob(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<Doc<"placeholderJobs">> & { jobId: string },
): Promise<string> {
  const userId = overrides.userId ?? USER_A.subject;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: overrides.jobId,
      userId,
      objectPath: `placeholders/${userId}/${overrides.jobId}/input.zip`,
      createdAt: 1_700_000_000_000,
      status: overrides.status ?? "processing",
      totalImages: overrides.totalImages ?? 0,
      processedImages: overrides.processedImages ?? 0,
      failedImages: overrides.failedImages ?? 0,
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      ...(overrides.heavyWarmStartedAt !== undefined
        ? { heavyWarmStartedAt: overrides.heavyWarmStartedAt }
        : {}),
    });
  });
  return overrides.jobId;
}

async function seedImage(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  status: Doc<"placeholderImages">["status"] = "processing",
  extra: Partial<Doc<"placeholderImages">> = {},
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId,
      userId: USER_A.subject,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status,
      ...extra,
    }),
  );
}

async function getJob(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.query("placeholderJobs").collect();
    return jobs.find((j) => j.jobId === jobId) ?? null;
  });
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

/**
 * Cancel just the debounced pairing run, leaving every other scheduled job for
 * the test (and the file's `afterEach`) to deal with.
 */
async function cancelPairingDebounce(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.name === PAIRING_FN && job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
      }
    }
  });
}

/** Drive one completion through the shared settle seam. */
async function settle(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  imageId: Id<"placeholderImages">,
  result: Parameters<typeof recordImageOutcomeImpl>[2],
) {
  await t.run(async (ctx) => recordImageOutcomeImpl(ctx, { jobId, imageId }, result));
  // NEO-220: completing an image arms `placeholderPairing:runPairing` behind a
  // 5s debounce (`PAIRING_DEBOUNCE_MS`). Nothing in this file asserts on
  // pairing — it covers escalation state — but convex-test leaves that timer
  // running, and a file that takes longer than the debounce (CI does; a laptop
  // does not) fires it into worker teardown. That fails the JOB with an
  // EnvironmentTeardownError while every test still reports green.
  //
  // CANCELLED rather than drained: a delayed schedule cannot be forced by
  // `finishAllScheduledFunctions` without fake timers, and adding those to this
  // file would change time semantics for every test in it. See
  // lib/testing/drain-scheduled.ts.
  //
  // BY NAME rather than `cancelScheduled(t)`, which is the shared helper's
  // blanket form. NEO-239 added three warm-gate tests below that drain the
  // schedule and assert the heavy `/warmup` actually reached the wire; a
  // blanket cancel here takes `placeholderBatch:warmupHeavyPreprocess` with it
  // and those assertions see zero calls. Cancelling only the debounce keeps
  // NEO-220's intent exactly as its comment states it — "this file does not
  // exercise the debounced pairing run" — without discarding the one scheduled
  // job this file DOES exercise.
  await cancelPairingDebounce(t);
}

// ---------------------------------------------------------------------------
// readNeedsEscalation — the strict narrower
// ---------------------------------------------------------------------------

describe("readNeedsEscalation", () => {
  test("only a literal boolean true reads as an escalation", () => {
    expect(readNeedsEscalation({ needs_escalation: true })).toBe(true);
    expect(readNeedsEscalation({ needs_escalation: false })).toBe(false);
    // Anything the wire never legitimately sends is the safe default: a crop
    // completion, not an escalation.
    expect(readNeedsEscalation({ needs_escalation: "true" })).toBe(false);
    expect(readNeedsEscalation({ needs_escalation: 1 })).toBe(false);
    expect(readNeedsEscalation({})).toBe(false);
    expect(readNeedsEscalation(null)).toBe(false);
    expect(readNeedsEscalation("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escalation routing
// ---------------------------------------------------------------------------

describe("a fast decline re-routes the image to the heavy pool", () => {
  test("marks the row escalated, drops the fast workId, and does NOT count it", async () => {
    const t = harness();
    const jobId = "job-esc-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0, "processing", { workId: "fast-work-0" });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_BODY });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    // Heavy-processing: escalated, still "processing", fast workId cleared so a
    // later heavy handle replaces it and cancel keys off the tier.
    expect(image?.escalated).toBe(true);
    expect(image?.status).toBe("processing");
    expect(image?.workId).toBeUndefined();

    const job = await getJob(t, jobId);
    // NOT settled — the counters must not move until the heavy result lands.
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
    expect(job?.status).toBe("processing");
    // And nothing was queued to pair a batch that has not finished. An
    // escalation is a hand-off, not a completion.
    expect(await scheduledNames(t)).not.toContain(PAIRING_FN);
  });

  test("schedules the heavy enqueue for exactly that image", async () => {
    const t = harness();
    const jobId = "job-esc-2";
    await seedJob(t, { jobId, status: "processing", totalImages: 1 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_BODY });

    expect(await scheduledNames(t)).toContain(ENQUEUE_HEAVY_FN);
    // And the schedule carries the right image id.
    const args = await t.run(async (ctx) => {
      const rows = await (
        ctx as unknown as {
          db: { system: { query: (n: string) => { collect: () => Promise<Array<{ name: string; args: unknown[] }>> } } };
        }
      ).db.system.query("_scheduled_functions").collect();
      return rows.find((r) => r.name === ENQUEUE_HEAVY_FN)?.args;
    });
    expect(args?.[0]).toEqual({ imageId });
  });

  test("a fast crop completion is unaffected — it settles, and never escalates", async () => {
    const t = harness();
    const jobId = "job-esc-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, { kind: "success", returnValue: CROP_BODY });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    expect(image?.escalated).toBeUndefined();
    expect((await getJob(t, jobId))?.processedImages).toBe(1);
    // No heavy work was scheduled for a card the fast path settled.
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
  });
});

// ---------------------------------------------------------------------------
// The heavy warm-gate
// ---------------------------------------------------------------------------

describe("the heavy warm-gate", () => {
  test("the FIRST escalation warms heavy once and records heavyWarmStartedAt", async () => {
    const { calls } = stubPreprocess();
    const t = harness();
    const jobId = "job-warm-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_BODY });

    const job = await getJob(t, jobId);
    expect(job?.heavyWarmStartedAt).toBeGreaterThan(0);
    const scheduled = await scheduledNames(t);
    expect(scheduled).toContain(HEAVY_WARMUP_FN);
    // Exactly one warm-up fan-out scheduled — not one per escalation.
    expect(scheduled.filter((n) => n === HEAVY_WARMUP_FN)).toHaveLength(1);

    // …and it is OWNED: run it, and assert what it actually did.
    //
    // NEO-299: the warm-gate no longer calls `/warmup` itself. It enqueues the
    // heavy warm-up fan-out on the heavy workpool, which convex-test cannot
    // mount, so the enqueue fails here and the action swallows it (a warm-up
    // must never fail a batch). What this drain still proves is that the
    // warm-gate runs to completion without throwing, and that it never fires a
    // heavy warm-up directly, beside the pool whose slots it has to share.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await drain(t);
    warn.mockRestore();
    expect(calls.filter((u) => u.endsWith("/warmup"))).toHaveLength(0);
  });

  test("a SECOND escalation enqueues heavy but does NOT re-fire the warm-gate", async () => {
    const { calls } = stubPreprocess();
    const t = harness();
    const jobId = "job-warm-2";
    // Pre-set heavyWarmStartedAt as if a first escalation already warmed heavy.
    await seedJob(t, {
      jobId,
      status: "processing",
      totalImages: 3,
      heavyWarmStartedAt: 1_700_000_000_500,
    });
    const imageId = await seedImage(t, jobId, 1);

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_BODY });

    const scheduled = await scheduledNames(t);
    // Still routes to heavy…
    expect(scheduled).toContain(ENQUEUE_HEAVY_FN);
    // …but the warm-gate does not fire again — one warm-up per batch.
    expect(scheduled).not.toContain(HEAVY_WARMUP_FN);
    // The original timestamp is untouched.
    expect((await getJob(t, jobId))?.heavyWarmStartedAt).toBe(1_700_000_000_500);

    // Drain the heavy enqueue this test DID schedule, and prove the warm-gate
    // stayed shut where it counts: no /warmup call reached the service either.
    await drain(t);
    expect(calls.filter((u) => u.endsWith("/warmup"))).toHaveLength(0);
  });

  test("two escalations settling in ONE transaction still warm heavy only once", async () => {
    // The workpool can settle several completions inline in one transaction; the
    // per-job settle lock serializes them, so the second reads the first's
    // heavyWarmStartedAt write and skips the warm-up.
    const { calls } = stubPreprocess();
    const t = harness();
    const jobId = "job-warm-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const a = await seedImage(t, jobId, 0);
    const b = await seedImage(t, jobId, 1);

    await t.run(async (ctx) => {
      await Promise.all([
        recordImageOutcomeImpl(ctx, { jobId, imageId: a }, { kind: "success", returnValue: DECLINED_BODY }),
        recordImageOutcomeImpl(ctx, { jobId, imageId: b }, { kind: "success", returnValue: DECLINED_BODY }),
      ]);
    });

    const scheduled = await scheduledNames(t);
    expect(scheduled.filter((n) => n === HEAVY_WARMUP_FN)).toHaveLength(1);
    // Both images were routed to heavy.
    expect(scheduled.filter((n) => n === ENQUEUE_HEAVY_FN)).toHaveLength(2);
    const images = await t.run(async (ctx) =>
      (await ctx.db.query("placeholderImages").collect()).filter((r) => r.jobId === jobId),
    );
    expect(images.every((i) => i.escalated === true)).toBe(true);

    // One schedule (asserted above). NEO-299: the scheduled warm-gate enqueues
    // its warm-ups on the heavy workpool rather than calling `/warmup` itself,
    // and convex-test cannot mount that component — so the drain proves only
    // that nothing reaches the wire directly, beside the pool.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await drain(t);
    warn.mockRestore();
    expect(calls.filter((u) => u === `${HEAVY_URL}/warmup`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Both pools' completions settle exactly once + counter safety
// ---------------------------------------------------------------------------

describe("the heavy completion terminates the escalated row", () => {
  test("a heavy crop marks the escalated row done and counts it, without re-escalating", async () => {
    const t = harness();
    const jobId = "job-heavy-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    // An image already escalated (as settle left it), now carrying a heavy handle.
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      workId: "heavy-work-0",
    });

    // Heavy result always carries needs_escalation:false, but even a buggy true
    // must not re-escalate an already-escalated row — assert with a crop body.
    await settle(t, jobId, imageId, { kind: "success", returnValue: CROP_BODY });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    expect(image?.players).toEqual(["Ken Griffey Jr."]);
    // The flag stays set (a done escalated row), which is what lets the cold-start
    // notice recognise the heavy service has produced a result.
    expect(image?.escalated).toBe(true);

    const job = await getJob(t, jobId);
    // The last outstanding image settled → batch complete → pairing.
    expect(job?.processedImages).toBe(2);
    expect(job?.status).toBe("pairing");
    // No further escalation was scheduled off the heavy completion.
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
    // …and the batch being complete is what QUEUED pairing. `status: "pairing"`
    // and the schedule are two separate writes that could disagree, so the row
    // is asserted rather than inferred. `scheduledNames` does not filter by
    // state and `settle` cancels the debounce immediately, so what this pins is
    // that the enqueue HAPPENED — which is the half that could regress.
    expect(await scheduledNames(t)).toContain(PAIRING_FN);
  });

  test("even a heavy response claiming needs_escalation:true cannot re-escalate", async () => {
    const t = harness();
    const jobId = "job-heavy-2";
    await seedJob(t, { jobId, status: "processing", totalImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      workId: "heavy-work-0",
    });

    await settle(t, jobId, imageId, { kind: "success", returnValue: { ...CROP_BODY, needs_escalation: true } });

    // The `!image.escalated` guard wins: the row terminates instead of looping.
    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
  });

  test("a heavy failure marks the escalated row failed and counts it", async () => {
    const t = harness();
    const jobId = "job-heavy-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      workId: "heavy-work-0",
    });

    await settle(t, jobId, imageId, { kind: "failed", error: "preprocess HTTP 500: boom" });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("failed");
    expect(image?.errorCode).toBe("PROCESS_ENTRY_FAILED");
    const job = await getJob(t, jobId);
    expect(job?.failedImages).toBe(1);
    expect(job?.status).toBe("pairing");
  });
});

describe("a fast-then-heavy image is counted exactly once, end to end", () => {
  test("a 2-image batch: one fast crop, one escalation that resolves heavy", async () => {
    const t = harness();
    const jobId = "job-e2e-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const fast = await seedImage(t, jobId, 0);
    const esc = await seedImage(t, jobId, 1);

    // Fast crop settles image 0.
    await settle(t, jobId, fast, { kind: "success", returnValue: CROP_BODY });
    expect((await getJob(t, jobId))?.processedImages).toBe(1);
    // The batch is NOT complete — the escalation has not been counted, so the
    // last-one-done transition must not have fired.
    expect((await getJob(t, jobId))?.status).toBe("processing");

    // Fast declines image 1 → escalation, still uncounted.
    await settle(t, jobId, esc, { kind: "success", returnValue: DECLINED_BODY });
    expect((await getJob(t, jobId))?.processedImages).toBe(1);
    expect((await getJob(t, jobId))?.status).toBe("processing");

    // Heavy resolves image 1 → now the batch is whole.
    await settle(t, jobId, esc, { kind: "success", returnValue: CROP_BODY });
    const job = await getJob(t, jobId);
    expect(job?.processedImages).toBe(2);
    expect(job?.status).toBe("pairing");
  });
});

// ---------------------------------------------------------------------------
// NEO-315: stage timestamps and the D4 baseline hand-off
// ---------------------------------------------------------------------------

/** The args the settle scheduled `enqueueHeavyImage` with, if it did. */
async function scheduledEnqueueArgs(
  t: ReturnType<typeof convexTest>,
): Promise<unknown[] | undefined> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: { system: { query: (n: string) => { collect: () => Promise<Array<{ name: string; args: unknown[] }>> } } };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.find((r) => r.name === ENQUEUE_HEAVY_FN)?.args;
  });
}

describe("NEO-315: an escalation stamps escalatedAt and hands the baseline on", () => {
  test("stores the fast baseline on the row and schedules the heavy enqueue with it", async () => {
    const t = harness();
    const jobId = "job-d4-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      workId: "fast-work-0",
      queuedAt: 1_000,
    });

    const before = Date.now();
    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });
    const after = Date.now();

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.escalated).toBe(true);
    expect(image?.escalatedAt).toBeGreaterThanOrEqual(before);
    expect(image?.escalatedAt).toBeLessThanOrEqual(after);
    // An escalation is a hand-off, not a settle.
    expect(image?.settledAt).toBeUndefined();
    expect(image?.queuedAt).toBe(1_000);
    // The fast pass's measurements land on the row, provisionally.
    expect(image?.rotationDegrees).toBe(270);
    expect(image?.orientConfidence).toBe(0.42);
    expect(image?.textCount).toBe(7);
    expect(image?.dhash).toBe("a1b2c3d4e5f60718");

    // …and travel with the heavy enqueue unchanged.
    expect((await scheduledEnqueueArgs(t))?.[0]).toEqual({
      imageId,
      baseline: BASELINE,
      dhash: "a1b2c3d4e5f60718",
    });

    // Still uncounted, exactly as an escalation without a baseline.
    const job = await getJob(t, jobId);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
  });

  test("an old-revision decline (no baseline) behaves exactly as before, plus escalatedAt", async () => {
    const t = harness();
    const jobId = "job-d4-2";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0, "processing", { workId: "fast-work-0" });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_BODY });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.escalated).toBe(true);
    expect(image?.escalatedAt).toBeGreaterThan(0);
    expect(image?.rotationDegrees).toBeUndefined();
    expect(image?.orientConfidence).toBeUndefined();
    expect(image?.textCount).toBeUndefined();
    expect(image?.dhash).toBeUndefined();
    // The schedule carries the image id and NOTHING else — not even an
    // explicit-undefined baseline key — so the heavy call goes out as it did.
    const args = (await scheduledEnqueueArgs(t))?.[0] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["imageId"]);
  });

  test("a malformed hint is neither stored nor forwarded; a sound one beside it still is", async () => {
    // The adapter narrows on the way in, but the settle re-narrows a value that
    // crossed the workpool's serialization boundary. 45 is not a quadrant, so
    // the baseline goes whole; the hash is fine on its own and travels.
    const t = harness();
    const jobId = "job-d4-bad";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, {
      kind: "success",
      returnValue: {
        ...DECLINED_WITH_BASELINE,
        baseline: { rotationDegrees: 45, orientConfidence: 0.42, textCount: 7 },
      },
    });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.escalated).toBe(true);
    expect(image?.rotationDegrees).toBeUndefined();
    expect(image?.orientConfidence).toBeUndefined();
    expect(image?.textCount).toBeUndefined();
    expect(image?.dhash).toBe("a1b2c3d4e5f60718");
    expect((await scheduledEnqueueArgs(t))?.[0]).toEqual({
      imageId,
      dhash: "a1b2c3d4e5f60718",
    });
  });

  test("the heavy result overwrites every baseline field, and stamps settledAt", async () => {
    const t = harness();
    const jobId = "job-d4-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "processing", { queuedAt: 1_000 });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });
    const escalatedAt = (await t.run(async (ctx) => ctx.db.get(imageId)))?.escalatedAt;
    // As `enqueueHeavyImage` would leave it.
    await t.run(async (ctx) => ctx.db.patch(imageId, { workId: "heavy-work-0" }));

    const before = Date.now();
    await settle(t, jobId, imageId, { kind: "success", returnValue: CROP_BODY });
    const after = Date.now();

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    // Heavy's answer, not the fast pass's guess.
    expect(image?.rotationDegrees).toBe(CROP_BODY.rotation_degrees);
    expect(image?.orientConfidence).toBe(CROP_BODY.orient_confidence);
    expect(image?.textCount).toBe(CROP_BODY.text_count);
    expect(image?.dhash).toBe(CROP_BODY.dhash);
    expect(image?.settledAt).toBeGreaterThanOrEqual(before);
    expect(image?.settledAt).toBeLessThanOrEqual(after);
    // The earlier stages keep the times they were measured at.
    expect(image?.escalatedAt).toBe(escalatedAt);
    expect(image?.queuedAt).toBe(1_000);
    expect((await getJob(t, jobId))?.processedImages).toBe(2);
  });

  test("a heavy result missing a field clears the provisional value rather than keeping it", async () => {
    // The baseline is provisional display data. A heavy crop that reports no
    // usable text count must not leave the fast pass's count looking like
    // heavy's answer.
    const t = harness();
    const jobId = "job-d4-4";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });
    const { text_count: _omit, ...withoutTextCount } = CROP_BODY;
    await settle(t, jobId, imageId, { kind: "success", returnValue: withoutTextCount });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    expect(image?.textCount).toBeUndefined();
  });

  test("a buggy heavy decline with a baseline neither re-escalates nor restamps escalatedAt", async () => {
    const t = harness();
    const jobId = "job-d4-5";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      escalatedAt: 2_000,
      workId: "heavy-work-0",
    });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    // The `!image.escalated` guard wins: it settles, once.
    expect(image?.status).toBe("done");
    expect(image?.escalatedAt).toBe(2_000);
    expect(image?.settledAt).toBeGreaterThan(0);
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
    expect((await getJob(t, jobId))?.processedImages).toBe(1);
  });

  test("two baseline escalations in ONE transaction each enqueue once with their own baseline", async () => {
    const t = harness();
    const jobId = "job-d4-6";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const a = await seedImage(t, jobId, 0);
    const b = await seedImage(t, jobId, 1);
    const otherBaseline = {
      needs_escalation: true,
      baseline: { rotationDegrees: 0, orientConfidence: 0.9, textCount: 55 },
      dhash: null,
    };

    await t.run(async (ctx) => {
      await Promise.all([
        recordImageOutcomeImpl(ctx, { jobId, imageId: a }, { kind: "success", returnValue: DECLINED_WITH_BASELINE }),
        recordImageOutcomeImpl(ctx, { jobId, imageId: b }, { kind: "success", returnValue: otherBaseline }),
      ]);
    });
    await cancelPairingDebounce(t);

    const enqueues = await t.run(async (ctx) => {
      const rows = await (
        ctx as unknown as {
          db: { system: { query: (n: string) => { collect: () => Promise<Array<{ name: string; args: unknown[] }>> } } };
        }
      ).db.system.query("_scheduled_functions").collect();
      return rows.filter((r) => r.name === ENQUEUE_HEAVY_FN).map((r) => r.args[0]);
    });
    expect(enqueues).toHaveLength(2);
    expect(enqueues).toContainEqual({ imageId: a, baseline: BASELINE, dhash: "a1b2c3d4e5f60718" });
    expect(enqueues).toContainEqual({
      imageId: b,
      baseline: { rotationDegrees: 0, orientConfidence: 0.9, textCount: 55 },
    });
    const job = await getJob(t, jobId);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
  });
});

describe("NEO-315 adversarial: repeated and out-of-order completions", () => {
  test("a repeated fast decline schedules exactly one heavy enqueue and counts nothing twice", async () => {
    const t = harness();
    const jobId = "job-d4-adv-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0, "processing", { workId: "fast-work-0" });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });
    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });

    const enqueues = (await scheduledNames(t)).filter((n) => n === ENQUEUE_HEAVY_FN);
    expect(enqueues).toHaveLength(1);
    const job = await getJob(t, jobId);
    expect(job?.processedImages ?? 0).toBeLessThanOrEqual(1);
    expect(job?.failedImages ?? 0).toBe(0);
  });

  test("a decline arriving for a row that already settled neither escalates nor restamps it", async () => {
    const t = harness();
    const jobId = "job-d4-adv-2";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "done", {
      queuedAt: 1_000,
      settledAt: 5_000,
      dhash: "0f1e2d3c4b5a6978",
      rotationDegrees: 0,
    });

    await settle(t, jobId, imageId, { kind: "success", returnValue: DECLINED_WITH_BASELINE });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.escalated).toBeUndefined();
    expect(image?.escalatedAt).toBeUndefined();
    expect(image?.settledAt).toBe(5_000);
    // The settled row's own hash is not replaced by the late decline's.
    expect(image?.dhash).toBe("0f1e2d3c4b5a6978");
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
    expect((await getJob(t, jobId))?.processedImages).toBe(1);
  });

  test.each([
    ["a heavy failure", { kind: "failed", error: "preprocess HTTP 500: boom" } as const],
    ["a heavy cancel", { kind: "canceled" } as const],
  ])("%s keeps escalatedAt, stamps settledAt, counts once and enqueues nothing more", async (_l, result) => {
    const t = harness();
    const jobId = "job-d4-adv-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      escalatedAt: 2_000,
      queuedAt: 1_000,
      workId: "heavy-work-0",
    });

    const before = Date.now();
    await settle(t, jobId, imageId, result);
    // A duplicate completion of the same failure changes nothing.
    await settle(t, jobId, imageId, result);

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("failed");
    expect(image?.escalatedAt).toBe(2_000);
    expect(image?.queuedAt).toBe(1_000);
    expect(image?.settledAt).toBeGreaterThanOrEqual(before);
    const job = await getJob(t, jobId);
    expect(job?.failedImages).toBe(1);
    expect(job?.processedImages).toBe(1);
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_HEAVY_FN);
  });

  test("a repeated heavy success does not move settledAt or double-count", async () => {
    const t = harness();
    const jobId = "job-d4-adv-4";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    const imageId = await seedImage(t, jobId, 0, "processing", {
      escalated: true,
      escalatedAt: 2_000,
      workId: "heavy-work-0",
    });

    await settle(t, jobId, imageId, { kind: "success", returnValue: CROP_BODY });
    const first = await t.run(async (ctx) => ctx.db.get(imageId));
    await settle(t, jobId, imageId, { kind: "success", returnValue: { ...CROP_BODY, text_count: 1 } });

    const second = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(second?.settledAt).toBe(first?.settledAt);
    expect(second?.textCount).toBe(CROP_BODY.text_count);
    expect((await getJob(t, jobId))?.processedImages).toBe(2);
  });

  test.each([
    ["a non-quadrant rotation", { rotationDegrees: 45, orientConfidence: 0.5, textCount: 3 }],
    ["a confidence above 1", { rotationDegrees: 90, orientConfidence: 1.5, textCount: 3 }],
    ["a fractional word count", { rotationDegrees: 90, orientConfidence: 0.5, textCount: 2.5 }],
    ["a missing field", { rotationDegrees: 90, orientConfidence: 0.5 }],
    ["a string-typed value", { rotationDegrees: "90", orientConfidence: 0.5, textCount: 3 }],
    ["a wire-shaped (snake_case) baseline", { rotation_degrees: 90, confidence: 0.5, text_count: 3 }],
  ])("%s never reaches the row or the heavy enqueue", async (_l, baseline) => {
    const t = harness();
    const jobId = "job-d4-adv-5";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, {
      kind: "success",
      returnValue: { needs_escalation: true, baseline },
    });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.escalated).toBe(true);
    expect(image?.rotationDegrees).toBeUndefined();
    expect(image?.orientConfidence).toBeUndefined();
    expect(image?.textCount).toBeUndefined();
    const args = (await scheduledEnqueueArgs(t))?.[0] as Record<string, unknown>;
    expect(args).toEqual({ imageId });
  });

  test.each([
    ["an upper-case hash", "A1B2C3D4E5F60718"],
    ["a short hash", "a1b2c3"],
    ["a non-string hash", 1234567890123456],
  ])("%s is neither stored nor forwarded", async (_l, dhash) => {
    const t = harness();
    const jobId = "job-d4-adv-6";
    await seedJob(t, { jobId, status: "processing", totalImages: 2 });
    const imageId = await seedImage(t, jobId, 0);

    await settle(t, jobId, imageId, {
      kind: "success",
      returnValue: { needs_escalation: true, dhash },
    });

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.dhash).toBeUndefined();
    expect(((await scheduledEnqueueArgs(t))?.[0] as Record<string, unknown>).dhash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enqueueHeavyImage — the guard no-ops reachable without the component
// ---------------------------------------------------------------------------

describe("enqueueHeavyImage guards", () => {
  // These paths return BEFORE touching the heavy pool, so they are reachable
  // under convex-test; the happy-path enqueue is left to integration.
  test("no-ops when the image row is gone", async () => {
    const t = harness();
    const jobId = "job-guard-1";
    await seedJob(t, { jobId, status: "processing" });
    const imageId = await seedImage(t, jobId, 0, "processing", { escalated: true });
    await t.run(async (ctx) => ctx.db.delete(imageId));

    const { internal } = await import("./_generated/api");
    await expect(
      t.mutation(internal.placeholderHeavyPool.enqueueHeavyImage, { imageId }),
    ).resolves.toEqual({ enqueued: false });
  });

  test("no-ops when the row is not an un-enqueued escalation", async () => {
    const t = harness();
    const jobId = "job-guard-2";
    await seedJob(t, { jobId, status: "processing" });
    // Not escalated → skip (would be a stale/duplicate schedule).
    const plain = await seedImage(t, jobId, 0, "processing");
    // Escalated but already has a heavy workId → skip (already enqueued).
    const already = await seedImage(t, jobId, 1, "processing", {
      escalated: true,
      workId: "heavy-work-1",
    });

    const { internal } = await import("./_generated/api");
    await expect(
      t.mutation(internal.placeholderHeavyPool.enqueueHeavyImage, { imageId: plain }),
    ).resolves.toEqual({ enqueued: false });
    await expect(
      t.mutation(internal.placeholderHeavyPool.enqueueHeavyImage, { imageId: already }),
    ).resolves.toEqual({ enqueued: false });
  });

  test("no-ops when the job is no longer draining work (a cancel forced it terminal)", async () => {
    const t = harness();
    const jobId = "job-guard-3";
    await seedJob(t, { jobId, status: "failed" });
    const imageId = await seedImage(t, jobId, 0, "processing", { escalated: true });

    const { internal } = await import("./_generated/api");
    await expect(
      t.mutation(internal.placeholderHeavyPool.enqueueHeavyImage, { imageId }),
    ).resolves.toEqual({ enqueued: false });
  });
});

// ---------------------------------------------------------------------------
// deriveHeavyWarming — the cold-start notification state
// ---------------------------------------------------------------------------

describe("deriveHeavyWarming", () => {
  test("false when there are no escalations at all", () => {
    expect(
      deriveHeavyWarming([
        { status: "processing" },
        { status: "done" },
        { status: "queued" },
      ]),
    ).toBe(false);
  });

  test("true while an escalation is pending and nothing heavy has resolved", () => {
    expect(
      deriveHeavyWarming([
        { status: "done" }, // a fast crop, streamed in already
        { status: "processing", escalated: true }, // waiting on cold heavy
      ]),
    ).toBe(true);
  });

  test("false once the FIRST escalated image resolves — heavy is proven warm", () => {
    expect(
      deriveHeavyWarming([
        { status: "done", escalated: true }, // heavy produced a result
        { status: "processing", escalated: true }, // another still going
      ]),
    ).toBe(false);
  });

  test("false when every escalation has resolved (done or failed)", () => {
    expect(
      deriveHeavyWarming([
        { status: "done", escalated: true },
        { status: "failed", escalated: true },
      ]),
    ).toBe(false);
  });

  test("a plain processing (non-escalated) image does not trigger it", () => {
    // The fast path is never gated — a card merely processing on fast is not a
    // heavy cold-start.
    expect(deriveHeavyWarming([{ status: "processing" }])).toBe(false);
  });
});

describe("getPlaceholderJob surfaces heavyWarming", () => {
  test("true while an escalation waits on a cold heavy service", async () => {
    const t = harness();
    const jobId = "job-warmflag-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    await seedImage(t, jobId, 0, "done"); // fast crop already streamed in
    await seedImage(t, jobId, 1, "processing", { escalated: true }); // waiting on heavy

    const job = await t.withIdentity(USER_A).query(api.placeholderPipeline.getPlaceholderJob, {
      jobId,
    });
    expect(job?.heavyWarming).toBe(true);
  });

  test("false once the heavy service has produced a result", async () => {
    const t = harness();
    const jobId = "job-warmflag-2";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 2 });
    await seedImage(t, jobId, 0, "done", { escalated: true }); // heavy result landed
    await seedImage(t, jobId, 1, "processing", { escalated: true }); // still going

    const job = await t.withIdentity(USER_A).query(api.placeholderPipeline.getPlaceholderJob, {
      jobId,
    });
    expect(job?.heavyWarming).toBe(false);
  });

  test("false for a batch with no escalations", async () => {
    const t = harness();
    const jobId = "job-warmflag-3";
    await seedJob(t, { jobId, status: "processing", totalImages: 2, processedImages: 1 });
    await seedImage(t, jobId, 0, "done");
    await seedImage(t, jobId, 1, "processing"); // plain fast processing

    const job = await t.withIdentity(USER_A).query(api.placeholderPipeline.getPlaceholderJob, {
      jobId,
    });
    expect(job?.heavyWarming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Streaming preserved — fast rows resolve while escalations pend
// ---------------------------------------------------------------------------

describe("streaming is preserved across the escalation", () => {
  test("fast crops appear as 'done' in listPlaceholderImages while an escalation is still processing", async () => {
    const t = harness();
    const jobId = "job-stream-1";
    await seedJob(t, { jobId, status: "processing", totalImages: 3 });
    const a = await seedImage(t, jobId, 0);
    const b = await seedImage(t, jobId, 1);
    await seedImage(t, jobId, 2, "processing"); // still on fast

    // Two fast completions: one crop (streams in), one decline (escalates).
    await settle(t, jobId, a, { kind: "success", returnValue: CROP_BODY });
    await settle(t, jobId, b, { kind: "success", returnValue: DECLINED_BODY });

    const images = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderImages, { jobId });

    const byIndex = new Map(images.map((i) => [i.entryIndex, i]));
    // The fast crop is available immediately — not blocked on the escalation.
    expect(byIndex.get(0)?.status).toBe("done");
    // The escalation shows as still-processing + escalated (the FE badges it).
    expect(byIndex.get(1)?.status).toBe("processing");
    expect(byIndex.get(1)?.escalated).toBe(true);
    // The batch is still processing — it is not blocked, but not falsely complete.
    expect((await getJob(t, jobId))?.status).toBe("processing");
  });
});
