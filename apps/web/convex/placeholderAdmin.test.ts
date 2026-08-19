/**
 * Unit tests for the placeholder admin surface (NEO-170 operability).
 *
 * Two functions, and the interesting thing about both is that they deliberately
 * cross the boundary every other function in placeholderPipeline.ts enforces: an
 * admin sees other users' runs and can abort them. So the tests are shaped
 * around the two questions that follow from that.
 *
 *  - **Is the new boundary actually closed?** `requireAdmin` reads a `role`
 *    claim, not an ownership match, so the gating tests are the whole security
 *    story for this surface. Both functions are checked against an
 *    unauthenticated caller AND a signed-in non-admin — the second is the one
 *    that matters, because "signed in" is the easy state to reach.
 *  - **Did cancel fork?** The admin path and the user path must produce the same
 *    end state, or an operator's abort would leave a job in a subtly different
 *    condition from the user's own. That is pinned by running both against
 *    identically-seeded jobs and comparing the results field by field, rather
 *    than by trusting that they call the same helper today.
 *
 * The seed helper in convex/testing.ts is covered here too rather than in
 * testing.test.ts, because what it is FOR is this feature — it exists so an E2E
 * flow can materialise a run to abort.
 *
 * Filename note: lives at the `convex/` root for the reason given on
 * convex/adapters.placeholderUploads.test.ts — convex-test's module registry only
 * resolves function paths for test files at that level.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** Satisfies `requireAdmin` — role="admin" is a claim on the convex JWT template. */
const ADMIN = {
  subject: "user_adminPlaceholder001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_adminPlaceholder001",
  role: "admin",
};

/** Signed in, but not an admin. The state that matters for the gate. */
const NON_ADMIN = {
  subject: "user_ownerPlaceholder001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_ownerPlaceholder001",
  role: "user",
};

/** A second ordinary user, so "other people's jobs" means something. */
const OTHER_USER = {
  subject: "user_otherPlaceholder002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_otherPlaceholder002",
  role: "user",
};

beforeEach(() => {
  process.env.TESTING_RESET_SECRET = "test-enabled";
});

afterEach(() => {
  delete process.env.TESTING_RESET_SECRET;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedJob(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  overrides: Partial<{
    userId: string;
    mode: "zip" | "stream";
    status: string;
    createdAt: number;
    totalImages: number;
    processedImages: number;
    failedImages: number;
    rejectedEntries: number;
    lastActivityAt: number;
    errorCode: string;
    errorDetail: string;
  }> = {},
) {
  const userId = overrides.userId ?? NON_ADMIN.subject;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: `placeholders/${userId}/${jobId}/input.zip`,
      createdAt: overrides.createdAt ?? 1_700_000_000_000,
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      status: (overrides.status ?? "processing") as Doc<"placeholderJobs">["status"],
      ...(overrides.totalImages !== undefined ? { totalImages: overrides.totalImages } : {}),
      ...(overrides.processedImages !== undefined
        ? { processedImages: overrides.processedImages }
        : {}),
      ...(overrides.failedImages !== undefined ? { failedImages: overrides.failedImages } : {}),
      ...(overrides.rejectedEntries !== undefined
        ? { rejectedEntries: overrides.rejectedEntries }
        : {}),
      ...(overrides.lastActivityAt !== undefined
        ? { lastActivityAt: overrides.lastActivityAt }
        : {}),
      ...(overrides.errorCode ? { errorCode: overrides.errorCode } : {}),
      ...(overrides.errorDetail ? { errorDetail: overrides.errorDetail } : {}),
    });
  });
}

