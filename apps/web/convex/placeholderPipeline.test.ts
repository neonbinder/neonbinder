/**
 * Unit tests for the placeholder batch state machine (NEO-170).
 *
 * What is NOT tested here, and why: the workpool component itself is never
 * mounted. convex-test cannot register the workpool's nested batch-worker
 * component, so `preprocessPool.enqueueAction` / `.cancel` are unreachable in
 * this environment. That is why `recordImageOutcomeImpl` exists as a plain
 * exported function rather than only as the body of `onImageComplete` — the
 * whole completion path (counter math, the last-one-done transition, the
 * failure and cancellation branches) is driven directly through `t.run`, which
 * is the seam the pool would otherwise hide.
 *
 * The two places the pool IS unavoidable — `enqueueImageChunk` and the cancel
 * loop in `cancelPlaceholderBatch` — are exercised only up to the point where
 * they would touch it (the cancel tests seed images with no `workId`, which is
 * the condition the loop skips on), and `enqueueImageChunk` is left to
 * integration.
 *
 * Scheduled functions are likewise not auto-run by convex-test, which is what
 * lets these tests drive the chunked chains — registration → prune → enqueue —
 * one link at a time and assert the state between them. The helpers at the top
 * of the file re-play the self-scheduling by hand for exactly that reason.
 *
 * Filename note: this lives at the `convex/` root rather than in a
 * subdirectory. convex-test's `import.meta.glob` module registry only resolves
 * function paths correctly for test files at that level — see the same note on
 * convex/adapters.placeholderUploads.test.ts.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  recordImageOutcomeImpl,
  resolveMaxActiveJobsPerUser,
  DEFAULT_MAX_ACTIVE_JOBS_PER_USER,
} from "./placeholderPipeline";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_batchAAAA1111" };
const USER_B = { subject: "user_batchBBBB2222" };

const JOB_A = "job-aaaa-1111";

type JobStatus =
  | "pending"
  | "uploaded"
  | "extracting"
  | "processing"
  | "pairing"
  | "succeeded"
  | "failed";

type ImageStatus = "queued" | "processing" | "done" | "failed";

type ExtractEntryArg = { index: number; name: string; accepted: boolean };

async function seedJob(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    jobId: string;
    userId: string;
    status: JobStatus;
    totalImages: number;
    processedImages: number;
    failedImages: number;
  }> = {},
) {
  const jobId = overrides.jobId ?? JOB_A;
  const userId = overrides.userId ?? USER_A.subject;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: `placeholders/${userId}/${jobId}/input.zip`,
      createdAt: 1_700_000_000_000,
      status: overrides.status ?? "uploaded",
      ...(overrides.totalImages !== undefined ? { totalImages: overrides.totalImages } : {}),
      ...(overrides.processedImages !== undefined
        ? { processedImages: overrides.processedImages }
        : {}),
      ...(overrides.failedImages !== undefined ? { failedImages: overrides.failedImages } : {}),
    });
  });
  return { jobId, userId };
}

async function seedImage(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  userId = USER_A.subject,
  status: ImageStatus = "queued",
  extra: Partial<Doc<"placeholderImages">> = {},
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId,
      userId,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status,
      ...extra,
    }),
  );
}

/**
 * Read a job back out of the test database.
 *
 * Uses `.collect()` + `find` rather than `.withIndex("by_job", …)` on purpose:
 * convex-test's generic DataModel typing degrades under `tsc` and reports a
 * real index as `keyof SystemIndexes` (the reason `convex/tsconfig.json`
 * excludes `*.test.ts` from the deploy typecheck at all). Index selection is
 * the production code's job, not this helper's — a full scan over a handful of
 * seeded rows costs nothing and keeps the file free of noise errors that would
 * hide a genuine one.
 */
async function getJob(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.query("placeholderJobs").collect();
    return jobs.find((j) => j.jobId === jobId) ?? null;
  });
}

/** This job's image rows, in entry-index order. */
async function getImages(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderImages").collect();
    return rows
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => a.entryIndex - b.entryIndex);
  });
}

/**
 * Run `registerExtractedImages` to completion, re-playing the chunk cursor the
 * production code would have carried through `ctx.scheduler`.
 */
async function registerAll(
  t: ReturnType<typeof convexTest>,
  args: { jobId?: string; userId?: string; entries: ExtractEntryArg[] },
) {
  const jobId = args.jobId ?? JOB_A;
  const userId = args.userId ?? USER_A.subject;
  let from = 0;
  let keptDone = 0;
  for (;;) {
    const result = await t.mutation(internal.placeholderPipeline.registerExtractedImages, {
      jobId,
      userId,
      entries: args.entries,
      from,
      keptDone,
    });
    if (result.done) return result;
    from += 50;
    keptDone = result.keptDone;
  }
}

/**
 * Run the stale-row sweep that registration schedules behind itself.
 *
 * Single-call: every test here seeds fewer rows than one chunk, so `done` must
 * come back true. Asserting that is the point — if it ever came back false the
 * test would be silently skipping the hand-off this mutation owns.
 */
async function pruneOnce(
  t: ReturnType<typeof convexTest>,
  acceptedIndexes: number[],
  jobId = JOB_A,
) {
  const result = await t.mutation(internal.placeholderPipeline.pruneUnregisteredImages, {
    jobId,
    acceptedIndexes,
    from: 0,
  });
  expect(result.done).toBe(true);
  return result;
}

/** Registration plus the sweep behind it — the whole "extract landed" path. */
async function registerAndPrune(
  t: ReturnType<typeof convexTest>,
  args: { jobId?: string; userId?: string; entries: ExtractEntryArg[] },
) {
  const result = await registerAll(t, args);
  await pruneOnce(
    t,
    args.entries.filter((e) => e.accepted).map((e) => e.index),
    args.jobId ?? JOB_A,
  );
  return result;
}

