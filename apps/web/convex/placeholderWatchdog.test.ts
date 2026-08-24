/**
 * The wedged-batch watchdog (NEO-170).
 *
 * The settle lock (f9eb1da) keeps the fast path's counter whole; this sweep is
 * the safety net that catches a strand the lock did not — a future counter
 * drift, a lost scheduled function, a completion that never landed. These tests
 * pin the whole contract: the integrity check that detects the strand, the two
 * heal paths (recompute-and-complete, and fail-when-genuinely-stuck), the
 * live-stream guard that recomputes a collecting job's counter without ever
 * completing or failing it, and — the property that makes false positives the
 * one unacceptable outcome — that a healthy in-progress batch is never touched.
 *
 * Filename lives at the `convex/` root so convex-test's module registry resolves
 * the function paths, per the note on convex/placeholderCounterRace.test.ts.
 *
 * The assertions read the SYNCHRONOUS effects of the sweep — the counter/status
 * patches and the dual-written `console.warn` line — not the functions it
 * schedules (`internal.posthog.captureEvent`, and the final pairing run on a
 * complete-and-drive). Those are left scheduled: FAKE TIMERS (below) keep them
 * from firing on a real-timer callback after this file's environment tears down,
 * which under the parallel suite would otherwise load posthog-node / the pairing
 * modules against a dead environment. The console line carries the same payload
 * as the PostHog event, so the observable signal is fully covered without
 * running the "use node" capture.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { PLACEHOLDER_WEDGE_STALE_MS } from "./placeholderWatchdog";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_watchdogAAAA1111";

// Comfortably past the threshold, and comfortably inside it.
const STALE = () => Date.now() - PLACEHOLDER_WEDGE_STALE_MS - 60_000;
const FRESH = () => Date.now() - 1_000;

type ImageSpec = { status: Doc<"placeholderImages">["status"]; entryIndex?: number };

type JobSpec = {
  jobId: string;
  status: Doc<"placeholderJobs">["status"];
  mode?: "zip" | "stream";
  totalImages: number;
  processedImages: number;
  failedImages: number;
  lastActivityAt: number;
  images: ImageSpec[];
};

async function seed(t: ReturnType<typeof convexTest>, spec: JobSpec): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: spec.jobId,
      userId: USER,
      objectPath: `placeholders/${USER}/${spec.jobId}/`,
      createdAt: 1,
      mode: spec.mode ?? "zip",
      status: spec.status,
      totalImages: spec.totalImages,
      processedImages: spec.processedImages,
      failedImages: spec.failedImages,
      rejectedEntries: 0,
      startedAt: spec.lastActivityAt,
      lastActivityAt: spec.lastActivityAt,
      ...(spec.mode === "stream" ? { nextEntryIndex: spec.images.length } : {}),
    });
    let auto = 0;
    for (const img of spec.images) {
      await ctx.db.insert("placeholderImages", {
        jobId: spec.jobId,
        userId: USER,
        entryIndex: img.entryIndex ?? auto++,
        originalName: `scan-${img.entryIndex ?? auto}.jpg`,
        status: img.status,
      });
    }
  });
}

async function getJob(
  t: ReturnType<typeof convexTest>,
  jobId: string,
): Promise<Doc<"placeholderJobs"> | null> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderJobs").collect();
    return rows.find((j) => j.jobId === jobId) ?? null;
  });
}

function sweep(t: ReturnType<typeof convexTest>) {
  return t.mutation(internal.placeholderWatchdog.sweepWedgedBatches, {});
}

/** Grab the parsed `placeholder_batch_wedged` payloads a console.warn spy saw. */
function wedgeEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => !!p && p.msg === "placeholder_batch_wedged");
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // Fake timers so the sweep's `runAfter(0)` schedules (PostHog capture, final
  // pairing run) never fire on their own real-timer callback after this file's
  // environment tears down. Left undrained on purpose — the sweep's synchronous
  // effects are what these tests assert.
  vi.useFakeTimers();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

describe("integrity check detects a stranded counter", () => {
  test("recomputes the short counter and drives the batch to pairing", async () => {
    // The exact f9eb1da fingerprint: every image reached "done" but the counter
    // is one short, so the last-one-done transition never fired.
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-strand",
      status: "processing",
      totalImages: 6,
      processedImages: 5, // ← lost increment
      failedImages: 0,
      lastActivityAt: STALE(),
      images: Array.from({ length: 6 }, () => ({ status: "done" as const })),
    });

    const result = await sweep(t);
    expect(result.remediated).toBe(1);

    const job = await getJob(t, "job-strand");
    // Counter recomputed from the rows, and the same hand-off settle makes.
    expect(job?.processedImages).toBe(6);
    expect(job?.failedImages).toBe(0);
    expect(job?.status).toBe("pairing");
  });

  test("the emitted event names the mismatch and carries no path or content", async () => {
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-strand-evt",
      status: "processing",
      totalImages: 4,
      processedImages: 3,
      failedImages: 0,
      lastActivityAt: STALE(),
      images: Array.from({ length: 4 }, () => ({ status: "done" as const })),
    });

    await sweep(t);

    const events = wedgeEvents(warnSpy);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.jobId).toBe("job-strand-evt");
    expect(e.remediation).toBe("recompute_completed");
    expect(e.countersDrifted).toBe(true);
    expect(e.trueTerminal).toBe(4);
    expect(e.mismatchDelta).toBe(1); // 4 terminal rows − 3 counted
    // The hard rule from schema.ts: nothing path-shaped, and no upload content.
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain("placeholders/");
    expect(serialized).not.toContain("scan-");
    expect(serialized).not.toContain("objectPath");
  });
});

