/**
 * NEO-170 — the pipeline-runs view logic.
 *
 * The queue math and, especially, the sort's null-handling are the substance of
 * this feature and are invisible in a screenshot — a sort that puts nulls in the
 * wrong place, or a queue count that goes negative mid-poll, looks fine until an
 * operator is misled by it. These cases read those rules directly.
 *
 * (`.test.tsx` despite no JSX: `app/**` is collected as `*.test.tsx` only, so a
 * `.test.ts` beside the module would be collected by nothing — see
 * vitest.include.mjs.)
 */

import { describe, expect, it } from "vitest";
import {
  filterRuns,
  inQueueCount,
  progressText,
  sortRuns,
  sourceLabel,
  type RunRow,
  type RunStatus,
} from "./run-view";

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    status: "processing",
    createdAt: 1000,
    lastActivityAt: 1000,
    totalImages: 10,
    processedImages: 4,
    failedImages: 1,
    ...overrides,
  };
}

describe("inQueueCount", () => {
  it("is total minus done minus failed", () => {
    expect(inQueueCount(row({ totalImages: 40, processedImages: 10, failedImages: 2 }))).toBe(28);
  });

  it("reads a fully-drained run as 0, not a negative", () => {
    expect(inQueueCount(row({ totalImages: 12, processedImages: 12, failedImages: 0 }))).toBe(0);
  });

  it("floors a mid-poll overshoot at 0", () => {
    // Counters can momentarily disagree; a negative queue is never shown.
    expect(inQueueCount(row({ totalImages: 5, processedImages: 4, failedImages: 3 }))).toBe(0);
  });
});

describe("progressText", () => {
  it("says so before any images are known", () => {
    expect(progressText(row({ totalImages: 0 }))).toBe("No images yet");
  });

  it("always names the queue depth, including zero", () => {
    expect(
      progressText(row({ totalImages: 12, processedImages: 12, failedImages: 0 })),
    ).toBe("12 of 12 images · 0 in queue");
  });

  it("appends the failed tail only when something failed", () => {
    expect(
      progressText(row({ totalImages: 40, processedImages: 10, failedImages: 2 })),
    ).toBe("12 of 40 images · 28 in queue · 2 failed");
    expect(
      progressText(row({ totalImages: 40, processedImages: 10, failedImages: 0 })),
    ).toBe("10 of 40 images · 30 in queue");
  });
});

describe("sourceLabel", () => {
  it("names scanner and web, and dashes the absent case", () => {
    expect(sourceLabel("scanner")).toBe("Scanner");
    expect(sourceLabel("web")).toBe("Web app");
    expect(sourceLabel(undefined)).toBe("—");
  });
});

describe("filterRuns", () => {
  const runs = [
    row({ status: "collecting" }),
    row({ status: "failed" }),
    row({ status: "collecting" }),
  ];

  it("passes everything through for 'all'", () => {
    expect(filterRuns(runs, "all")).toHaveLength(3);
  });

  it("narrows to the chosen status", () => {
    expect(filterRuns(runs, "collecting")).toHaveLength(2);
    expect(filterRuns(runs, "failed")).toHaveLength(1);
    expect(filterRuns(runs, "processing")).toHaveLength(0);
  });

  it("does not mutate the input", () => {
    const input = [row({ status: "collecting" })];
    filterRuns(input, "failed");
    expect(input).toHaveLength(1);
  });
});

describe("sortRuns", () => {
  it("defaults to last-activity descending, nulls last", () => {
    const a = row({ createdAt: 1, lastActivityAt: 300 });
    const b = row({ createdAt: 2, lastActivityAt: 100 });
    const noActivity = row({ createdAt: 3, lastActivityAt: undefined });
    const sorted = sortRuns([b, noActivity, a], "lastActivity");
    expect(sorted).toEqual([a, b, noActivity]);
  });

  it("sorts by created descending", () => {
    const older = row({ createdAt: 100 });
    const newer = row({ createdAt: 300 });
    const mid = row({ createdAt: 200 });
    expect(sortRuns([older, newer, mid], "created")).toEqual([newer, mid, older]);
  });

  it("orders status with active states first, terminal last", () => {
    const done = row({ status: "succeeded", createdAt: 5 });
    const live = row({ status: "collecting", createdAt: 4 });
    const mid = row({ status: "pairing", createdAt: 3 });
    const order = sortRuns([done, mid, live], "status").map((r) => r.status);
    expect(order).toEqual(["collecting", "pairing", "succeeded"]);
  });

  it("groups by error code and sends the no-error runs to the bottom", () => {
    const zip = row({ errorCode: "ZIP_REJECTED", createdAt: 1 });
    const none = row({ errorCode: undefined, createdAt: 2 });
    const canceled = row({ errorCode: "CANCELED", createdAt: 3 });
    const codes = sortRuns([none, zip, canceled], "error").map((r) => r.errorCode);
    // Alphabetical among those that have one, nulls last.
    expect(codes).toEqual(["CANCELED", "ZIP_REJECTED", undefined]);
  });

  it("breaks every tie by created-descending, deterministically", () => {
    // Same status, no activity — only the createdAt tiebreaker separates them.
    const a = row({ status: "failed", lastActivityAt: undefined, createdAt: 10 });
    const b = row({ status: "failed", lastActivityAt: undefined, createdAt: 20 });
    expect(sortRuns([a, b], "status")).toEqual([b, a]);
  });

  it("does not mutate the input array", () => {
    const input = [row({ createdAt: 1 }), row({ createdAt: 2 })];
    const snapshot = [...input];
    sortRuns(input, "created");
    expect(input).toEqual(snapshot);
  });

  it("puts an unknown status last rather than at the top", () => {
    const unknown = row({ status: "quantum" as RunStatus, createdAt: 9 });
    const live = row({ status: "collecting", createdAt: 1 });
    expect(sortRuns([unknown, live], "status").map((r) => r.status)).toEqual([
      "collecting",
      "quantum",
    ]);
  });
});
