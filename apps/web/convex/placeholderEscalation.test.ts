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

/** Drive one completion through the shared settle seam. */
async function settle(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  imageId: Id<"placeholderImages">,
  result: Parameters<typeof recordImageOutcomeImpl>[2],
) {
  await t.run(async (ctx) => recordImageOutcomeImpl(ctx, { jobId, imageId }, result));
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

    // …and it is OWNED: run it, and assert what it actually did. Scheduling is
    // half the guarantee; the warm-up has to reach the heavy service, and
    // asserting the call proves the schedule carried a usable target rather
    // than merely existing.
    // …and it is OWNED: run it, and assert what it actually did.
    //
    // A LOWER BOUND, not an exact count, and the reason matters: convex-test's
    // scheduler queue is shared across every `convexTest()` instance in a file
    // (see the same note in placeholderWarmup.test.ts), so the first test that
    // drains also sweeps up whatever the earlier tests left behind. Pinning an
    // exact number here would be pinning THEIR behaviour, from a test that
    // does not own it. What this test owns is that its own warm-up reached the
    // heavy service — and that no warm-up went anywhere else.
    await drain(t);
    const warmups = calls.filter((u) => u.endsWith("/warmup"));
    expect(warmups.length).toBeGreaterThan(0);
    expect(warmups.every((u) => u === `${HEAVY_URL}/warmup`)).toBe(true);
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

    // One schedule, one call. The de-duplication has to hold all the way to
    // the wire, not just in the scheduler table.
    await drain(t);
    expect(calls.filter((u) => u === `${HEAVY_URL}/warmup`)).toHaveLength(1);
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
    // …and the batch being complete is what queues pairing. Asserting it here
    // is the point: `status: "pairing"` is a promise that the pairing action
    // was actually enqueued, and the two used to be able to disagree.
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