// A success payload in the preprocess service's wire shape (snake_case).
const SUCCESS_BODY = {
  players: ["Ken Griffey Jr."],
  player: "Ken Griffey Jr.",
  team: "Seattle Mariners",
  card_number: "24",
  side: "back",
  rotation_degrees: 90,
  orient_confidence: 0.87,
  text_count: 42,
  cropped_source: "tiered",
  dhash: "0f1e2d3c4b5a6978",
  output_written: true,
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// startPlaceholderBatch — status guard matrix
// ---------------------------------------------------------------------------

describe("startPlaceholderBatch — status guard", () => {
  test.each(["pending", "uploaded", "failed"] as const)(
    "starts from %s and moves the job to extracting",
    async (status) => {
      const t = convexTest(schema, modules);
      await seedJob(t, { status });

      const result = await t
        .withIdentity(USER_A)
        .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

      expect(result.started).toBe(true);
      const job = await getJob(t, JOB_A);
      expect(job?.status).toBe("extracting");
      expect(job?.startedAt).toBeGreaterThan(0);
      expect(job?.totalImages).toBe(0);
      expect(job?.processedImages).toBe(0);
      expect(job?.failedImages).toBe(0);
    },
  );

  test.each(["extracting", "processing", "pairing", "succeeded"] as const)(
    "refuses to start from %s, without throwing",
    async (status) => {
      const t = convexTest(schema, modules);
      await seedJob(t, { status });

      const result = await t
        .withIdentity(USER_A)
        .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

      expect(result.started).toBe(false);
      expect(result.reason).toContain(status);
      // The guard must not have moved the job.
      expect((await getJob(t, JOB_A))?.status).toBe(status);
    },
  );

  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "uploaded" });
    await expect(
      t.mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("another user cannot start someone else's job, and cannot tell it exists", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "uploaded" });

    await expect(
      t
        .withIdentity(USER_B)
        .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A }),
    ).rejects.toThrow(/job not found/i);

    // Identical error for a job that genuinely doesn't exist — otherwise the
    // difference is an existence oracle for other users' job ids.
    await expect(
      t
        .withIdentity(USER_B)
        .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-nope" }),
    ).rejects.toThrow(/job not found/i);

    expect((await getJob(t, JOB_A))?.status).toBe("uploaded");
  });

  test("restarting a failed job does NOT delete its images inline", async () => {
    // The bulk delete used to happen here, in the mutation the user is waiting
    // on — ~1000 reads plus ~1000 deletes on a full zip, straight through the
    // 7-second budget. The rows now survive Start untouched; reconciling them
    // is registerExtractedImages' job, and keeping the done ones is the whole
    // point of doing it there.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "failed" });
    await seedImage(t, JOB_A, 0, USER_A.subject, "failed");
    await seedImage(t, JOB_A, 1, USER_A.subject, "done");

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    const images = await getImages(t, JOB_A);
    expect(images.map((i) => i.entryIndex)).toEqual([0, 1]);
    expect(images.map((i) => i.status)).toEqual(["failed", "done"]);
  });

  test("starting clears a previous run's terminal error fields", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "failed" });
    await t.run(async (ctx) => {
      const jobs = await ctx.db.query("placeholderJobs").collect();
      const job = jobs.find((j) => j.jobId === JOB_A);
      await ctx.db.patch(job!._id, {
        errorCode: "ZIP_REJECTED",
        errorDetail: "old failure",
        finishedAt: 123,
      });
    });

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    const job = await getJob(t, JOB_A);
    expect(job?.errorCode).toBeUndefined();
    expect(job?.errorDetail).toBeUndefined();
    expect(job?.finishedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startPlaceholderBatch — the per-user active-batch cap
// ---------------------------------------------------------------------------

describe("startPlaceholderBatch — per-user active-batch cap", () => {
  test("refuses a third concurrent batch, and says why", async () => {
    // The cap bounds two things at once: concurrent /extract calls, which do
    // NOT go through the workpool and so are not bounded by its parallelism,
    // and how fast one account can replay paid per-image API spend.
    const t = convexTest(schema, modules);
    await seedJob(t, { jobId: "job-active-1", status: "processing" });
    await seedJob(t, { jobId: "job-active-2", status: "pairing" });
    await seedJob(t, { jobId: JOB_A, status: "uploaded" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/active batches/i);
    expect((await getJob(t, JOB_A))?.status).toBe("uploaded");
  });

  test("allows a second batch — the cap is two, not one", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { jobId: "job-active-1", status: "extracting" });
    await seedJob(t, { jobId: JOB_A, status: "uploaded" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    expect(result.started).toBe(true);
    expect((await getJob(t, JOB_A))?.status).toBe("extracting");
  });

  test.each(["pending", "uploaded", "succeeded", "failed"] as const)(
    "a %s job is not active and does not count toward the cap",
    async (status) => {
      // Counting "pending" in particular would leave a user with two unstarted
      // uploads unable to start either of them.
      const t = convexTest(schema, modules);
      await seedJob(t, { jobId: "job-idle-1", status });
      await seedJob(t, { jobId: "job-idle-2", status });
      await seedJob(t, { jobId: JOB_A, status: "uploaded" });

      const result = await t
        .withIdentity(USER_A)
        .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

      expect(result.started).toBe(true);
    },
  );

  test("another user's active batches do not count against you", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { jobId: "job-b-1", userId: USER_B.subject, status: "processing" });
    await seedJob(t, { jobId: "job-b-2", userId: USER_B.subject, status: "processing" });
    await seedJob(t, { jobId: JOB_A, status: "uploaded" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    expect(result.started).toBe(true);
  });

  test("a canceled batch frees its slot immediately", async () => {
    // Cancel forces "failed", which is not an active status — so the recovery
    // path (cancel, then start again) is never blocked by the job it just
    // canceled.
    const t = convexTest(schema, modules);
    await seedJob(t, { jobId: "job-active-1", status: "processing" });
    await seedJob(t, { jobId: "job-active-2", status: "processing" });

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: "job-active-2" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-active-2" });
    expect(result.started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sweepJobPairs
// ---------------------------------------------------------------------------

describe("sweepJobPairs", () => {
  async function seedPair(
    t: ReturnType<typeof convexTest>,
    jobId: string,
    frontIndex: number,
    backIndex: number,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderPairs", {
        jobId,
        userId: USER_A.subject,
        frontIndex,
        backIndex,
        confidence: "side-only",
        mechanism: "adjacency",
        score: 0,
      });
    });
  }

  test("deletes this job's pairs and leaves every other job alone", async () => {
    const t = convexTest(schema, modules);
    await seedPair(t, JOB_A, 0, 1);
    await seedPair(t, JOB_A, 2, 3);
    await seedPair(t, "job-other", 0, 1);

    const result = await t.mutation(internal.placeholderPipeline.sweepJobPairs, {
      jobId: JOB_A,
    });

    expect(result).toEqual({ deleted: 2, done: true });
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("placeholderPairs").collect(),
    );
    expect(remaining.map((p) => p.jobId)).toEqual(["job-other"]);
  });

  test("is a no-op on a first run, when there is nothing to sweep", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.placeholderPipeline.sweepJobPairs, { jobId: JOB_A }),
    ).resolves.toEqual({ deleted: 0, done: true });
  });

  test("starting a batch schedules the sweep rather than deleting inline", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "failed" });
    await seedPair(t, JOB_A, 0, 1);

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    // Still there: the mutation the user waited on did not do this work.
    const pairs = await t.run(async (ctx) => ctx.db.query("placeholderPairs").collect());
    expect(pairs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// registerExtractedImages — the restart-preserving upsert
// ---------------------------------------------------------------------------

describe("registerExtractedImages", () => {
  test("inserts rows for accepted entries only, and counts the rest as rejected", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    const result = await registerAll(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
        { index: 2, name: "notes.txt", accepted: false },
      ],
    });

    expect(result).toEqual({
      totalImages: 2,
      rejectedEntries: 1,
      keptDone: 0,
      done: true,
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("processing");
    expect(job?.totalImages).toBe(2);
    expect(job?.rejectedEntries).toBe(1);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);

    const images = await getImages(t, JOB_A);
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.entryIndex)).toEqual([0, 1]);
    expect(images.every((i) => i.status === "queued")).toBe(true);
    expect(images.every((i) => i.userId === USER_A.subject)).toBe(true);
    expect(images.every((i) => i.workId === undefined)).toBe(true);
  });

  test("a restart KEEPS images that already succeeded, clearing only pairStatus", async () => {
    // The reason this whole function is an upsert: re-running a done entry is
    // another Vision round-trip and another model inference, paid for, to
    // re-derive an answer we already have. The upload is write-once, so the
    // answer cannot have changed.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    const doneId = await seedImage(t, JOB_A, 0, USER_A.subject, "done", {
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "24",
      side: "front",
      textCount: 2,
      dhash: "0f1e2d3c4b5a6978",
      pairStatus: "paired",
      workId: "work-old-0",
    });

    const result = await registerAll(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    expect(result.keptDone).toBe(1);

    const kept = await t.run(async (ctx) => ctx.db.get(doneId));
    expect(kept?.status).toBe("done");
    expect(kept?.players).toEqual(["Ken Griffey Jr."]);
    expect(kept?.dhash).toBe("0f1e2d3c4b5a6978");
    // Pairing re-runs from scratch and re-decides this field, so the previous
    // verdict must not survive into the new run.
    expect(kept?.pairStatus).toBeUndefined();

    const job = await getJob(t, JOB_A);
    expect(job?.totalImages).toBe(2);
    // The kept image is already accounted for, so `processed + failed ===
    // total` stays the batch-complete condition after a partial restart.
    expect(job?.processedImages).toBe(1);
    expect(job?.failedImages).toBe(0);
  });

  test("a restart RESETS every non-done row, dropping the last attempt's state", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    const failedId = await seedImage(t, JOB_A, 0, USER_A.subject, "failed", {
      workId: "work-old-0",
      players: ["Stale Name"],
      team: "Stale Team",
      cardNumber: "999",
      side: "back",
      rotationDegrees: 180,
      orientConfidence: 0.1,
      textCount: 3,
      croppedSource: "fallback",
      dhash: "aaaabbbbccccdddd",
      errorCode: "PROCESS_ENTRY_FAILED",
      errorDetail: "boom",
      pairStatus: "unmatched",
    });
    const stuckId = await seedImage(t, JOB_A, 1, USER_A.subject, "processing", {
      workId: "work-old-1",
    });

    await registerAll(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    const reset = await t.run(async (ctx) => ctx.db.get(failedId));
    expect(reset?.status).toBe("queued");
    expect(reset?.workId).toBeUndefined();
    expect(reset?.players).toBeUndefined();
    expect(reset?.team).toBeUndefined();
    expect(reset?.cardNumber).toBeUndefined();
    expect(reset?.side).toBeUndefined();
    expect(reset?.rotationDegrees).toBeUndefined();
    expect(reset?.orientConfidence).toBeUndefined();
    expect(reset?.textCount).toBeUndefined();
    expect(reset?.croppedSource).toBeUndefined();
    expect(reset?.dhash).toBeUndefined();
    expect(reset?.errorCode).toBeUndefined();
    expect(reset?.errorDetail).toBeUndefined();
    expect(reset?.pairStatus).toBeUndefined();

    // A row stranded mid-flight by a cancel is reset the same way — otherwise
    // it would be skipped by enqueueImageChunk (not "queued") and never run.
    expect((await t.run(async (ctx) => ctx.db.get(stuckId)))?.status).toBe("queued");
    expect((await t.run(async (ctx) => ctx.db.get(stuckId)))?.workId).toBeUndefined();

    const job = await getJob(t, JOB_A);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
  });

  test("a duplicated entry index is deduped, first occurrence wins", async () => {
    // (jobId, entryIndex) is the key every read of this table uses, and
    // `unique()` on it throws when two rows match — a duplicate row would not
    // be a cosmetic problem, it would poison every later read of the job.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    const result = await registerAll(t, {
      entries: [
        { index: 0, name: "first.jpg", accepted: true },
        { index: 0, name: "second.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    expect(result.totalImages).toBe(2);
    // A duplicate is OUR bug, not something extract rejected about the user's
    // zip, so it must not be reported as a rejection.
    expect(result.rejectedEntries).toBe(0);

    const images = await getImages(t, JOB_A);
    expect(images.map((i) => i.entryIndex)).toEqual([0, 1]);
    expect(images[0].originalName).toBe("first.jpg");
  });

  test("chunks a zip larger than one transaction's worth of entries", async () => {
    // The chunk size is sized against MAX_ZIP_ENTRIES in the preprocess repo;
    // 120 entries is three chunks, which is what proves the cursor and the
    // carried keptDone survive the hand-off.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    const entries = Array.from({ length: 120 }, (_, i) => ({
      index: i,
      name: `scan-${i}.jpg`,
      accepted: true,
    }));

    const result = await registerAll(t, { entries });

    expect(result).toEqual({
      totalImages: 120,
      rejectedEntries: 0,
      keptDone: 0,
      done: true,
    });
    const images = await getImages(t, JOB_A);
    expect(images).toHaveLength(120);
    expect(images.every((i) => i.status === "queued")).toBe(true);
    expect((await getJob(t, JOB_A))?.totalImages).toBe(120);
  });

  test("an intermediate chunk reports done:false and leaves the job in extracting", async () => {
    // The counters and the "processing" transition belong to the LAST chunk —
    // a job that flipped to processing halfway through registration would
    // advertise a total it does not yet have rows for.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    const entries = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      name: `scan-${i}.jpg`,
      accepted: true,
    }));

    const first = await t.mutation(internal.placeholderPipeline.registerExtractedImages, {
      jobId: JOB_A,
      userId: USER_A.subject,
      entries,
      from: 0,
    });

    expect(first.done).toBe(false);
    expect((await getJob(t, JOB_A))?.status).toBe("extracting");
    expect(await getImages(t, JOB_A)).toHaveLength(50);
  });

  test("a cancel during extraction is not undone when extract finally returns", async () => {
    // Extract can be in flight for minutes and cancel is now terminal
    // immediately, so this is a routine ordering, not a rare race. Without the
    // guard the job would flip back to "processing" and enqueue a whole zip's
    // worth of paid work the user had already stopped.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });

    await registerAll(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("CANCELED");
    expect(await getImages(t, JOB_A)).toHaveLength(0);
  });

  test("rejects a userId that disagrees with the job row", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await expect(
      t.mutation(internal.placeholderPipeline.registerExtractedImages, {
        jobId: JOB_A,
        userId: USER_B.subject,
        entries: [{ index: 0, name: "front.jpg", accepted: true }],
      }),
    ).rejects.toThrow(/ownership mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// pruneUnregisteredImages — the invariant guard and the hand-off
// ---------------------------------------------------------------------------

describe("pruneUnregisteredImages", () => {
  test("deletes rows whose entry index is not in the accepted set", async () => {
    // This should be unreachable — the upload is write-once, so a second
    // extract sees the same entries. The guard matters because an orphan would
    // be enqueued, complete, and push processedImages past totalImages, at
    // which point the equality that ends the batch is stepped over forever.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "queued");
    await seedImage(t, JOB_A, 1, USER_A.subject, "queued");
    await seedImage(t, JOB_A, 7, USER_A.subject, "queued");
    await seedImage(t, "job-other", 7, USER_A.subject, "queued");

    const result = await pruneOnce(t, [0, 1]);

    expect(result.deleted).toBe(1);
    expect((await getImages(t, JOB_A)).map((i) => i.entryIndex)).toEqual([0, 1]);
    // Another job's rows are out of scope entirely.
    expect(await getImages(t, "job-other")).toHaveLength(1);
  });

  test("hands a job with no usable images straight to pairing", async () => {
    // Nothing will be enqueued, so no onComplete ever fires and the
    // last-one-done transition can never run. Without this branch the job
    // spins forever.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    await registerAndPrune(t, {
      entries: [{ index: 0, name: "readme.txt", accepted: false }],
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("pairing");
    expect(job?.totalImages).toBe(0);
    expect(job?.rejectedEntries).toBe(1);
  });

  test("hands a restart whose images were ALL already done straight to pairing", async () => {
    // Same wedge, different cause: every row is kept in "done", so
    // enqueueImageChunk enqueues nothing and no completion will ever arrive to
    // fire the transition. The counters already say the batch is finished, so
    // pairing is where it belongs.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await seedImage(t, JOB_A, 1, USER_A.subject, "done");

    const result = await registerAndPrune(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    expect(result.keptDone).toBe(2);
    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("pairing");
    expect(job?.processedImages).toBe(2);
    expect(job?.totalImages).toBe(2);
  });

  test("does not hand a canceled job onward", async () => {
    // The sweep is scheduled behind registration, so a cancel can land between
    // them. Scheduling the next stage on top of a terminal job would undo the
    // cancel.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await registerAll(t, { entries: [{ index: 0, name: "front.jpg", accepted: true }] });
    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });

    await pruneOnce(t, [0]);

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("CANCELED");
  });

  test("leaves a job with outstanding work in processing, for the enqueue chain", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");

    await registerAndPrune(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("processing");
    expect(job?.processedImages).toBe(1);
    expect(job?.totalImages).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// enqueueImageChunk — only the guard, which is all that is reachable here
// ---------------------------------------------------------------------------

describe("enqueueImageChunk", () => {
  test.each(["failed", "succeeded", "pairing"] as const)(
    "enqueues nothing for a %s job, without reaching the pool",
    async (status) => {
      // Enqueuing a full zip is twenty of these mutations; a cancel landing
      // mid-way has to stop the remaining nineteen, each of which would create
      // fifty more paid `/process-entry` calls. That the pool is never touched
      // is what this asserts — `preprocessPool.enqueueAction` would throw here,
      // since convex-test cannot mount the workpool component, so reaching it
      // fails the test rather than passing quietly.
      const t = convexTest(schema, modules);
      await seedJob(t, { status, totalImages: 1 });
      await seedImage(t, JOB_A, 0, USER_A.subject, "queued");

      await expect(
        t.mutation(internal.placeholderPipeline.enqueueImageChunk, {
          jobId: JOB_A,
          from: 0,
        }),
      ).resolves.toEqual({ enqueued: 0, done: true });

      expect((await getImages(t, JOB_A))[0].status).toBe("queued");
    },
  );
});

// ---------------------------------------------------------------------------
// recordImageOutcomeImpl — the completion seam
// ---------------------------------------------------------------------------

describe("recordImageOutcomeImpl", () => {
  test("success maps the snake_case wire body onto the row and marks it done", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId },
        { kind: "success", returnValue: SUCCESS_BODY },
      ),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("done");
    expect(image?.players).toEqual(["Ken Griffey Jr."]);
    expect(image?.team).toBe("Seattle Mariners");
    expect(image?.cardNumber).toBe("24");
    expect(image?.side).toBe("back");
    expect(image?.rotationDegrees).toBe(90);
    expect(image?.orientConfidence).toBeCloseTo(0.87);
    expect(image?.textCount).toBe(42);
    expect(image?.croppedSource).toBe("tiered");
    expect(image?.dhash).toBe("0f1e2d3c4b5a6978");
    // The service's `player` field is derived from players[0] on its side, so
    // there is no column for it — a stored copy could only ever go stale.
    expect(image).not.toHaveProperty("player");

    const job = await getJob(t, JOB_A);
    expect(job?.processedImages).toBe(1);
    expect(job?.failedImages).toBe(0);
    // Not the last image — the batch must still be processing.
    expect(job?.status).toBe("processing");
  });

  test("a malformed dhash is dropped rather than stored", async () => {
    // Pairing compares hashes by Hamming distance; a bad hash would not fail
    // loudly, it would silently mis-pair cards.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId },
        { kind: "success", returnValue: { ...SUCCESS_BODY, dhash: "NOT-A-HASH" } },
      ),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.dhash).toBeUndefined();
    // The rest of the payload still lands — one bad field must not lose the row.
    expect(image?.players).toEqual(["Ken Griffey Jr."]);
    expect(image?.status).toBe("done");
  });

  test("oversized classifier strings are capped instead of stored whole", async () => {
    // These values are a model's reading of a user-supplied image, so their
    // length is attacker-influenced. Uncapped, one of them pushes the row past
    // the 1MB document limit; the patch inside the onComplete mutation throws;
    // the image never reaches a terminal status and the job's counters never
    // reach their total. A bad value must cost its own field, never the batch.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId },
        {
          kind: "success",
          returnValue: {
            ...SUCCESS_BODY,
            players: Array.from({ length: 40 }, (_, i) => `${"x".repeat(5000)}-${i}`),
            team: "t".repeat(9000),
            card_number: "9".repeat(4000),
            cropped_source: "c".repeat(3000),
          },
        },
      ),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.players).toHaveLength(8);
    expect(image?.players?.every((p) => p.length === 200)).toBe(true);
    expect(image?.team).toHaveLength(200);
    expect(image?.cardNumber).toHaveLength(200);
    expect(image?.croppedSource).toHaveLength(200);
    expect(image?.status).toBe("done");
  });

  test("a players array with a non-string element is dropped, not filtered", async () => {
    // Filtering would renumber the list silently, and players[0] is the
    // headline name every caller reads.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId },
        {
          kind: "success",
          returnValue: { ...SUCCESS_BODY, players: ["Ken Griffey Jr.", 42] },
        },
      ),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.players).toBeUndefined();
    expect(image?.status).toBe("done");
  });

  test("failure marks the row failed with a code and detail, and counts as failed", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId },
        { kind: "failed", error: "preprocess HTTP 502: upstream boom" },
      ),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("failed");
    expect(image?.errorCode).toBe("PROCESS_ENTRY_FAILED");
    expect(image?.errorDetail).toContain("502");

    const job = await getJob(t, JOB_A);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(1);
  });

  test("cancellation is recorded as a failed image with a CANCELED code", async () => {
    // Canceled work still flows through onComplete — that is what lets the
    // counters converge, so a cancel doesn't strand the batch mid-flight.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(ctx, { jobId: JOB_A, imageId }, { kind: "canceled" }),
    );

    const image = await t.run(async (ctx) => ctx.db.get(imageId));
    expect(image?.status).toBe("failed");
    expect(image?.errorCode).toBe("CANCELED");
    expect((await getJob(t, JOB_A))?.failedImages).toBe(1);
  });

  test("the invocation that completes the last image moves the job to pairing", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const first = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");
    const second = await seedImage(t, JOB_A, 1, USER_A.subject, "processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId: first },
        { kind: "success", returnValue: SUCCESS_BODY },
      ),
    );
    expect((await getJob(t, JOB_A))?.status).toBe("processing");

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId: second },
        { kind: "failed", error: "boom" },
      ),
    );

    const job = await getJob(t, JOB_A);
    // A mix of success and failure still completes the batch — the terminal
    // verdict is pairing's to make, not processing's.
    expect(job?.status).toBe("pairing");
    expect(job?.processedImages).toBe(1);
    expect(job?.failedImages).toBe(1);
  });

  test("a restart's preserved images are already counted, so one completion finishes the batch", async () => {
    // The end-to-end statement of the restart contract: two images, one kept
    // from the previous attempt, and the single remaining completion is the
    // one that ends the batch.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await registerAndPrune(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    const remaining = (await getImages(t, JOB_A)).find((i) => i.entryIndex === 1)!;
    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB_A, imageId: remaining._id },
        { kind: "success", returnValue: SUCCESS_BODY },
      ),
    );

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("pairing");
    expect(job?.processedImages).toBe(2);
  });

  test("a repeated completion for an already-terminal image does not double-count", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) =>
        recordImageOutcomeImpl(
          ctx,
          { jobId: JOB_A, imageId },
          { kind: "success", returnValue: SUCCESS_BODY },
        ),
      );
    }

    const job = await getJob(t, JOB_A);
    expect(job?.processedImages).toBe(1);
    expect(job?.failedImages).toBe(0);
    // Critically: the counters never overshoot the total, which is what the
    // completion condition compares against.
    expect(job?.status).toBe("processing");
  });

  test("a completion for a deleted image row is a no-op, not a throw", async () => {
    // The stale-row sweep can delete a row while old work is still draining.
    // Throwing here would make the pool retry a mutation that can never
    // succeed.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 1, processedImages: 0, failedImages: 0 });
    const imageId = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");
    await t.run(async (ctx) => ctx.db.delete(imageId));

    await expect(
      t.run(async (ctx) =>
        recordImageOutcomeImpl(
          ctx,
          { jobId: JOB_A, imageId },
          { kind: "success", returnValue: SUCCESS_BODY },
        ),
      ),
    ).resolves.toBeNull();

    expect((await getJob(t, JOB_A))?.processedImages ?? 0).toBe(0);
  });

  test("a late completion arriving after a cancel-and-restart cannot resurrect the batch", async () => {
    // Cancel now forces the job terminal, and the pool's onComplete for the
    // canceled work arrives afterwards. It must not fire the pairing
    // transition (the job is no longer "processing") and must not clobber a
    // row the restart has since reset.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 0, failedImages: 0 });
    const first = await seedImage(t, JOB_A, 0, USER_A.subject, "processing");
    await seedImage(t, JOB_A, 1, USER_A.subject, "processing");

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });
    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });
    await registerAndPrune(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });

    // The pool finally reports the work canceled by step one.
    await expect(
      t.run(async (ctx) =>
        recordImageOutcomeImpl(ctx, { jobId: JOB_A, imageId: first }, { kind: "canceled" }),
      ),
    ).resolves.toBeNull();

    const job = await getJob(t, JOB_A);
    // The new run owns the job now: it is processing, not pairing, and not
    // succeeded.
    expect(job?.status).toBe("processing");
    expect(job?.totalImages).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Terminal-status mutations
