/**
 * NEO-411: every photo ends. A heavy photo with no answer within
 * HEAVY_PHOTO_DEADLINE_MS of its heavy work starting is marked failed
 * ("PHOTO_TIMED_OUT") instead of staying in "Working on your photos." for the
 * length of the retry ladder, and the collector can send a failed photo through
 * again with Try again.
 *
 * Same seams as the other placeholder tests: convex-test cannot mount the
 * workpool components, so the fast pool is replaced with a recorder (as in
 * placeholderStream.test.ts) and the heavy pool's `cancel` is spied on the real
 * instance (as in placeholderHeavyPool.test.ts).
 *
 * Filename note: lives at the `convex/` root so convex-test's module registry
 * resolves function paths (see convex/adapters.placeholderUploads.test.ts).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  HEAVY_PHOTO_DEADLINE_MS,
  expireHeavyPhotoImpl,
  recordImageOutcomeImpl,
} from "./placeholderPipeline";
import { heavyPreprocessPool } from "./placeholderHeavyPool";
import { PLACEHOLDER_MAX_IMAGE_RETRIES } from "./placeholderStream";
import { networkCauseOf } from "./adapters/preprocess";

const { enqueueCalls } = vi.hoisted(() => ({
  enqueueCalls: [] as Array<{ args: unknown; opts: unknown }>,
}));

vi.mock("./placeholderPool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./placeholderPool")>();
  return {
    ...actual,
    fastPreprocessPool: {
      enqueueAction: async (_ctx: unknown, _fn: unknown, args: unknown, opts: unknown) => {
        enqueueCalls.push({ args, opts });
        return `fast-work-${enqueueCalls.length}`;
      },
      cancel: async () => {},
    },
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = { subject: "user_deadlineAAAA1111" };
const OTHER = { subject: "user_deadlineBBBB2222" };
const JOB = "job-deadline-1";

beforeEach(() => {
  enqueueCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function seedJob(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<Pick<Doc<"placeholderJobs">, "status" | "totalImages" | "processedImages" | "failedImages">> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: USER.subject,
      objectPath: `placeholders/${USER.subject}/${JOB}/`,
      createdAt: 1_700_000_000_000,
      mode: "stream",
      status: overrides.status ?? "collecting",
      totalImages: overrides.totalImages ?? 2,
      processedImages: overrides.processedImages ?? 0,
      failedImages: overrides.failedImages ?? 0,
    });
  });
}

async function seedImage(
  t: ReturnType<typeof convexTest>,
  entryIndex: number,
  fields: Partial<Doc<"placeholderImages">>,
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId: JOB,
      userId: USER.subject,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status: "processing",
      ...fields,
    }),
  );
}

const getImage = (t: ReturnType<typeof convexTest>, id: Id<"placeholderImages">) =>
  t.run(async (ctx) => ctx.db.get(id));

const getJob = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("placeholderJobs").collect()).find((j) => j.jobId === JOB) ?? null,
  );

describe("noteHeavyStart", () => {
  test("stamps the first attempt once and schedules the deadline once", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const id = await seedImage(t, 0, { escalated: true, workId: "heavy-work-1" });

    await t.mutation(internal.placeholderPipeline.noteHeavyStart, { jobId: JOB, entryIndex: 0 });
    const first = (await getImage(t, id))!.heavyStartedAt;
    expect(first).toBeTypeOf("number");

    // A retry of the same photo starts again; the deadline still counts from the first.
    await t.mutation(internal.placeholderPipeline.noteHeavyStart, { jobId: JOB, entryIndex: 0 });
    expect((await getImage(t, id))!.heavyStartedAt).toBe(first);

    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const deadlines = scheduled.filter((s) => s.name.includes("expireHeavyPhoto"));
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].args[0]).toEqual({ imageId: id });
    expect(deadlines[0].scheduledTime - first!).toBeGreaterThanOrEqual(HEAVY_PHOTO_DEADLINE_MS - 1_000);
  });

  test("leaves a fast-tier or settled row alone", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const fast = await seedImage(t, 0, {});
    const done = await seedImage(t, 1, { escalated: true, status: "done" });

    await t.mutation(internal.placeholderPipeline.noteHeavyStart, { jobId: JOB, entryIndex: 0 });
    await t.mutation(internal.placeholderPipeline.noteHeavyStart, { jobId: JOB, entryIndex: 1 });

    expect((await getImage(t, fast))!.heavyStartedAt).toBeUndefined();
    expect((await getImage(t, done))!.heavyStartedAt).toBeUndefined();
  });
});

describe("the photo deadline", () => {
  test("a heavy photo still working at its deadline ends failed, counted, with PHOTO_TIMED_OUT", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const id = await seedImage(t, 0, { escalated: true, workId: "heavy-work-1", heavyStartedAt: 1 });

    const result = await t.run(async (ctx) => expireHeavyPhotoImpl(ctx, id));

    expect(result).toEqual({ expired: true, workId: "heavy-work-1" });
    const image = (await getImage(t, id))!;
    expect(image.status).toBe("failed");
    expect(image.errorCode).toBe("PHOTO_TIMED_OUT");
    expect(image.settledAt).toBeTypeOf("number");
    expect((await getJob(t))!.failedImages).toBe(1);
  });

  test("a photo that finished in time is untouched", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { processedImages: 1 });
    const id = await seedImage(t, 0, { escalated: true, status: "done", cardNumber: "174" });

    const result = await t.run(async (ctx) => expireHeavyPhotoImpl(ctx, id));

    expect(result).toEqual({ expired: false, workId: null });
    expect((await getImage(t, id))!.status).toBe("done");
    expect((await getJob(t))!.failedImages).toBe(0);
  });

  test("a heavy answer landing after the deadline changes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const id = await seedImage(t, 0, { escalated: true, workId: "heavy-work-1" });
    await t.run(async (ctx) => expireHeavyPhotoImpl(ctx, id));

    await t.run(async (ctx) =>
      recordImageOutcomeImpl(
        ctx,
        { jobId: JOB, imageId: id },
        { kind: "success", returnValue: { needs_escalation: false, card_number: "174" } },
        "heavy",
      ),
    );

    const image = (await getImage(t, id))!;
    expect(image.status).toBe("failed");
    expect(image.cardNumber).toBeUndefined();
    const job = (await getJob(t))!;
    expect(job.failedImages).toBe(1);
    expect(job.processedImages).toBe(0);
  });

  test("the scheduled deadline cancels the photo's heavy work item", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const id = await seedImage(t, 0, { escalated: true, workId: "heavy-work-7" });
    const cancel = vi.spyOn(heavyPreprocessPool, "cancel").mockResolvedValue(undefined);

    const out = await t.mutation(internal.placeholderHeavyPool.expireHeavyPhoto, { imageId: id });

    expect(out).toEqual({ expired: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][1]).toBe("heavy-work-7");
  });

  test("the deadline on a photo already read cancels nothing", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    const id = await seedImage(t, 0, { escalated: true, status: "done", workId: "heavy-work-8" });
    const cancel = vi.spyOn(heavyPreprocessPool, "cancel").mockResolvedValue(undefined);

    expect(await t.mutation(internal.placeholderHeavyPool.expireHeavyPhoto, { imageId: id })).toEqual({
      expired: false,
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("retryPlaceholderImage (Try again)", () => {
  const retry = (t: ReturnType<typeof convexTest>, entryIndex = 0, who = USER) =>
    t.withIdentity(who).mutation(api.placeholderStream.retryPlaceholderImage, { jobId: JOB, entryIndex });

  test("sends a failed photo through again as a fresh fast-tier photo", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { failedImages: 1 });
    const id = await seedImage(t, 0, {
      status: "failed",
      escalated: true,
      errorCode: "PHOTO_TIMED_OUT",
      errorDetail: "no answer",
      heavyStartedAt: 1,
      settledAt: 2,
      pairStatus: "unmatched",
    });

    expect(await retry(t)).toEqual({ retried: true });

    const image = (await getImage(t, id))!;
    expect(image.status).toBe("processing");
    expect(image.retries).toBe(1);
    expect(image.workId).toBe("fast-work-1");
    expect(image.escalated).toBeUndefined();
    expect(image.errorCode).toBeUndefined();
    expect(image.heavyStartedAt).toBeUndefined();
    expect(image.settledAt).toBeUndefined();
    expect(image.pairStatus).toBeUndefined();
    const job = (await getJob(t))!;
    expect(job.failedImages).toBe(0);
    expect(job.totalImages).toBe(2);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].args).toEqual({ jobId: JOB, userId: USER.subject, entryIndex: 0 });
  });

  test("a photo that is not failed is not sent again", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t);
    await seedImage(t, 0, { status: "done" });

    expect(await retry(t)).toEqual({ retried: false, reason: "not failed" });
    expect(enqueueCalls).toHaveLength(0);
  });

  test(`stops after ${PLACEHOLDER_MAX_IMAGE_RETRIES} tries`, async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { failedImages: 1 });
    await seedImage(t, 0, { status: "failed", retries: PLACEHOLDER_MAX_IMAGE_RETRIES });

    expect(await retry(t)).toEqual({ retried: false, reason: "too many tries" });
    expect(enqueueCalls).toHaveLength(0);
    expect((await getJob(t))!.failedImages).toBe(1);
  });

  test("only on an open batch, and only the owner's", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, { status: "processing", failedImages: 1 });
    await seedImage(t, 0, { status: "failed" });

    await expect(retry(t)).rejects.toThrow();

    const t2 = convexTest(schema, modules);
    await seedJob(t2, { failedImages: 1 });
    await seedImage(t2, 0, { status: "failed" });
    await expect(retry(t2, 0, OTHER)).rejects.toThrow();
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("networkCauseOf (the 300 s cut names itself)", () => {
  test("reads undici's cause code off a failed fetch", () => {
    const err = new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    expect(networkCauseOf(err)).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  test("is undefined when there is no code", () => {
    expect(networkCauseOf(new Error("boom"))).toBeUndefined();
    expect(networkCauseOf("boom")).toBeUndefined();
    expect(networkCauseOf(null)).toBeUndefined();
  });
});