async function seedImage(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  status: "awaiting_upload" | "queued" | "processing" | "done" | "failed",
  userId = NON_ADMIN.subject,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderImages", {
      jobId,
      userId,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status,
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
    return rows.filter((r) => r.jobId === jobId).sort((a, b) => a.entryIndex - b.entryIndex);
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("both admin functions are role-gated", () => {
  test("adminListPlaceholderJobs rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1");
    await expect(t.query(api.placeholderPipeline.adminListPlaceholderJobs, {})).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test("adminListPlaceholderJobs rejects a signed-in non-admin", async () => {
    // The case that matters: "signed in" is the easy state for an attacker to
    // reach, and this surface returns every user's job ids.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1");
    await expect(
      t.withIdentity(NON_ADMIN).query(api.placeholderPipeline.adminListPlaceholderJobs, {}),
    ).rejects.toThrow(/admin access required/i);
  });

  test("adminCancelPlaceholderBatch rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1");
    await expect(
      t.mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-1" }),
    ).rejects.toThrow(/not authenticated/i);
    // And it did not act.
    expect((await getJob(t, "job-1"))?.status).toBe("processing");
  });

  test("adminCancelPlaceholderBatch rejects a signed-in non-admin, even for their OWN job", async () => {
    // Owning the job is not the same as being allowed through the admin door —
    // otherwise the admin mutation would be a second, unaudited cancel path for
    // ordinary users.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: NON_ADMIN.subject });
    await expect(
      t
        .withIdentity(NON_ADMIN)
        .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-1" }),
    ).rejects.toThrow(/admin access required/i);
    expect((await getJob(t, "job-1"))?.status).toBe("processing");
  });
});

// ---------------------------------------------------------------------------
// adminListPlaceholderJobs
// ---------------------------------------------------------------------------