// ---------------------------------------------------------------------------

describe("markJobFailed / markJobSucceeded", () => {
  test("markJobFailed sets the status, the grouping code, the detail and finishedAt", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    await t.mutation(internal.placeholderPipeline.markJobFailed, {
      jobId: JOB_A,
      errorCode: "ZIP_REJECTED",
      errorDetail: "zip contained a path traversal entry",
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("ZIP_REJECTED");
    expect(job?.errorDetail).toContain("path traversal");
    expect(job?.finishedAt).toBeGreaterThan(0);
  });

  test("markJobFailed on an unknown job is a no-op", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.placeholderPipeline.markJobFailed, {
        jobId: "job-nope",
        errorCode: "ZIP_REJECTED",
      }),
    ).resolves.toBeNull();
  });

  test("markJobSucceeded clears any stale error fields", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing" });
    await t.mutation(internal.placeholderPipeline.markJobFailed, {
      jobId: JOB_A,
      errorCode: "STALE",
      errorDetail: "stale",
    });

    await t.mutation(internal.placeholderPipeline.markJobSucceeded, { jobId: JOB_A });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("succeeded");
    expect(job?.errorCode).toBeUndefined();
    expect(job?.errorDetail).toBeUndefined();
    expect(job?.finishedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cancelPlaceholderBatch — the paths that don't need the pool
// ---------------------------------------------------------------------------

describe("cancelPlaceholderBatch", () => {
  test("throws for a job the caller does not own", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing" });
    await expect(
      t
        .withIdentity(USER_B)
        .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A }),
    ).rejects.toThrow(/job not found/i);
  });

  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing" });
    await expect(
      t.mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test.each(["succeeded", "failed"] as const)(
    "refuses to cancel a %s job without touching the pool",
    async (status) => {
      const t = convexTest(schema, modules);
      await seedJob(t, { status });
      const result = await t
        .withIdentity(USER_A)
        .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });
      expect(result.canceled).toBe(false);
      expect(result.canceledCount).toBe(0);
      expect(result.reason).toContain(status);
    },
  );

  test.each(["extracting", "processing", "pairing"] as const)(
    "forces a %s job terminal, so a wedged batch has a way out",
    async (status) => {
      // Without this the only exit from a mid-flight status was the counters
      // reaching their total. If any link of the chain is lost that never
      // happens, and the job is stuck: not terminal, so not startable either.
      const t = convexTest(schema, modules);
      await seedJob(t, { status, totalImages: 3, processedImages: 1, failedImages: 0 });
      // No workId on the rows, so the cancel loop skips the pool entirely —
      // the terminal patch is what is under test here.
      await seedImage(t, JOB_A, 0, USER_A.subject, "processing");

      const result = await t
        .withIdentity(USER_A)
        .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });

      expect(result.canceled).toBe(true);
      const job = await getJob(t, JOB_A);
      expect(job?.status).toBe("failed");
      expect(job?.errorCode).toBe("CANCELED");
      expect(job?.errorDetail).toMatch(/canceled by user/i);
      expect(job?.finishedAt).toBeGreaterThan(0);
    },
  );

  test("a canceled job is startable again, and the restart keeps its done images", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", totalImages: 2, processedImages: 1, failedImages: 0 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await seedImage(t, JOB_A, 1, USER_A.subject, "processing");

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB_A });

    const restart = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });
    expect(restart.started).toBe(true);

    const result = await registerAndPrune(t, {
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
      ],
    });
    // Recovery costs one image, not two.
    expect(result.keptDone).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runExtract — what a failed extract is allowed to tell the user
