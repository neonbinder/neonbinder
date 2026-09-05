/**
 * Regression: the progress counters must survive several completions landing in
 * ONE transaction (NEO-170).
 *
 * The workpool runs its `onComplete` callbacks INLINE, and when it settles more
 * than one work item at once (the main-loop / recovery path) it awaits them with
 * `Promise.all` inside a single `complete` transaction — see
 * `@convex-dev/workpool` `complete.ts`. So two `recordImageOutcomeImpl` calls can
 * share one transaction. Its counter update is a read-modify-write
 * (`processedImages = job.processedImages + 1`); interleaved at their `await`
 * points, both invocations read the same pre-increment value and both write the
 * same `+1`, and every increment past the first is lost. The images all reach
 * "done" (distinct rows), but the job counter falls short of `totalImages`, so
 * `processed + failed === total` is never true and the batch is stranded at, e.g.,
 * "5 of 6 processed" forever — the live E2E failure this guards against.
 *
 * These tests reproduce that by calling `recordImageOutcomeImpl` for every image
 * concurrently inside ONE `t.run`, exactly as the workpool's inline `Promise.all`
 * does. Before the per-job settle lock they fail (the counter lags); after it
 * they pass. Filename lives at the `convex/` root so convex-test's module
 * registry resolves the function paths, per the note on
 * convex/placeholderStream.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { recordImageOutcomeImpl } from "./placeholderPipeline";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_raceAAAA1111";

/**
 * NEO-239 — the pairing hand-off these tests cause is OWNED here.
 *
 * The second test's whole point is that a batch settling together still reaches
 * its total and hands off to pairing — which means `recordImageOutcomeImpl`
 * schedules `placeholderPairing:runPairing`. Nothing awaited or cancelled it,
 * so it fired after the file's environment had been torn down and surfaced in a
 * full run as
 *
 *   Error when running scheduled function placeholderPairing:runPairing
 *   EnvironmentTeardownError: Cannot load '/convex/lib/pairing/pool.ts'
 *   imported from …/convex/lib/pairing/pairBatch.ts after the environment was
 *   torn down
 *
 * convex-test only prints that, so the run stayed green. It reproduces roughly
 * one full run in three on this machine, so it is fixed from the mechanism — a
 * job left `pending` in `_scheduled_functions` — rather than from a repro.
 *
 * Cancelled rather than drained, matching placeholderEscalation.test.ts: these
 * tests are about the COUNTER, and running the pairing action would make them
 * depend on `pairBatch` behaviour they say nothing about. What the hand-off
 * itself promises is now asserted below instead of merely implied by the job's
 * status.
 */
let harnesses: Array<ReturnType<typeof convexTest>> = [];

function harness(): ReturnType<typeof convexTest> {
  const created = convexTest(schema, modules);
  harnesses.push(created);
  return created;
}

/** The scheduled-function rows a test has caused and not yet run. */
async function scheduledNames(t: ReturnType<typeof convexTest>): Promise<string[]> {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((j) => j.state.kind === "pending" || j.state.kind === "inProgress")
      .map((j) => j.name),
  );
}

beforeEach(() => {
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
});



/** Seed a job plus `n` images already "processing", as they are just before the
 *  workpool delivers their completions. */
async function seedProcessing(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  n: number,
  status: Doc<"placeholderJobs">["status"],
): Promise<Id<"placeholderImages">[]> {
  return t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId: USER,
      objectPath: `placeholders/${USER}/${jobId}/`,
      createdAt: 1,
      mode: "stream",
      status,
      totalImages: n,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      nextEntryIndex: n,
      lastActivityAt: 1,
    });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert("placeholderImages", {
          jobId,
          userId: USER,
          entryIndex: i,
          originalName: `scan-${i}.jpg`,
          status: "processing",
          workId: `work-${i}`,
        }),
      );
    }
    return ids;
  });
}

async function getJob(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderJobs").collect();
    return rows.find((j) => j.jobId === jobId) ?? null;
  });
}

async function getImages(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("placeholderImages").collect()).filter(
      (r) => r.jobId === jobId,
    ),
  );
}

/** Deliver every image's completion inside a SINGLE transaction, the way the
 *  workpool's `complete` handler runs a batch of onCompletes with Promise.all. */
async function completeAllInOneTransaction(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  ids: Id<"placeholderImages">[],
) {
  await t.run(async (ctx) => {
    await Promise.all(
      ids.map((imageId, i) =>
        recordImageOutcomeImpl(
          ctx,
          { jobId, imageId },
          {
            kind: "success",
            returnValue: {
              side: i % 2 === 0 ? "front" : "back",
              text_count: i % 2 === 0 ? 1 : 40,
            },
          },
        ),
      ),
    );
  });
}

describe("counters survive batched inline onComplete", () => {
  test("six completions in one transaction each count exactly once", async () => {
    const t = harness();
    const jobId = "job-race-collecting";
    const ids = await seedProcessing(t, jobId, 6, "collecting");

    await completeAllInOneTransaction(t, jobId, ids);

    const images = await getImages(t, jobId);
    expect(images.every((r) => r.status === "done")).toBe(true);
    // The bug: this read `1`, because five increments interleaved and were lost.
    expect((await getJob(t, jobId))?.processedImages).toBe(6);
  });

  test("the last-one-done transition still fires when the batch settles together", async () => {
    // A closed stream (or a zip) whose remaining images all complete in one
    // workpool transaction must still reach its total and hand off to pairing —
    // the terminal decision depends on the counter being whole, which is exactly
    // what the lost updates prevented.
    const t = harness();
    const jobId = "job-race-processing";
    const ids = await seedProcessing(t, jobId, 4, "processing");

    await completeAllInOneTransaction(t, jobId, ids);

    const job = await getJob(t, jobId);
    expect(job?.processedImages).toBe(4);
    expect(job?.failedImages).toBe(0);
    // processed + failed === total was observed, so the batch moved on.
    expect(job?.status).toBe("pairing");
    // …and "moved on" means the pairing action was actually enqueued. The
    // status field and the schedule are two separate writes and could disagree;
    // the counter bug this file guards is precisely a case where a field said
    // one thing and the work behind it did not happen.
    expect(await scheduledNames(t)).toContain("placeholderPairing:runPairing");
  });
});
