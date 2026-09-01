/**
 * NEO-189 — the OCC retry helper behind `commitCardChecklist`'s phased commit.
 *
 * convex-test cannot reproduce a real optimistic-concurrency conflict (it runs
 * mutations serially, so nothing can change a read set mid-flight), which is
 * exactly why the retry logic lives in a plain function: the thing that CANNOT
 * be tested through the platform is tested directly here, and the thing that
 * can — the writer guard that stops the conflict happening at all — is tested
 * through convex-test in convex/entityReviewQueue.test.ts.
 *
 * The message string below is the real one, copied from the seed job's failure:
 * a paraphrase would let the pattern rot silently.
 */

import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  OCC_RETRY_ATTEMPTS,
  isOccConflict,
  runWithOccRetry,
} from "./occ-retry";

const REAL_OCC_MESSAGE =
  'Documents read from or written to the "entityReviewQueue" table changed ' +
  "while this mutation was being run and on every subsequent retry. A call to " +
  '"entityReviewQueue.js:applyLookupResult" changed the document with ID ' +
  '"jn7ddj0abc123".';

/** No real wall-clock in tests; the helper takes its sleep as an argument. */
const noSleep = async () => {};

describe("isOccConflict", () => {
  test("recognises the message Convex actually produced in CI", () => {
    expect(isOccConflict(new Error(REAL_OCC_MESSAGE))).toBe(true);
  });

  test("recognises the internal error name too", () => {
    expect(
      isOccConflict(new Error("OptimisticConcurrencyControlFailure")),
    ).toBe(true);
  });

  test("looks inside a ConvexError's data payload", () => {
    expect(isOccConflict(new ConvexError(REAL_OCC_MESSAGE))).toBe(true);
  });

  test("does not fire on unrelated failures", () => {
    expect(isOccConflict(new Error("Admin access required"))).toBe(false);
    expect(isOccConflict(new Error("Not authenticated"))).toBe(false);
    expect(isOccConflict("some string")).toBe(false);
    expect(isOccConflict(undefined)).toBe(false);
  });
});

describe("runWithOccRetry", () => {
  test("returns the first attempt's value without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const run = vi.fn(async () => "ok");

    await expect(runWithOccRetry(run, { sleep })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries an OCC conflict and returns the later success", async () => {
    const sleep = vi.fn(noSleep);
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error(REAL_OCC_MESSAGE);
      return "committed";
    });

    await expect(runWithOccRetry(run, { sleep })).resolves.toBe("committed");
    expect(run).toHaveBeenCalledTimes(3);
    // Linear backoff between attempts, not before the first one.
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  test("gives up after the attempt budget and rethrows the last conflict", async () => {
    const sleep = vi.fn(noSleep);
    const run = vi.fn(async () => {
      throw new Error(REAL_OCC_MESSAGE);
    });

    await expect(runWithOccRetry(run, { sleep })).rejects.toThrow(
      /changed while this mutation was being run/,
    );
    expect(run).toHaveBeenCalledTimes(OCC_RETRY_ATTEMPTS);
  });

  test("rethrows anything that is NOT an OCC conflict immediately", async () => {
    const sleep = vi.fn(noSleep);
    const run = vi.fn(async () => {
      throw new Error("Admin access required");
    });

    await expect(runWithOccRetry(run, { sleep })).rejects.toThrow(
      /Admin access required/,
    );
    // The whole point: a non-repeatable failure is not repeated.
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