// ---------------------------------------------------------------------------

describe("runExtract error hygiene", () => {
  test("a rejected upload fails the job WITHOUT storing the upstream response body", async () => {
    // `errorDetail` is returned by getPlaceholderJob, a public query, so it is
    // rendered in the owner's browser. The adapter's thrown message carries up
    // to 400 characters of the raw response so the failure is debuggable from
    // a log line — and that body is not ours: Cloud Run's own HTML for a shed
    // request, a framework traceback for a service exception. The status and a
    // fixed phrase are the parts a user can act on; the rest belongs in the
    // operator channel.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });
    process.env.NEONBINDER_PREPROCESS_URL = "http://localhost:9998";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error_code: "ZIP_REJECTED",
            detail: "<html><body>internal-host-9f2c.run.internal blew up</body></html>",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      await t.action(internal.placeholderBatch.runExtract, {
        jobId: JOB_A,
        userId: USER_A.subject,
      });
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
      delete process.env.NEONBINDER_PREPROCESS_URL;
    }

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    // The machine-readable half survives — that is what alerts group on.
    expect(job?.errorCode).toBe("ZIP_REJECTED");
    // The human-readable half is ours, and mentions the status and nothing else.
    expect(job?.errorDetail).toBe("the upload could not be extracted (HTTP 422)");
    expect(job?.errorDetail).not.toMatch(/html|run\.internal/i);
  });
});

