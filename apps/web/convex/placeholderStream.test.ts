/**
 * Unit tests for streaming intake — the scanner path (NEO-170).
 *
 * The mechanics that are genuinely new here are three: an allocation counter
 * that must be transactional, a confirmation step that must be idempotent, and
 * a close that must route the job to whoever finishes it. Everything else is
 * the zip pipeline, already covered by convex/placeholderPipeline.test.ts, so
 * this file leans on that rather than re-testing it.
 *
 * **The workpool is mocked here, and only here.** convex-test cannot register
 * the workpool's nested batch-worker component, so a real
 * `fastPreprocessPool.enqueueAction` throws — which is why the zip tests carefully
 * avoid every path that reaches it. That avoidance is not affordable for
 * `confirmPlaceholderImageUpload`: enqueuing IS what confirming does, and the
 * property most worth pinning (a double confirm must not enqueue twice or count
 * twice) is unobservable without seeing the enqueue. So the pool module is
 * replaced with a recorder, spread over the real module so `onImageComplete`
 * stays a registered function. The mock is file-scoped, so no other test file's
 * view of the pool changes.
 *
 * Scheduled functions are drained with `finishAllScheduledFunctions(vi.runAllTimers)`
 * under fake timers, following convex/backfillCardFeatures.test.ts — close
 * schedules the terminal pairing run and the abandoned-row sweep, and both are
 * part of what close means.
 *
 * Filename note: lives at the `convex/` root for the reason given on
 * convex/adapters.placeholderUploads.test.ts — convex-test's module registry
 * only resolves function paths for test files at that level.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { PLACEHOLDER_STREAM_IDLE_MS } from "./placeholderPipeline";
import { PLACEHOLDER_MAX_ENTRY_INDEX } from "./lib/placeholderObjects";

/**
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above every `const` in the
 * module — a plain top-level array would be in its temporal dead zone.
 */
const { enqueueCalls } = vi.hoisted(() => ({
  enqueueCalls: [] as Array<{ args: unknown; opts: unknown }>,
}));

vi.mock("./placeholderPool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./placeholderPool")>();
  return {
    ...actual,
    fastPreprocessPool: {
      enqueueAction: async (
        _ctx: unknown,
        _fn: unknown,
        args: unknown,
        opts: unknown,
      ) => {
        enqueueCalls.push({ args, opts });
        return `work-${enqueueCalls.length}`;
      },
      cancel: async () => {},
    },
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_streamAAAA1111" };
const USER_B = { subject: "user_streamBBBB2222" };

beforeEach(() => {
  enqueueCalls.length = 0;
  vi.useFakeTimers();
  // NEO-188: closing/cancelling a stream fires the preprocess /warmup ping.
  // Unstubbed, that was a real request to localhost:8081 from every run — a
  // no-op on a clean machine, but live traffic to whatever answers that port
  // on a developer's box. Stub it; adapters.preprocess.test.ts is where the
  // warmup contract itself is asserted.
  vi.stubGlobal(
    "fetch",
    (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a stream and return its jobId, failing loudly if the cap refused it. */
async function openStream(
  t: ReturnType<typeof convexTest>,
  identity = USER_A,
): Promise<string> {
  const result = await t
    .withIdentity(identity)
    .mutation(api.placeholderStream.startPlaceholderStream, {});
  expect(result.started).toBe(true);
  return result.jobId!;
}

/** Seed a job directly — used for the states a public mutation cannot produce. */
async function seedJob(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  overrides: Partial<{
    userId: string;
    mode: "zip" | "stream";
    status: string;
    totalImages: number;
    processedImages: number;
    failedImages: number;
    lastActivityAt: number;
    nextEntryIndex: number;
  }> = {},
) {
  const userId = overrides.userId ?? USER_A.subject;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: `placeholders/${userId}/${jobId}/`,
      createdAt: 1_700_000_000_000,
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      status: (overrides.status ?? "collecting") as Doc<"placeholderJobs">["status"],
      totalImages: overrides.totalImages ?? 0,
      processedImages: overrides.processedImages ?? 0,
      failedImages: overrides.failedImages ?? 0,
      ...(overrides.lastActivityAt !== undefined
        ? { lastActivityAt: overrides.lastActivityAt }
        : {}),
      ...(overrides.nextEntryIndex !== undefined
        ? { nextEntryIndex: overrides.nextEntryIndex }
        : {}),
    });
  });
}

async function getJob(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.query("placeholderJobs").collect();
    return jobs.find((j) => j.jobId === jobId) ?? null;
  });
}