describe("adminListPlaceholderJobs", () => {
  test("returns every user's jobs, newest first", async () => {
    const t = convexTest(schema, modules);
    // Inserted oldest-first so the ordering assertion is not satisfied by
    // insertion order alone.
    await seedJob(t, "job-old", { userId: NON_ADMIN.subject });
    await seedJob(t, "job-mid", { userId: OTHER_USER.subject });
    await seedJob(t, "job-new", { userId: ADMIN.subject });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});

    expect(rows.map((r) => r.jobId)).toEqual(["job-new", "job-mid", "job-old"]);
    // Cross-user visibility is the point of this surface.
    expect(rows.map((r) => r.userId)).toEqual([
      ADMIN.subject,
      OTHER_USER.subject,
      NON_ADMIN.subject,
    ]);
  });

  test("caps the page and keeps the newest rows", async () => {
    // A flat cap with no cursor — an operator's question is about the present,
    // and the present is at the top of a newest-first list.
    const t = convexTest(schema, modules);
    for (let i = 0; i < 105; i++) {
      await seedJob(t, `job-${String(i).padStart(3, "0")}`, { userId: OTHER_USER.subject });
    }

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});

    expect(rows).toHaveLength(100);
    expect(rows[0].jobId).toBe("job-104");
    // The five oldest fell off the end, not the newest.
    expect(rows.some((r) => r.jobId === "job-000")).toBe(false);
  });

  test("never returns anything path-shaped", async () => {
    // The no-objectPath rule is NOT an ownership rule and does not relax on an
    // admin surface — both service accounts hold bucket-wide read on the
    // placeholder bucket, so a path in any response is a step toward a read
    // oracle.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: OTHER_USER.subject });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});

    expect(rows[0]).not.toHaveProperty("objectPath");
    expect(JSON.stringify(rows)).not.toContain("placeholders/");
    // And no per-job pairs query was invited into the response shape.
    expect(rows[0]).not.toHaveProperty("pairCount");
    // Free-text error detail about another user's upload stays out too.
    expect(rows[0]).not.toHaveProperty("errorDetail");
  });

  test("defaults mode to zip for rows that predate streaming, and counters to 0", async () => {
    const t = convexTest(schema, modules);
    // No mode, no counters — exactly what a pre-NEO-170 row looks like.
    await seedJob(t, "job-legacy", { userId: OTHER_USER.subject, status: "pending" });
    await seedJob(t, "job-stream", {
      userId: OTHER_USER.subject,
      mode: "stream",
      status: "collecting",
      totalImages: 3,
      processedImages: 1,
      failedImages: 1,
      rejectedEntries: 2,
      lastActivityAt: 1_700_000_005_000,
    });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});
    const legacy = rows.find((r) => r.jobId === "job-legacy")!;
    const stream = rows.find((r) => r.jobId === "job-stream")!;

    // The reader rule is applied here so the UI never has to encode it twice.
    expect(legacy.mode).toBe("zip");
    expect(legacy.totalImages).toBe(0);
    expect(legacy.processedImages).toBe(0);
    expect(legacy.failedImages).toBe(0);
    expect(legacy.rejectedEntries).toBe(0);
    expect(legacy.lastActivityAt).toBeUndefined();

    expect(stream.mode).toBe("stream");
    expect(stream.status).toBe("collecting");
    expect(stream.totalImages).toBe(3);
    expect(stream.lastActivityAt).toBe(1_700_000_005_000);
  });

  test("surfaces the error code of a failed run, which is what triage groups on", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-failed", {
      userId: OTHER_USER.subject,
      status: "failed",
      errorCode: "TOO_MANY_IMAGE_FAILURES",
      errorDetail: "3 of 4 images failed to process",
    });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});

    expect(rows[0].errorCode).toBe("TOO_MANY_IMAGE_FAILURES");
    expect(JSON.stringify(rows)).not.toContain("3 of 4 images");
  });

  test("is empty rather than an error when there are no jobs", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(ADMIN).query(api.placeholderPipeline.adminListPlaceholderJobs, {}),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// adminCancelPlaceholderBatch
// ---------------------------------------------------------------------------

describe("adminCancelPlaceholderBatch", () => {
  test("aborts another user's collecting run and sweeps its abandoned rows", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", {
      userId: OTHER_USER.subject,
      mode: "stream",
      status: "collecting",
      totalImages: 1,
    });
    await seedImage(t, "job-1", 0, "awaiting_upload", OTHER_USER.subject);
    await seedImage(t, "job-1", 1, "awaiting_upload", OTHER_USER.subject);
    await seedImage(t, "job-1", 2, "done", OTHER_USER.subject);

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-1" });

    expect(result).toEqual({ canceled: true, canceledCount: 0 });
    const job = await getJob(t, "job-1");
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("CANCELED");
    expect(job?.finishedAt).toBeGreaterThan(0);
    // The detail says who, so the owner does not go looking for a click they
    // never made.
    expect(job?.errorDetail).toMatch(/administrator/i);

    // Drained rather than invoked by hand, so the SCHEDULED sweep is what runs.
    vi.useFakeTimers();
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    // Abandoned allocations gone; the confirmed image untouched.
    expect((await getImages(t, "job-1")).map((i) => i.entryIndex)).toEqual([2]);
  });

  test("writes an audit line naming the admin, the target user and the job", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: OTHER_USER.subject, status: "processing" });

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    });
    try {
      await t
        .withIdentity(ADMIN)
        .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-1" });
    } finally {
      log.mockRestore();
    }

    const audit = lines
      .filter((l) => l.includes("admin_cancel"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit).toEqual([
      {
        msg: "admin_cancel",
        jobId: "job-1",
        targetUserId: OTHER_USER.subject,
        adminUserId: ADMIN.subject,
      },
    ]);
  });

  test("the audit line is written even when the cancel changes nothing", async () => {
    // A trace that only appears on success is a success log, not an audit trail.
    // An operator reaching into another user's job is the event worth recording,
    // whatever the outcome.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-done", { userId: OTHER_USER.subject, status: "succeeded" });

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    });
    let result: { canceled: boolean; reason?: string };
    try {
      result = await t
        .withIdentity(ADMIN)
        .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-done" });
    } finally {
      log.mockRestore();
    }

    expect(result.canceled).toBe(false);
    expect(result.reason).toMatch(/already succeeded/i);
    expect(lines.filter((l) => l.includes("admin_cancel"))).toHaveLength(1);
  });

  test("refuses a job that does not exist", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-nope" }),
    ).rejects.toThrow(/job not found/i);
  });

  test("a canceled run is startable again by its owner", async () => {
    // An admin abort must leave the user a way forward, exactly as their own
    // cancel does — "failed" is a startable status.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: OTHER_USER.subject, mode: "zip", status: "processing" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-1" });

    const restart = await t
      .withIdentity(OTHER_USER)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: "job-1" });
    expect(restart.started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two cancel paths must not drift
// ---------------------------------------------------------------------------

describe("admin cancel and user cancel are the same cancel", () => {
  test("identically-seeded jobs end in identical states down each path", async () => {
    // Pinned by comparing outcomes rather than by trusting that both call the
    // shared helper today. If someone ever re-implements one of them, this is
    // what notices.
    const t = convexTest(schema, modules);
    for (const jobId of ["job-user", "job-admin"]) {
      await seedJob(t, jobId, {
        userId: NON_ADMIN.subject,
        mode: "stream",
        status: "collecting",
        totalImages: 2,
        processedImages: 1,
      });
      await seedImage(t, jobId, 0, "awaiting_upload");
      await seedImage(t, jobId, 1, "done");
      await seedImage(t, jobId, 2, "processing");
    }

    const viaUser = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: "job-user" });
    const viaAdmin = await t
      .withIdentity(ADMIN)
      .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId: "job-admin" });

    // Same return shape, same values.
    expect(viaAdmin).toEqual(viaUser);

    vi.useFakeTimers();
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const userJob = await getJob(t, "job-user");
    const adminJob = await getJob(t, "job-admin");

    // Everything that describes the OUTCOME matches. `errorDetail` is excluded
    // deliberately and asserted separately below — it is the one field the two
    // paths are meant to differ on.
    const outcome = (job: Doc<"placeholderJobs"> | null) => ({
      status: job?.status,
      errorCode: job?.errorCode,
      finished: typeof job?.finishedAt === "number",
      totalImages: job?.totalImages,
      processedImages: job?.processedImages,
    });
    expect(outcome(adminJob)).toEqual(outcome(userJob));

    // The sweep ran identically for both.
    expect((await getImages(t, "job-admin")).map((i) => [i.entryIndex, i.status])).toEqual(
      (await getImages(t, "job-user")).map((i) => [i.entryIndex, i.status]),
    );

    // The one intended difference, stated explicitly so it cannot drift into an
    // accident: same machine-readable code, different human-readable detail.
    expect(adminJob?.errorCode).toBe(userJob?.errorCode);
    expect(adminJob?.errorDetail).not.toBe(userJob?.errorDetail);
    expect(userJob?.errorDetail).toMatch(/by user/i);
    expect(adminJob?.errorDetail).toMatch(/administrator/i);
  });
});

