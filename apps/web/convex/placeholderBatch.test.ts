/**
 * Unit tests for the two HEAVY-side actions in placeholderBatch.ts (NEO-299):
 * `warmHeavyWorker` (one heavy warm-up, run by the heavy pool
 * HEAVY_MAX_PARALLELISM-wide) and `processHeavyEntryWorker` (one escalated
 * image, run by the heavy pool per escalation), plus its heartbeat.
 *
 * `callProcessEntryHeavy` and `callWarmupHeavy` (convex/adapters/preprocess.ts)
 * are module-mocked rather than driven through a fetch stub: the property
 * under test is the WORKER's own contract around them — which errors get a
 * heartbeat, which don't, and that the original error always survives — not
 * the adapter's own retry/telemetry behavior, which convex/adapters.preprocess.test.ts
 * already covers directly. `touchJobActivity` (convex/placeholderPipeline.ts)
 * is likewise mocked so a test can force it to throw, the one branch that
 * cannot be reached by seeding job state.
 *
 * Filename lives at the `convex/` root so convex-test's module registry
 * resolves the function paths, per the note on convex/placeholderPipeline.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NonRetryableError } from "@convex-dev/workpool";
import schema from "./schema";
import { internal } from "./_generated/api";

const mockState = vi.hoisted(() => ({
  /** What `callProcessEntryHeavy` should do on its next call. */
  heavyThrows: null as unknown,
  heavyResult: { needs_escalation: false } as unknown,
  /** What `callWarmupHeavy` should return. */
  warmupResult: { warmed: true } as { warmed: boolean },
  /** Calls the mocked `touchJobActivity` recorded, and whether it should throw. */
  touchCalls: [] as string[],
  touchThrows: false,
}));

vi.mock("./adapters/preprocess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/preprocess")>();
  return {
    ...actual,
    callProcessEntryHeavy: async () => {
      if (mockState.heavyThrows) throw mockState.heavyThrows;
      return mockState.heavyResult;
    },
    callWarmupHeavy: async () => mockState.warmupResult,
  };
});

vi.mock("./placeholderPipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./placeholderPipeline")>();
  const { internalMutation } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    touchJobActivity: internalMutation({
      args: { jobId: v.string() },
      returns: v.null(),
      handler: async (_ctx, args) => {
        mockState.touchCalls.push(args.jobId);
        if (mockState.touchThrows) throw new Error("touch mutation failed");
        return null;
      },
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const JOB_A = "job-heavy-aaaa";
const ARGS = { jobId: JOB_A, userId: "user_x", entryIndex: 0 };

beforeEach(() => {
  mockState.heavyThrows = null;
  mockState.heavyResult = { needs_escalation: false };
  mockState.warmupResult = { warmed: true };
  mockState.touchCalls = [];
  mockState.touchThrows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warmHeavyWorker", () => {
  test("calls callWarmupHeavy and returns { warmed }", async () => {
    const t = convexTest(schema, modules);
    mockState.warmupResult = { warmed: true };

    const result = await t.action(internal.placeholderBatch.warmHeavyWorker, {});

    expect(result).toEqual({ warmed: true });
  });

  test("faithfully reports warmed: false too — it does not coerce the adapter's answer", async () => {
    const t = convexTest(schema, modules);
    mockState.warmupResult = { warmed: false };

    const result = await t.action(internal.placeholderBatch.warmHeavyWorker, {});

    expect(result).toEqual({ warmed: false });
  });
});

describe("processHeavyEntryWorker", () => {
  test("on a retryable error, touches job activity and rethrows the SAME error", async () => {
    const t = convexTest(schema, modules);
    const retryable = new Error("preprocess HTTP 429");
    mockState.heavyThrows = retryable;

    await expect(t.action(internal.placeholderBatch.processHeavyEntryWorker, ARGS)).rejects.toThrow(
      "preprocess HTTP 429",
    );

    expect(mockState.touchCalls).toEqual([JOB_A]);
  });

  test.each([
    ["a network Error", () => new Error("network is down")],
    ["a 503 modeled as a plain Error", () => new Error("preprocess HTTP 503")],
  ])("touches job activity for %s", async (_label, makeError) => {
    const t = convexTest(schema, modules);
    mockState.heavyThrows = makeError();

    await expect(t.action(internal.placeholderBatch.processHeavyEntryWorker, ARGS)).rejects.toThrow();

    expect(mockState.touchCalls).toEqual([JOB_A]);
  });

  test("on a NonRetryableError, rethrows WITHOUT touching job activity", async () => {
    const t = convexTest(schema, modules);
    mockState.heavyThrows = new NonRetryableError("preprocess INPUT_NOT_FOUND (HTTP 404)");

    await expect(t.action(internal.placeholderBatch.processHeavyEntryWorker, ARGS)).rejects.toThrow();

    expect(mockState.touchCalls).toEqual([]);
  });

  test("if touchJobActivity itself throws, the ORIGINAL error is still rethrown", async () => {
    const t = convexTest(schema, modules);
    mockState.heavyThrows = new Error("preprocess HTTP 503");
    mockState.touchThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(t.action(internal.placeholderBatch.processHeavyEntryWorker, ARGS)).rejects.toThrow(
      "preprocess HTTP 503",
    );

    // The heartbeat's own failure is logged (non-fatal) rather than swallowed
    // silently — that is what "best-effort" means operationally.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("on success, returns the adapter's result untouched and never heartbeats", async () => {
    const t = convexTest(schema, modules);
    mockState.heavyResult = { needs_escalation: false, dhash: "abc123" };

    const result = await t.action(internal.placeholderBatch.processHeavyEntryWorker, ARGS);

    expect(result).toEqual({ needs_escalation: false, dhash: "abc123" });
    expect(mockState.touchCalls).toEqual([]);
  });
});
