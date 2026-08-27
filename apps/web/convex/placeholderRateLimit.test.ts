/**
 * NEO-160 finding 1 — the per-user submission RATE limit.
 *
 * The concurrency cap (`MAX_ACTIVE_JOBS_PER_USER`) and this limit answer two
 * different questions, and the distinction is the whole point of the ticket:
 * concurrency bounds how many batches run AT ONCE, this bounds how many may be
 * STARTED over time. A user who finishes two and starts two more, forever, is
 * inside the concurrency cap and was, before this, submitting unbounded paid
 * work — each batch up to 1001 `/process-entry` calls, every one a Vision
 * round-trip plus an inference.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  DEFAULT_MAX_JOB_STARTS_PER_WINDOW,
  JOB_START_WINDOW_MS,
  jobStartRateLimitReason,
  resolveMaxJobStartsPerWindow,
} from "./placeholderPipeline";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = { subject: "user_ratelimit" };
const NOW = 1_700_000_000_000;

describe("resolveMaxJobStartsPerWindow", () => {
  // Same contract as resolveMaxActiveJobsPerUser: fall back, never clamp, so a
  // typo is visibly wrong rather than silently "working" at a nearby value.
  test("unset and blank fall back to the default", () => {
    expect(resolveMaxJobStartsPerWindow(undefined)).toBe(DEFAULT_MAX_JOB_STARTS_PER_WINDOW);
    expect(resolveMaxJobStartsPerWindow("   ")).toBe(DEFAULT_MAX_JOB_STARTS_PER_WINDOW);
  });

  test("a valid integer is honoured", () => {
    expect(resolveMaxJobStartsPerWindow("30")).toBe(30);
  });

  test.each(["0", "-5", "3.5", "abc", "1e3", "999999"])(
    "%s is refused and falls back rather than being clamped",
    (raw) => {
      expect(resolveMaxJobStartsPerWindow(raw)).toBe(DEFAULT_MAX_JOB_STARTS_PER_WINDOW);
    },
  );
});

describe("jobStartRateLimitReason", () => {
  const jobsAt = (...offsets: number[]) =>
    offsets.map((o) => ({ createdAt: NOW - o }));

  test("under the limit returns null", () => {
    expect(jobStartRateLimitReason(jobsAt(0, 1000, 2000), NOW, 5)).toBeNull();
  });

  test("at the limit refuses", () => {
    const reason = jobStartRateLimitReason(jobsAt(0, 1, 2), NOW, 3);
    expect(reason).toMatch(/started 3 batches/);
    expect(reason).toMatch(/limit 3/);
  });

  // The window is what makes this a RATE limit rather than a lifetime quota —
  // without it a heavy first day would lock an account out permanently.
  test("jobs older than the window do not count", () => {
    const old = jobsAt(JOB_START_WINDOW_MS + 1, JOB_START_WINDOW_MS + 2, JOB_START_WINDOW_MS + 3);
    expect(jobStartRateLimitReason(old, NOW, 3)).toBeNull();
  });

  test("the boundary is exclusive — exactly one window old has aged out", () => {
    expect(jobStartRateLimitReason(jobsAt(JOB_START_WINDOW_MS), NOW, 1)).toBeNull();
  });

  test("counts only what is inside the window when both are present", () => {
    const mixed = jobsAt(0, 1000, JOB_START_WINDOW_MS + 5000, JOB_START_WINDOW_MS + 6000);
    expect(jobStartRateLimitReason(mixed, NOW, 3)).toBeNull();
    expect(jobStartRateLimitReason(mixed, NOW, 2)).toMatch(/started 2 batches/);
  });
});

describe("startPlaceholderStream enforces the rate limit", () => {
  // The end-to-end half: the pure function above is wired to the real entry
  // point, and refuses with `started: false` rather than throwing — the same
  // shape the concurrency cap uses, which is what the UI already renders.
  test("refuses once the window is full of recent jobs", async () => {
    const t = convexTest(schema, modules);

    // Seed the caller's history with terminal (non-active) jobs so the
    // CONCURRENCY cap is satisfied and only the rate limit can refuse — without
    // this the test would pass for the wrong reason.
    await t.run(async (ctx) => {
      for (let i = 0; i < DEFAULT_MAX_JOB_STARTS_PER_WINDOW; i++) {
        await ctx.db.insert("placeholderJobs", {
          jobId: `seed-${i}`,
          userId: USER.subject,
          objectPath: `placeholders/${USER.subject}/seed-${i}/`,
          createdAt: Date.now() - 1000,
          mode: "stream",
          status: "succeeded",
        });
      }
    });

    const result = await t
      .withIdentity(USER)
      .mutation(api.placeholderStream.startPlaceholderStream, {});

    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/limit .* wait a few minutes|wait a few minutes/);
  });

  test("allows a start when the recent jobs have aged out of the window", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      for (let i = 0; i < DEFAULT_MAX_JOB_STARTS_PER_WINDOW; i++) {
        await ctx.db.insert("placeholderJobs", {
          jobId: `old-${i}`,
          userId: USER.subject,
          objectPath: `placeholders/${USER.subject}/old-${i}/`,
          createdAt: Date.now() - JOB_START_WINDOW_MS - 60_000,
          mode: "stream",
          status: "succeeded",
        });
      }
    });

    const result = await t
      .withIdentity(USER)
      .mutation(api.placeholderStream.startPlaceholderStream, {});

    expect(result.started).toBe(true);
  });

  test("another user's history does not count against this caller", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      for (let i = 0; i < DEFAULT_MAX_JOB_STARTS_PER_WINDOW + 5; i++) {
        await ctx.db.insert("placeholderJobs", {
          jobId: `other-${i}`,
          userId: "user_someone_else",
          objectPath: `placeholders/user_someone_else/other-${i}/`,
          createdAt: Date.now() - 1000,
          mode: "stream",
          status: "succeeded",
        });
      }
    });

    const result = await t
      .withIdentity(USER)
      .mutation(api.placeholderStream.startPlaceholderStream, {});

    expect(result.started).toBe(true);
  });
});