// ---------------------------------------------------------------------------
// runPairing — the last link in the chain
// ---------------------------------------------------------------------------

describe("runPairing", () => {
  test("pairs two adjacent sides, marks both images, and succeeds the job", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 2, processedImages: 2, failedImages: 0 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done", {
      side: "front",
      textCount: 1,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "24",
    });
    await seedImage(t, JOB_A, 1, USER_A.subject, "done", {
      side: "back",
      textCount: 40,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "24",
    });

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB_A,
      userId: USER_A.subject,
    });

    expect((await getJob(t, JOB_A))?.status).toBe("succeeded");
    const images = await getImages(t, JOB_A);
    expect(images.map((i) => i.pairStatus)).toEqual(["paired", "paired"]);

    const pairs = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderPairs, { jobId: JOB_A });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].frontIndex).toBe(0);
    expect(pairs[0].backIndex).toBe(1);
    // `createdAt` is the system `_creationTime`, not a stored column.
    expect(pairs[0].createdAt).toBeGreaterThan(0);
  });

  test("marks an image that found no partner as unmatched, by id", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 1, processedImages: 1, failedImages: 0 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done", { side: "front", textCount: 1 });

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB_A,
      userId: USER_A.subject,
    });

    const images = await getImages(t, JOB_A);
    expect(images[0].pairStatus).toBe("unmatched");
    expect((await getJob(t, JOB_A))?.status).toBe("succeeded");
  });

  test("a batch where most images failed is terminal-failed, not succeeded", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 3, processedImages: 1, failedImages: 2 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done", { side: "front", textCount: 1 });

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB_A,
      userId: USER_A.subject,
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("TOO_MANY_IMAGE_FAILURES");
  });

  test("any escape from the body lands the job in failed/PAIRING_FAILED, never in limbo", async () => {
    // "pairing" is not terminal and nothing is scheduled behind this action,
    // so a throw here used to mean a spinner that never stops. The pairing
    // library is defensive by construction (a throwing resolver, a throwing
    // hasher and a malformed hash all degrade rather than raise), so the fault
    // is injected at the summary log line instead — what is under test is that
    // NO escape leaves the job non-terminal, not which line threw.
    //
    // The injection matches on the message and fires once. An unconditional
    // throwing `console.log` looks equivalent and is not: vitest runs several
    // test files in one worker process, so a log from any of them lands in
    // this mock, throws outside any awaited call, and takes the whole worker
    // down as an unhandled error — a genuinely intermittent failure roughly
    // one run in seven, which is exactly the kind of "flake" that is really a
    // test bug.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 1, processedImages: 1, failedImages: 0 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done", { side: "front", textCount: 1 });

    let injected = false;
    const log = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
      if (injected) return;
      if (typeof logArgs[0] !== "string" || !logArgs[0].includes("placeholder_pairing_done")) {
        return;
      }
      injected = true;
      throw new Error("Documents read from or written to the table changed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        t.action(internal.placeholderPairing.runPairing, {
          jobId: JOB_A,
          userId: USER_A.subject,
        }),
      ).resolves.toBeNull();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    // The fault actually fired — otherwise this test would pass vacuously.
    expect(injected).toBe(true);
    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("PAIRING_FAILED");
    expect(job?.errorDetail).toContain("changed");
    expect(job?.finishedAt).toBeGreaterThan(0);
    // And "failed" is startable, so the user's next click is a cheap restart.
    const restart = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });
    expect(restart.started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Public reactive queries — ownership scoping
// ---------------------------------------------------------------------------

describe("public queries are scoped to the caller's own jobs", () => {
  async function seedFullJob(t: ReturnType<typeof convexTest>) {
    await seedJob(t, { status: "succeeded", totalImages: 2, processedImages: 2, failedImages: 0 });
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await seedImage(t, JOB_A, 1, USER_A.subject, "done");
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderPairs", {
        jobId: JOB_A,
        userId: USER_A.subject,
        frontIndex: 0,
        backIndex: 1,
        player: "Ken Griffey Jr.",
        confidence: "exact",
        mechanism: "pool",
        score: 7,
      });
    });
  }

  test("the owner sees the job, its counters and its pair count", async () => {
    const t = convexTest(schema, modules);
    await seedFullJob(t);

    const job = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB_A });

    expect(job).not.toBeNull();
    expect(job?.status).toBe("succeeded");
    expect(job?.totalImages).toBe(2);
    expect(job?.processedImages).toBe(2);
    expect(job?.pairCount).toBe(1);
  });

  test("getPlaceholderJob never returns the server-only objectPath", async () => {
    // Returning it would re-introduce the client-supplied-path problem the
    // whole design exists to prevent — see the schema.ts table comment.
    const t = convexTest(schema, modules);
    await seedFullJob(t);
    const job = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB_A });
    expect(job).not.toHaveProperty("objectPath");
  });

  test("user B gets null for user A's job, and the same null for a job that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    await seedFullJob(t);

    await expect(
      t.withIdentity(USER_B).query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB_A }),
    ).resolves.toBeNull();
    await expect(
      t
        .withIdentity(USER_B)
        .query(api.placeholderPipeline.getPlaceholderJob, { jobId: "job-nope" }),
    ).resolves.toBeNull();
  });

  test("listPlaceholderImages returns the owner's images in index order, and nothing to user B", async () => {
    const t = convexTest(schema, modules);
    await seedFullJob(t);

    const mine = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderImages, { jobId: JOB_A });
    expect(mine.map((i) => i.entryIndex)).toEqual([0, 1]);
    // `workId` is a workpool handle, not client data.
    expect(mine[0]).not.toHaveProperty("workId");
    // No `player` column exists to leak; players[0] is the headline name.
    expect(mine[0]).not.toHaveProperty("player");

    await expect(
      t.withIdentity(USER_B).query(api.placeholderPipeline.listPlaceholderImages, { jobId: JOB_A }),
    ).resolves.toEqual([]);
  });

  test("listPlaceholderPairs returns the owner's pairs, and nothing to user B", async () => {
    const t = convexTest(schema, modules);
    await seedFullJob(t);

    const mine = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderPairs, { jobId: JOB_A });
    expect(mine).toHaveLength(1);
    expect(mine[0].frontIndex).toBe(0);
    expect(mine[0].confidence).toBe("exact");
    expect(mine[0].createdAt).toBeGreaterThan(0);

    await expect(
      t.withIdentity(USER_B).query(api.placeholderPipeline.listPlaceholderPairs, { jobId: JOB_A }),
    ).resolves.toEqual([]);
  });

  test.each([
    "getPlaceholderJob",
    "listPlaceholderImages",
    "listPlaceholderPairs",
  ] as const)("%s throws when unauthenticated", async (name) => {
    const t = convexTest(schema, modules);
    await seedFullJob(t);
    await expect(
      t.query(api.placeholderPipeline[name], { jobId: JOB_A }),
    ).rejects.toThrow(/not authenticated/i);
  });
});

