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
 * they would touch it (`cancelPlaceholderBatch` on an already-terminal job
 * returns before the loop), and `enqueueImageChunk` is left to integration.
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
import type { Id } from "./_generated/dataModel";
import { recordImageOutcomeImpl } from "./placeholderPipeline";

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
  index: number,
  userId = USER_A.subject,
  status: "queued" | "processing" | "done" | "failed" = "queued",
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId,
      userId,
      index,
      originalName: `scan-${index}.jpg`,
      status,
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

  test("restarting a failed job deletes the previous run's images and pairs", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "failed" });
    await seedImage(t, JOB_A, 0, USER_A.subject, "failed");
    await seedImage(t, JOB_A, 1, USER_A.subject, "done");
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderPairs", {
        jobId: JOB_A,
        userId: USER_A.subject,
        frontIndex: 0,
        backIndex: 1,
        confidence: "side-only",
        mechanism: "adjacency",
        score: 0,
        createdAt: 1,
      });
      // A different job's rows must survive the reset.
      await ctx.db.insert("placeholderImages", {
        jobId: "job-other",
        userId: USER_A.subject,
        index: 0,
        originalName: "other.jpg",
        status: "done",
      });
    });

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB_A });

    const { mine, others, pairs } = await t.run(async (ctx) => {
      const images = await ctx.db.query("placeholderImages").collect();
      return {
        mine: images.filter((i) => i.jobId === JOB_A).length,
        others: images.filter((i) => i.jobId === "job-other").length,
        pairs: (await ctx.db.query("placeholderPairs").collect()).length,
      };
    });
    expect(mine).toBe(0);
    expect(pairs).toBe(0);
    expect(others).toBe(1);
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
// registerExtractedImages
// ---------------------------------------------------------------------------

describe("registerExtractedImages", () => {
  test("inserts rows for accepted entries only, and counts the rest as rejected", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    const result = await t.mutation(internal.placeholderPipeline.registerExtractedImages, {
      jobId: JOB_A,
      userId: USER_A.subject,
      entries: [
        { index: 0, name: "front.jpg", accepted: true },
        { index: 1, name: "back.jpg", accepted: true },
        { index: 2, name: "notes.txt", accepted: false },
      ],
    });

    expect(result).toEqual({ totalImages: 2, rejectedEntries: 1 });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("processing");
    expect(job?.totalImages).toBe(2);
    expect(job?.rejectedEntries).toBe(1);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);

    const images = await t.run(async (ctx) => ctx.db.query("placeholderImages").collect());
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.index).sort()).toEqual([0, 1]);
    expect(images.every((i) => i.status === "queued")).toBe(true);
    expect(images.every((i) => i.userId === USER_A.subject)).toBe(true);
    expect(images.every((i) => i.workId === undefined)).toBe(true);
  });

  test("zero accepted entries goes straight to pairing, not stuck in processing", async () => {
    // Nothing to enqueue means no onComplete ever fires, so the last-one-done
    // transition can never run. Without this branch the job would spin forever.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "extracting" });

    await t.mutation(internal.placeholderPipeline.registerExtractedImages, {
      jobId: JOB_A,
      userId: USER_A.subject,
      entries: [{ index: 0, name: "readme.txt", accepted: false }],
    });

    const job = await getJob(t, JOB_A);
    expect(job?.status).toBe("pairing");
    expect(job?.totalImages).toBe(0);
    expect(job?.rejectedEntries).toBe(1);
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
    expect(image?.player).toBe("Ken Griffey Jr.");
    expect(image?.team).toBe("Seattle Mariners");
    expect(image?.cardNumber).toBe("24");
    expect(image?.side).toBe("back");
    expect(image?.rotationDegrees).toBe(90);
    expect(image?.orientConfidence).toBeCloseTo(0.87);
    expect(image?.textCount).toBe(42);
    expect(image?.croppedSource).toBe("tiered");
    expect(image?.dhash).toBe("0f1e2d3c4b5a6978");

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
    expect(image?.player).toBe("Ken Griffey Jr.");
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
    // Restarting a failed job deletes its images while the old work may still
    // be draining. Throwing here would make the pool retry forever.
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
        createdAt: 1,
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
    expect(mine.map((i) => i.index)).toEqual([0, 1]);
    // `workId` is a workpool handle, not client data.
    expect(mine[0]).not.toHaveProperty("workId");

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
  test("returns only done rows, in zip order", async () => {
    // Order is part of the algorithm's input, not a display preference: the
    // adjacency pre-pass assumes a sheet's front and back are neighbours.
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "pairing", totalImages: 4 });
    await seedImage(t, JOB_A, 2, USER_A.subject, "done");
    await seedImage(t, JOB_A, 0, USER_A.subject, "done");
    await seedImage(t, JOB_A, 1, USER_A.subject, "failed");
    await seedImage(t, JOB_A, 3, USER_A.subject, "done");

    const rows = await t.query(internal.placeholderPipeline.listDoneImagesForPairing, {
      jobId: JOB_A,
    });

    expect(rows.map((r) => r.index)).toEqual([0, 2, 3]);
  });
});