async function getImages(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderImages").collect();
    return rows
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => a.entryIndex - b.entryIndex);
  });
}

/** Claim one entry index, as `createPlaceholderImageUploadUrl` would. */
async function allocate(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  originalName?: string,
  userId = USER_A.subject,
): Promise<number> {
  const { entryIndex } = await t.mutation(
    internal.placeholderStream.allocateStreamEntry,
    { jobId, userId, ...(originalName !== undefined ? { originalName } : {}) },
  );
  return entryIndex;
}

/** Seed an image row directly, for states allocation cannot reach. */
async function seedImage(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  status: "awaiting_upload" | "queued" | "processing" | "done" | "failed",
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

/**
 * Run the abandoned-row sweep to completion, replaying the chunk cursor the
 * production code carries through `ctx.scheduler`.
 */
async function sweepAwaitingUploads(t: ReturnType<typeof convexTest>, jobId: string) {
  let from = 0;
  for (;;) {
    const result = await t.mutation(internal.placeholderStream.sweepAwaitingUploads, {
      jobId,
      from,
    });
    if (result.done) return;
    // From the mutation's own cursor, never recomputed from the surviving rows:
    // the rows this chunk deleted are gone, so the highest remaining index is
    // past the ones it deliberately kept.
    from = result.nextFrom!;
  }
}

// ---------------------------------------------------------------------------
// startPlaceholderStream
// ---------------------------------------------------------------------------

describe("startPlaceholderStream", () => {
  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.placeholderStream.startPlaceholderStream, {}),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("opens a collecting stream job owned by the caller, with counters zeroed", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    // A UUID, because the preprocess service refuses anything else
    // (JOB_ID_PATTERN in app/jobs/layout.py) — and because an unguessable id is
    // what the whole ownership model rests on.
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const job = await getJob(t, jobId);
    expect(job?.userId).toBe(USER_A.subject);
    expect(job?.mode).toBe("stream");
    expect(job?.status).toBe("collecting");
    expect(job?.totalImages).toBe(0);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
    expect(job?.nextEntryIndex).toBe(0);
    expect(job?.lastActivityAt).toBeGreaterThan(0);
    expect(job?.startedAt).toBeGreaterThan(0);
    // The job PREFIX, not an input.zip that will never exist.
    expect(job?.objectPath).toBe(`placeholders/${USER_A.subject}/${jobId}/`);
    // No source hint when none was passed — absent stays absent.
    expect(job?.source).toBeUndefined();
  });

  test("stores the source hint when the client passes one", async () => {
    // The scanner CLI passes "scanner"; it is a display hint, stored verbatim.
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, { source: "scanner" });
    expect(result.started).toBe(true);

    expect((await getJob(t, result.jobId!))?.source).toBe("scanner");
  });

  test("the active-batch cap counts BOTH modes", async () => {
    // A user must not get four batches in flight by alternating between an
    // upload and a scan — which is what a mode-specific cap would allow.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-zip-active", { mode: "zip", status: "processing" });
    await seedJob(t, "job-stream-active", { mode: "stream", status: "collecting" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, {});

    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/active batches/i);
    expect(result.jobId).toBeUndefined();
  });

  test("a collecting stream job blocks a zip batch from starting too", async () => {
    // The other direction of the same cap.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-stream-1", { mode: "stream", status: "collecting" });
    await seedJob(t, "job-stream-2", { mode: "stream", status: "collecting" });
    await seedJob(t, "job-zip", { mode: "zip", status: "uploaded" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-zip" });

    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/active batches/i);
  });

  test("another user's collecting jobs do not count against you", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-b-1", { userId: USER_B.subject, mode: "stream", status: "collecting" });
    await seedJob(t, "job-b-2", { userId: USER_B.subject, mode: "stream", status: "collecting" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    expect(result.started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allocateStreamEntry
// ---------------------------------------------------------------------------

describe("allocateStreamEntry", () => {
  test("hands out consecutive indexes and creates an awaiting_upload row for each", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    expect(await allocate(t, jobId, "front.jpg")).toBe(0);
    expect(await allocate(t, jobId, "back.jpg")).toBe(1);
    expect(await allocate(t, jobId, "next.jpg")).toBe(2);

    const images = await getImages(t, jobId);
    expect(images.map((i) => i.entryIndex)).toEqual([0, 1, 2]);
    expect(images.every((i) => i.status === "awaiting_upload")).toBe(true);
    expect(images.every((i) => i.userId === USER_A.subject)).toBe(true);
    expect(images.map((i) => i.originalName)).toEqual(["front.jpg", "back.jpg", "next.jpg"]);
    // No workId: an allocation is a capability to upload, not work to do.
    expect(images.every((i) => i.workId === undefined)).toBe(true);

    const job = await getJob(t, jobId);
    expect(job?.nextEntryIndex).toBe(3);
    // Allocating is not confirming — nothing has arrived yet.
    expect(job?.totalImages).toBe(0);
  });

  test("falls back to a synthetic name, and caps a long one", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    await allocate(t, jobId);
    await allocate(t, jobId, "x".repeat(5000));

    const images = await getImages(t, jobId);
    expect(images[0].originalName).toBe("scan-0");
    expect(images[1].originalName).toHaveLength(200);
  });

  test("allows the service's highest index and refuses the one past it", async () => {
    // `entry_index` is bounded `le=MAX_ZIP_ENTRIES` on the service's
    // ProcessEntryRequest, so 1000 is legal and 1001 is a 422 the user could
    // never act on. Refusing here turns it into "this batch is full".
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await t.run(async (ctx) => {
      const jobs = await ctx.db.query("placeholderJobs").collect();
      await ctx.db.patch(jobs[0]._id, { nextEntryIndex: PLACEHOLDER_MAX_ENTRY_INDEX });
    });

    expect(await allocate(t, jobId)).toBe(PLACEHOLDER_MAX_ENTRY_INDEX);
    await expect(allocate(t, jobId)).rejects.toThrow(/full/i);

    // The refusal must not have consumed anything.
    expect(await getImages(t, jobId)).toHaveLength(1);
  });

  test("refuses a job the caller does not own, indistinguishably from a missing one", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    await expect(allocate(t, jobId, "x.jpg", USER_B.subject)).rejects.toThrow(
      /job not found/i,
    );
    await expect(allocate(t, "job-nope", "x.jpg", USER_B.subject)).rejects.toThrow(
      /job not found/i,
    );
    expect(await getImages(t, jobId)).toHaveLength(0);
  });

  test("refuses a zip job", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-zip", { mode: "zip", status: "processing" });
    await expect(allocate(t, "job-zip")).rejects.toThrow(/not a scanner batch/i);
  });

  test.each(["processing", "pairing", "succeeded", "failed"] as const)(
    "refuses a stream job that is %s rather than collecting",
    async (status) => {
      const t = convexTest(schema, modules);
      await seedJob(t, "job-closed", { mode: "stream", status });
      await expect(allocate(t, "job-closed")).rejects.toThrow(/not collecting/i);
      expect(await getImages(t, "job-closed")).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// confirmPlaceholderImageUpload
// ---------------------------------------------------------------------------

describe("confirmPlaceholderImageUpload", () => {
  async function confirm(
    t: ReturnType<typeof convexTest>,
    jobId: string,
    entryIndex: number,
    identity = USER_A,
  ) {
    return t
      .withIdentity(identity)
      .mutation(api.placeholderStream.confirmPlaceholderImageUpload, {
        jobId,
        entryIndex,
      });
  }

  test("counts the image, enqueues it, and marks activity", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId, "front.jpg");

    const result = await confirm(t, jobId, 0);

    expect(result).toEqual({ confirmed: true, alreadyConfirmed: false, totalImages: 1 });

    const image = (await getImages(t, jobId))[0];
    expect(image.status).toBe("processing");
    expect(image.workId).toBe("work-1");

    const job = await getJob(t, jobId);
    expect(job?.totalImages).toBe(1);
    // Still collecting — confirming an image does not close the session.
    expect(job?.status).toBe("collecting");

    // Enqueued exactly as the zip path does: same worker args, same onComplete
    // context, so a stream image is indistinguishable from a zip image
    // downstream.
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].args).toEqual({
      jobId,
      userId: USER_A.subject,
      entryIndex: 0,
    });
    expect(enqueueCalls[0].opts).toMatchObject({
      context: { jobId, imageId: image._id },
    });
  });

  test("a repeated confirm neither double-counts nor double-enqueues", async () => {
    // A retrying client, a double-clicked button, or a lost response all produce
    // this. Double-counting would put `processed + failed === total`
    // permanently out of reach; double-enqueuing would pay twice for one image.
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);

    const first = await confirm(t, jobId, 0);
    const second = await confirm(t, jobId, 0);
    const third = await confirm(t, jobId, 0);

    expect(first.alreadyConfirmed).toBe(false);
    expect(second).toEqual({ confirmed: true, alreadyConfirmed: true, totalImages: 1 });
    expect(third.alreadyConfirmed).toBe(true);

    expect((await getJob(t, jobId))?.totalImages).toBe(1);
    expect(enqueueCalls).toHaveLength(1);
  });

  test("totalImages counts confirmed images only", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);
    await allocate(t, jobId);
    await allocate(t, jobId);

    await confirm(t, jobId, 1);

    expect((await getJob(t, jobId))?.totalImages).toBe(1);
    expect(enqueueCalls).toHaveLength(1);
    const images = await getImages(t, jobId);
    expect(images.map((i) => i.status)).toEqual([
      "awaiting_upload",
      "processing",
      "awaiting_upload",
    ]);
  });

  test("throws for a job the caller does not own, and for one that does not exist", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);

    await expect(confirm(t, jobId, 0, USER_B)).rejects.toThrow(/job not found/i);
    await expect(confirm(t, "job-nope", 0, USER_B)).rejects.toThrow(/job not found/i);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);
    await expect(
      t.mutation(api.placeholderStream.confirmPlaceholderImageUpload, {
        jobId,
        entryIndex: 0,
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("throws for an index that was never allocated", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await expect(confirm(t, jobId, 7)).rejects.toThrow(/image not found/i);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("throws once the job has stopped collecting", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-closed", { mode: "stream", status: "processing" });
    await seedImage(t, "job-closed", 0, "awaiting_upload");
    await expect(confirm(t, "job-closed", 0)).rejects.toThrow(/not collecting/i);
    expect(enqueueCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// closePlaceholderStream
// ---------------------------------------------------------------------------

describe("closePlaceholderStream", () => {
  async function close(
    t: ReturnType<typeof convexTest>,
    jobId: string,
    identity = USER_A,
  ) {
    return t
      .withIdentity(identity)
      .mutation(api.placeholderStream.closePlaceholderStream, { jobId });
  }

  test("with work still draining, hands the job to the existing last-one-done trigger", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);
    await allocate(t, jobId);
    await t.withIdentity(USER_A).mutation(
      api.placeholderStream.confirmPlaceholderImageUpload,
      { jobId, entryIndex: 0 },
    );
    await t.withIdentity(USER_A).mutation(
      api.placeholderStream.confirmPlaceholderImageUpload,
      { jobId, entryIndex: 1 },
    );

    const result = await close(t, jobId);

    expect(result).toEqual({ closed: true, status: "processing" });
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("processing");
    expect(job?.totalImages).toBe(2);
    // NOT terminal — the images are still in the pool, and the completion that
    // observes the last of them is what ends the batch.
    expect(job?.finishedAt).toBeUndefined();
  });

  test("with nothing left to drain, finalizes the batch INLINE in the close mutation", async () => {
    // Every image finished while the user was still scanning. A SMALL closed
    // batch is finalized in the close mutation's OWN transaction (NEO-175), so
    // the terminal status, the pairs, the resolver count, and the image
    // pairStatus are all present the INSTANT close returns — no scheduler hop.
    // The absence of a `finishAllScheduledFunctions` call before these
    // assertions is precisely the proof the finalize is synchronous.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-drained", {
      mode: "stream",
      status: "collecting",
      totalImages: 2,
      processedImages: 2,
    });
    await seedImage(t, "job-drained", 0, "done", {
      side: "front",
      textCount: 1,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
    });
    await seedImage(t, "job-drained", 1, "done", {
      side: "back",
      textCount: 40,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "24",
    });

    const result = await close(t, "job-drained");
    // Terminal INLINE — "succeeded", not the old "pairing" hand-off.
    expect(result).toEqual({ closed: true, status: "succeeded" });

    // No tick between here and the close: everything below is already true.
    const job = await getJob(t, "job-drained");
    expect(job?.status).toBe("succeeded");
    expect(job?.finishedAt).toBeGreaterThan(0);
    // Identity-first resolves one call per done image; 0 would store as absent.
    expect(job?.resolverCalls).toBe(2);

    const pairs = await t.run(async (ctx) => ctx.db.query("placeholderPairs").collect());
    expect(pairs).toHaveLength(1);
    // Merged identity: front-preferred player/team, back-only card number.
    expect(pairs[0]).toMatchObject({
      frontIndex: 0,
      backIndex: 1,
      player: "Ken Griffey Jr.",
      team: "Seattle Mariners",
      cardNumber: "24",
    });

    // Both images stamped paired, inline.
    const images = await getImages(t, "job-drained");
    expect(images.map((i) => i.pairStatus)).toEqual(["paired", "paired"]);
  });

  test("a small all-failed batch fails INLINE through the too-many-failures rule", async () => {
    // `failedImages * 2 > totalImages` (2 of 3) is a failed batch. Small, so it
    // is decided in the close mutation with no scheduler tick.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-mostly-failed", {
      mode: "stream",
      status: "collecting",
      totalImages: 3,
      processedImages: 1,
      failedImages: 2,
    });
    await seedImage(t, "job-mostly-failed", 0, "done", {
      side: "front",
      textCount: 1,
    });
    await seedImage(t, "job-mostly-failed", 1, "failed");
    await seedImage(t, "job-mostly-failed", 2, "failed");

    const result = await close(t, "job-mostly-failed");
    expect(result).toEqual({ closed: true, status: "failed" });

    // No tick — the terminal failure is already stamped.
    const job = await getJob(t, "job-mostly-failed");
    expect(job?.status).toBe("failed");
    expect(job?.finishedAt).toBeGreaterThan(0);
    expect(job?.errorCode).toBe("TOO_MANY_IMAGE_FAILURES");
    expect(job?.errorDetail).toBe("2 of 3 images failed to process");
  });

  test("closing an empty session fails it INLINE through the zero-images rule", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    const result = await close(t, jobId);
    // Failed INLINE (totalImages 0), not the old "pairing" hand-off.
    expect(result).toEqual({ closed: true, status: "failed" });

    // No tick: the terminal failure is set inside the close mutation.
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("TOO_MANY_IMAGE_FAILURES");
    // Scanner wording, not zip wording: this user never chose a file to upload.
    expect(job?.errorDetail).toMatch(/no images were uploaded/i);
  });

  test("deletes abandoned allocations and keeps every confirmed image", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);
    await allocate(t, jobId);
    await allocate(t, jobId);
    await t.withIdentity(USER_A).mutation(
      api.placeholderStream.confirmPlaceholderImageUpload,
      { jobId, entryIndex: 1 },
    );

    await close(t, jobId);
    // Drained rather than invoked by hand, so the SCHEDULED call is what runs —
    // a sweep scheduled with the wrong arguments would fail silently here and
    // leave the rows behind, which is exactly what this asserts against.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const images = await getImages(t, jobId);
    expect(images.map((i) => i.entryIndex)).toEqual([1]);
    expect(images[0].status).toBe("processing");
    // The counter is untouched by the sweep — the deleted rows were never in it.
    expect((await getJob(t, jobId))?.totalImages).toBe(1);
  });

  test("the sweep chunks past a full page of abandoned allocations", async () => {
    // ENQUEUE_CHUNK_SIZE is 50, so 60 rows proves the cursor advances rather
    // than re-reading the same page. Without the cursor this loops forever.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-many", { mode: "stream", status: "processing" });
    for (let i = 0; i < 60; i++) {
      await seedImage(t, "job-many", i, i === 55 ? "done" : "awaiting_upload");
    }

    await sweepAwaitingUploads(t, "job-many");

    const images = await getImages(t, "job-many");
    expect(images.map((i) => i.entryIndex)).toEqual([55]);
  });

  test("refuses a second close, without throwing", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    // First close of this empty session finalizes it INLINE to "failed"
    // (zero-images rule), so it is no longer collecting.
    await close(t, jobId);

    const second = await close(t, jobId);
    expect(second.closed).toBe(false);
    expect(second.reason).toMatch(/already failed/i);
  });

  test("a LARGE all-done batch keeps the scheduled action path", async () => {
    // Above INLINE_FINALIZE_MAX_IMAGES a single mutation cannot safely read and
    // rewrite the whole batch, so close stays "pairing" and hands off to the
    // chunked `runPairing` action exactly as before. Only the counters gate the
    // branch, so this proves the fallback without seeding 101 image rows.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-huge", {
      mode: "stream",
      status: "collecting",
      totalImages: 101,
      processedImages: 101,
    });

    const result = await close(t, "job-huge");
    expect(result).toEqual({ closed: true, status: "pairing" });

    // Not terminal in the close mutation — a runPairing action is scheduled to
    // finish it. It stays "pairing" until that scheduled work runs.
    const job = await getJob(t, "job-huge");
    expect(job?.status).toBe("pairing");
    expect(job?.finishedAt).toBeUndefined();

    // The final runPairing IS scheduled (its absence would leave the job wedged
    // in "pairing" forever). Draining it drives the batch to its terminal status.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getJob(t, "job-huge"))?.status).toBe("succeeded");
  });

  test("refuses a zip job, and a job the caller does not own", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-zip", { mode: "zip", status: "processing" });
    await expect(close(t, "job-zip")).rejects.toThrow(/not a scanner batch/i);

    const jobId = await openStream(t);
    await expect(close(t, jobId, USER_B)).rejects.toThrow(/job not found/i);
    await expect(close(t, "job-nope", USER_B)).rejects.toThrow(/job not found/i);
    expect((await getJob(t, jobId))?.status).toBe("collecting");
  });

  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await expect(
      t.mutation(api.placeholderStream.closePlaceholderStream, { jobId }),
    ).rejects.toThrow(/not authenticated/i);
  });
});