// ---------------------------------------------------------------------------
// listDoneImagesForPairing — the pairing pass's input
// ---------------------------------------------------------------------------

describe("listDoneImagesForPairing", () => {
  test("returns only done rows, in zip order, with the id pairing writes back on", async () => {
    // Order is part of the algorithm's input, not a display preference: the
    // adjacency pre-pass assumes a sheet's front and back are neighbours. The
    // `_id` is what lets pairing patch the exact row it read, minutes later,
    // rather than re-resolving a key a restart may have re-pointed.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 4 });
    await seedImage(t, JOB_A, 2, USER_A.subject, "done");
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await seedImage(t, JOB_A, 1, USER_A.subject, "failed");
    await seedImage(t, JOB_A, 3, USER_A.subject, "done");

    const rows = await t.query(internal.placeholderPipeline.listDoneImagesForPairing, {
      jobId: JOB_A,
    });

    expect(rows.map((r) => r.entryIndex)).toEqual([0, 2, 3]);
    expect(rows.every((r) => typeof r._id === "string" && r._id.length > 0)).toBe(true);
  });
});

// ── NEO-176: env-configurable active-batch limit ────────────────────────────
// Mirrors the resolver tests in preprocessCapacity.test.ts: valid integers in
// range are honoured, everything else falls back to the default rather than
// being clamped or coerced, and a present-but-invalid value is warned about.
describe("resolveMaxActiveJobsPerUser", () => {
  /** Resolve while capturing the diagnostic, so both halves can be asserted. */
  function resolveWithWarnings(raw: string | undefined) {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string") warnings.push(args[0]);
    });
    try {
      return { value: resolveMaxActiveJobsPerUser(raw), warnings };
    } finally {
      warn.mockRestore();
    }
  }

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("falls back to the default when %s, without warning", (_label, raw) => {
    // Unset is the INTENDED configuration on dev/preview — no diagnostic.
    const { value, warnings } = resolveWithWarnings(raw);
    expect(value).toBe(2);
    expect(value).toBe(DEFAULT_MAX_ACTIVE_JOBS_PER_USER);
    expect(warnings.filter((w) => w.includes("max_active_jobs_per_user"))).toHaveLength(0);
  });

  test.each([
    ["the raised prod value", "3", 3],
    ["the default stated explicitly", "2", 2],
    ["the minimum", "1", 1],
    ["the maximum accepted", "10", 10],
    ["a value with surrounding whitespace", "  3  ", 3],
  ])("accepts %s", (_label, raw, expected) => {
    const { value, warnings } = resolveWithWarnings(raw);
    expect(value).toBe(expected);
    expect(warnings.filter((w) => w.includes("max_active_jobs_per_user"))).toHaveLength(0);
  });

  test.each([
    ["zero", "0"],
    ["negative", "-2"],
    ["above the accepted ceiling", "11"],
    ["a typo'd digit", "30"],
    ["non-numeric", "three"],
    ["a trailing-garbage number", "3abc"],
    ["an out-of-range exponent", "2e3"],
    ["fractional", "2.5"],
    ["infinity", "Infinity"],
  ])("falls back for %s rather than clamping or coercing", (_label, raw) => {
    const { value } = resolveWithWarnings(raw);
    expect(value).toBe(DEFAULT_MAX_ACTIVE_JOBS_PER_USER);
  });

  test("an invalid value is reported with what was configured and what was used", () => {
    const { warnings } = resolveWithWarnings("30");
    const lines = warnings
      .filter((w) => w.includes("max_active_jobs_per_user_invalid"))
      .map((w) => JSON.parse(w) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: "max_active_jobs_per_user_invalid",
      configured: "30",
      using: 2,
      accepted: "integer 1-10",
    });
  });
});