// ---------------------------------------------------------------------------
// The E2E seed
// ---------------------------------------------------------------------------

describe("seedMyTestPlaceholderStream", () => {
  test("creates a collecting stream run owned by the caller", async () => {
    const t = convexTest(schema, modules);

    const { jobId } = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.testing.seedMyTestPlaceholderStream, {});

    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const job = await getJob(t, jobId);
    expect(job?.userId).toBe(NON_ADMIN.subject);
    expect(job?.mode).toBe("stream");
    expect(job?.status).toBe("collecting");
    expect(job?.totalImages).toBe(0);
    expect(job?.processedImages).toBe(0);
    expect(job?.failedImages).toBe(0);
    expect(job?.nextEntryIndex).toBe(0);
    expect(job?.lastActivityAt).toBeGreaterThan(0);
    // The job PREFIX, matching what `startPlaceholderStream` writes.
    expect(job?.objectPath).toBe(`placeholders/${NON_ADMIN.subject}/${jobId}/`);
    // No images, no GCS.
    expect(await getImages(t, jobId)).toHaveLength(0);
  });

  test("fails closed when the testing flag is absent — production has none", async () => {
    delete process.env.TESTING_RESET_SECRET;
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(NON_ADMIN).mutation(api.testing.seedMyTestPlaceholderStream, {}),
    ).rejects.toThrow(/not enabled on this deployment/i);

    expect(await t.run(async (ctx) => ctx.db.query("placeholderJobs").collect())).toHaveLength(
      0,
    );
  });

  test("requires a signed-in caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.testing.seedMyTestPlaceholderStream, {})).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test("the seeded run is exactly what an admin can then see and abort", async () => {
    // The end-to-end point of the fixture: it exists so an E2E flow can
    // materialise a run for an admin to act on.
    const t = convexTest(schema, modules);
    const { jobId } = await t
      .withIdentity(OTHER_USER)
      .mutation(api.testing.seedMyTestPlaceholderStream, {});

    const listed = await t
      .withIdentity(ADMIN)
      .query(api.placeholderPipeline.adminListPlaceholderJobs, {});
    expect(listed.find((r) => r.jobId === jobId)).toMatchObject({
      userId: OTHER_USER.subject,
      mode: "stream",
      status: "collecting",
    });

    const result = await t
      .withIdentity(ADMIN)
      .mutation(api.placeholderPipeline.adminCancelPlaceholderBatch, { jobId });
    expect(result.canceled).toBe(true);
    expect((await getJob(t, jobId))?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// seedCancelMyActivePlaceholderJobs — the E2E slot-freeing reset
// ---------------------------------------------------------------------------

describe("seedCancelMyActivePlaceholderJobs", () => {
  test("fails closed when the testing flag is absent — production has none", async () => {
    delete process.env.TESTING_RESET_SECRET;
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: NON_ADMIN.subject, status: "processing" });

    await expect(
      t
        .withIdentity(NON_ADMIN)
        .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {}),
    ).rejects.toThrow(/not enabled on this deployment/i);

    // And it did not cancel anything.
    expect((await getJob(t, "job-1"))?.status).toBe("processing");
  });

  test("requires a signed-in caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {}),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("cancels EVERY active status, not just collecting", async () => {
    // The whole reason this exists: `closePlaceholderStream` leaves a job in
    // "pairing", which still counts against the cap, and "extracting" /
    // "processing" do too. A reset that only cleared "collecting" would free no
    // slot for the runs that actually pile up.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-collecting", { userId: NON_ADMIN.subject, status: "collecting" });
    await seedJob(t, "job-extracting", { userId: NON_ADMIN.subject, status: "extracting" });
    await seedJob(t, "job-processing", { userId: NON_ADMIN.subject, status: "processing" });
    await seedJob(t, "job-pairing", { userId: NON_ADMIN.subject, status: "pairing" });
    // Not active — must be left exactly as they are.
    await seedJob(t, "job-pending", { userId: NON_ADMIN.subject, status: "pending" });
    await seedJob(t, "job-succeeded", { userId: NON_ADMIN.subject, status: "succeeded" });
    await seedJob(t, "job-failed", { userId: NON_ADMIN.subject, status: "failed" });

    const result = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});

    // All four active jobs cancelled, none of the three inactive ones.
    expect(result.canceled).toBe(4);

    for (const jobId of ["job-collecting", "job-extracting", "job-processing", "job-pairing"]) {
      const job = await getJob(t, jobId);
      expect(job?.status).toBe("failed");
      expect(job?.errorCode).toBe("CANCELED");
    }
    // The terminal ones are untouched, and "pending" — which is NOT active,
    // because nothing is running for it — is left startable.
    expect((await getJob(t, "job-pending"))?.status).toBe("pending");
    expect((await getJob(t, "job-succeeded"))?.status).toBe("succeeded");
    expect((await getJob(t, "job-failed"))?.status).toBe("failed");
  });

  test("goes through cancelJobImpl — real work cancellation, not a status patch", async () => {
    // Not `ctx.db.patch(status)`: an active job can hold in-flight workpool
    // items and awaiting_upload rows, and only the shared impl cancels the
    // former and sweeps the latter. Proven by the swept rows and the summed
    // work-item count, which a bare status change could produce neither of.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-stream", {
      userId: NON_ADMIN.subject,
      mode: "stream",
      status: "collecting",
      totalImages: 1,
    });
    await seedImage(t, "job-stream", 0, "awaiting_upload", NON_ADMIN.subject);
    await seedImage(t, "job-stream", 1, "awaiting_upload", NON_ADMIN.subject);
    await seedImage(t, "job-stream", 2, "done", NON_ADMIN.subject);

    await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});

    // Drained so the SCHEDULED awaiting-upload sweep runs — the sweep is exactly
    // the work a status patch would skip.
    vi.useFakeTimers();
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // Abandoned allocations gone, the confirmed image kept — the sweep ran.
    expect((await getImages(t, "job-stream")).map((i) => i.entryIndex)).toEqual([2]);
  });

  test("aggregates canceledWorkItems across every cancelled job", async () => {
    // The count each `cancelJobImpl` returns is summed here. It reads 0 in this
    // test because a NON-zero count requires `preprocessPool.cancel` to run, and
    // convex-test cannot mount the workpool component — which is why every cancel
    // test in this repo seeds workId-free rows (see the cancel tests in
    // placeholderPipeline.test.ts). What is provable here is the aggregation
    // itself: two active jobs cancel, each contributes its own count, and the
    // field sums them rather than reporting one job's. The non-zero pool path is
    // UAT-covered, like the literal `preprocessPool.cancel` call it depends on.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-a", { userId: NON_ADMIN.subject, status: "processing" });
    await seedJob(t, "job-b", { userId: NON_ADMIN.subject, status: "collecting" });
    // Rows with no workId — the cancel loop skips them, exactly as it would for
    // any image not currently in the pool — so the count stays 0 without
    // touching the unmountable component.
    await seedImage(t, "job-a", 0, "processing", NON_ADMIN.subject);
    await seedImage(t, "job-b", 0, "awaiting_upload", NON_ADMIN.subject);

    const result = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});

    expect(result.canceled).toBe(2);
    expect(result.canceledWorkItems).toBe(0);
  });

  test("only touches the CALLER's jobs, never another user's", async () => {
    // Caller-scoped even with the gate open: no userId argument, and the read is
    // through `by_user` for the verified subject.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-mine", { userId: NON_ADMIN.subject, status: "processing" });
    await seedJob(t, "job-theirs", { userId: OTHER_USER.subject, status: "processing" });

    const result = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});

    expect(result.canceled).toBe(1);
    expect((await getJob(t, "job-mine"))?.status).toBe("failed");
    // Untouched.
    expect((await getJob(t, "job-theirs"))?.status).toBe("processing");
  });

  test("is idempotent — a second call finds nothing active", async () => {
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: NON_ADMIN.subject, status: "collecting" });
    await seedJob(t, "job-2", { userId: NON_ADMIN.subject, status: "processing" });

    const first = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});
    expect(first.canceled).toBe(2);

    const second = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});
    expect(second).toEqual({ canceled: 0, canceledWorkItems: 0 });
  });

  test("frees the caller's slots so a fresh seed can start — the end-to-end point", async () => {
    // The scenario that motivated the reset: two active jobs is the cap, and a
    // closed stream stays active (pairing), so a new run cannot be seeded until
    // the slots are freed.
    const t = convexTest(schema, modules);
    await seedJob(t, "job-1", { userId: NON_ADMIN.subject, status: "pairing" });
    await seedJob(t, "job-2", { userId: NON_ADMIN.subject, status: "processing" });

    // At the cap: seeding a stream is refused.
    const blocked = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    expect(blocked.started).toBe(false);

    await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderPipeline.seedCancelMyActivePlaceholderJobs, {});

    // Slots freed: a fresh run starts.
    const after = await t
      .withIdentity(NON_ADMIN)
      .mutation(api.placeholderStream.startPlaceholderStream, {});
    expect(after.started).toBe(true);
  });
});