describe("genuinely stuck work is failed, not left hanging", () => {
  test("a non-terminal row past the threshold marks the job WEDGED", async () => {
    // Counter AGREES with the terminal rows here (5 == 5), so this is not a drift
    // — it is a row whose workpool completion was lost. The batch can never reach
    // its total, so it must be failed rather than left to hang.
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-stuck",
      status: "processing",
      totalImages: 6,
      processedImages: 5,
      failedImages: 0,
      lastActivityAt: STALE(),
      images: [
        ...Array.from({ length: 5 }, () => ({ status: "done" as const })),
        { status: "processing" as const }, // ← never completed
      ],
    });

    const result = await sweep(t);
    expect(result.remediated).toBe(1);

    const job = await getJob(t, "job-stuck");
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("WEDGED");
    expect(job?.finishedAt).toBeGreaterThan(0);

    const events = wedgeEvents(warnSpy);
    expect(events[0]?.remediation).toBe("marked_wedged");
    expect(events[0]?.nonTerminal).toBe(1);
  });

  test("an extraction stalled past the threshold is failed WEDGED", async () => {
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-extract-hang",
      status: "extracting",
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      lastActivityAt: STALE(),
      images: [],
    });

    await sweep(t);
    const job = await getJob(t, "job-extract-hang");
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("WEDGED");
  });
});

describe("a live collecting stream is repaired but never completed", () => {
  test("a drifted collecting counter is recomputed, status left collecting", async () => {
    const t = convexTest(schema, modules);
    const staleAt = STALE();
    await seed(t, {
      jobId: "job-collecting",
      status: "collecting",
      mode: "stream",
      totalImages: 5,
      processedImages: 3, // ← short of the 4 done rows
      failedImages: 0,
      lastActivityAt: staleAt,
      images: [
        ...Array.from({ length: 4 }, () => ({ status: "done" as const })),
        { status: "queued" as const }, // still being fed
      ],
    });

    const result = await sweep(t);
    expect(result.remediated).toBe(1);

    const job = await getJob(t, "job-collecting");
    expect(job?.processedImages).toBe(4); // drift fixed
    expect(job?.status).toBe("collecting"); // never force-completed
    // The idle clock is sweepIdleStreams' to move, not ours — left untouched.
    expect(job?.lastActivityAt).toBe(staleAt);
    expect(wedgeEvents(warnSpy)[0]?.remediation).toBe("recompute_collecting");
  });

  test("a collecting stream with an accurate counter is left entirely alone", async () => {
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-collecting-ok",
      status: "collecting",
      mode: "stream",
      totalImages: 3,
      processedImages: 2,
      failedImages: 0,
      lastActivityAt: STALE(),
      images: [
        { status: "done" as const },
        { status: "done" as const },
        { status: "queued" as const },
      ],
    });

    const result = await sweep(t);
    expect(result.remediated).toBe(0);
    expect(wedgeEvents(warnSpy)).toHaveLength(0);
    expect((await getJob(t, "job-collecting-ok"))?.status).toBe("collecting");
  });
});

describe("healthy in-progress work is never touched", () => {
  test("a recent, still-processing batch is not stale and is left alone", async () => {
    // Mid-flight and drifted, but its heartbeat is fresh — the watchdog must not
    // mistake a batch that is simply still running for a stranded one. A false
    // positive here would FAIL a healthy batch, the one outcome worth this guard.
    const t = convexTest(schema, modules);
    await seed(t, {
      jobId: "job-healthy",
      status: "processing",
      totalImages: 6,
      processedImages: 2,
      failedImages: 0,
      lastActivityAt: FRESH(),
      images: [
        ...Array.from({ length: 2 }, () => ({ status: "done" as const })),
        ...Array.from({ length: 4 }, () => ({ status: "processing" as const })),
      ],
    });

    const result = await sweep(t);
    expect(result.remediated).toBe(0);
    expect(result.inspected).toBe(0); // never even read past the index range

    const job = await getJob(t, "job-healthy");
    expect(job?.status).toBe("processing");
    expect(job?.processedImages).toBe(2); // untouched
    expect(wedgeEvents(warnSpy)).toHaveLength(0);
  });
});