// ---------------------------------------------------------------------------
// cancel and start, from a stream job's point of view
// ---------------------------------------------------------------------------

describe("cancel and start against a stream job", () => {
  test("a collecting session can be canceled, and its abandoned rows go", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId);
    await allocate(t, jobId);

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId });

    expect(result.canceled).toBe(true);
    // Nothing was ever enqueued for an awaiting_upload row, so there is nothing
    // in the pool to cancel.
    expect(result.canceledCount).toBe(0);

    const job = await getJob(t, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("CANCELED");

    // Drained, not invoked by hand — cancel schedules this sweep, and a
    // scheduled call built with the wrong arguments would fail where nobody is
    // watching and quietly leave the rows behind.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await getImages(t, jobId)).toHaveLength(0);
  });

  test("cancel frees the active-job slot for a new scan", async () => {
    const t = convexTest(schema, modules);
    const first = await openStream(t);
    const second = await openStream(t);
    // Both slots are taken.
    expect(
      (await t.withIdentity(USER_A).mutation(api.placeholderStream.startPlaceholderStream, {}))
        .started,
    ).toBe(false);

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: second });

    const third = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    expect(third.started).toBe(true);
    expect(third.jobId).not.toBe(first);
  });

  test("startPlaceholderBatch refuses a stream job, including a failed one", async () => {
    // "failed" is a startable status, so this is the case the mode check
    // actually catches. Starting it would run `/extract` against an input.zip
    // that never existed.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-stream-failed", { mode: "stream", status: "failed" });

    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, {
        jobId: "job-stream-failed",
      });

    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/scanner batch/i);
    expect((await getJob(t, "job-stream-failed"))?.status).toBe("failed");
  });

  test("startPlaceholderBatch still starts an ordinary zip job", async () => {
    // Guards against the mode check being written as "anything with a mode".
    const t = convexTest(schema, modules);
    await seedJob(t, "job-zip", { mode: "zip", status: "uploaded" });
    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-zip" });
    expect(result.started).toBe(true);
  });

  test("startPlaceholderBatch still starts a job with no mode at all", async () => {
    // Rows predating streaming carry no `mode`, and absent means zip.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-legacy", { status: "uploaded" });
    const result = await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-legacy" });
    expect(result.started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The idle sweep
// ---------------------------------------------------------------------------

describe("sweepIdleStreams", () => {
  test("closes a collecting session that has gone quiet", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-idle", {
      mode: "stream",
      status: "collecting",
      totalImages: 1,
      processedImages: 1,
      lastActivityAt: Date.now() - PLACEHOLDER_STREAM_IDLE_MS - 1_000,
    });
    await seedImage(t, "job-idle", 0, "done", { side: "front", textCount: 1 });

    const result = await t.mutation(internal.placeholderStream.sweepIdleStreams, {});
    expect(result).toEqual({ closed: 1, done: true });

    // Nothing was left to drain and the batch is small, so the sweep's close
    // finalized it INLINE — the same close path a user's Finish button takes.
    // Terminal the instant the sweep returns, no scheduler tick needed.
    expect((await getJob(t, "job-idle"))?.status).toBe("succeeded");
  });

  test("leaves a session that is still being used alone", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-busy", {
      mode: "stream",
      status: "collecting",
      lastActivityAt: Date.now() - 1_000,
    });

    const result = await t.mutation(internal.placeholderStream.sweepIdleStreams, {});
    expect(result.closed).toBe(0);
    expect((await getJob(t, "job-busy"))?.status).toBe("collecting");
  });

  test("leaves jobs that are not collecting alone, however old", async () => {
    // The index is keyed on status first for exactly this reason: a long-
    // finished batch must never be re-touched by a sweep looking for idleness.
    const t = convexTest(schema, modules);
    const ancient = Date.now() - PLACEHOLDER_STREAM_IDLE_MS * 100;
    await seedJob(t, "job-old-processing", {
      mode: "stream",
      status: "processing",
      lastActivityAt: ancient,
    });
    await seedJob(t, "job-old-succeeded", {
      mode: "stream",
      status: "succeeded",
      lastActivityAt: ancient,
    });
    await seedJob(t, "job-old-zip", { mode: "zip", status: "processing" });

    const result = await t.mutation(internal.placeholderStream.sweepIdleStreams, {});
    expect(result.closed).toBe(0);
    expect((await getJob(t, "job-old-processing"))?.status).toBe("processing");
    expect((await getJob(t, "job-old-succeeded"))?.status).toBe("succeeded");
    expect((await getJob(t, "job-old-zip"))?.status).toBe("processing");
  });

  test("a swept session with work still draining becomes an ordinary batch", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-idle-busy", {
      mode: "stream",
      status: "collecting",
      totalImages: 2,
      processedImages: 1,
      lastActivityAt: Date.now() - PLACEHOLDER_STREAM_IDLE_MS - 1,
    });

    await t.mutation(internal.placeholderStream.sweepIdleStreams, {});

    const job = await getJob(t, "job-idle-busy");
    expect(job?.status).toBe("processing");
    expect(job?.finishedAt).toBeUndefined();
  });

  test("an image completing keeps a slow session alive", async () => {
    // A batch whose images each take minutes is not idle. Without this the sweep
    // would close a session that was working perfectly well.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-slow", {
      mode: "stream",
      status: "collecting",
      totalImages: 2,
      lastActivityAt: Date.now() - PLACEHOLDER_STREAM_IDLE_MS - 1,
    });
    const imageId = await seedImage(t, "job-slow", 0, "processing");

    await t.mutation(internal.placeholderPipeline.recordImageOutcome, {
      jobId: "job-slow",
      imageId,
      result: { kind: "success", returnValue: { side: "front", text_count: 1 } },
    });

    const job = await getJob(t, "job-slow");
    expect(job?.lastActivityAt).toBeGreaterThan(Date.now() - PLACEHOLDER_STREAM_IDLE_MS);

    const result = await t.mutation(internal.placeholderStream.sweepIdleStreams, {});
    expect(result.closed).toBe(0);
    expect((await getJob(t, "job-slow"))?.status).toBe("collecting");
  });
});

// ---------------------------------------------------------------------------
// getPlaceholderJob, from a stream job's point of view
// ---------------------------------------------------------------------------

describe("getPlaceholderJob exposes the streaming fields", () => {
  test("returns mode and lastActivityAt to the owner, and nothing to anyone else", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    const mine = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId });
    expect(mine?.mode).toBe("stream");
    expect(mine?.status).toBe("collecting");
    expect(mine?.lastActivityAt).toBeGreaterThan(0);
    expect(mine).not.toHaveProperty("objectPath");

    await expect(
      t.withIdentity(USER_B).query(api.placeholderPipeline.getPlaceholderJob, { jobId }),
    ).resolves.toBeNull();
  });

  test("listPlaceholderImages surfaces awaiting_upload rows to the owner", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await allocate(t, jobId, "front.jpg");

    const images = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderImages, { jobId });
    expect(images).toHaveLength(1);
    expect(images[0].status).toBe("awaiting_upload");
    expect(images[0].originalName).toBe("front.jpg");
  });
});
