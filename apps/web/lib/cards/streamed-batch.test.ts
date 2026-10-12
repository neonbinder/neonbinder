import { describe, expect, it } from "vitest";
import { streamedBatchSettled } from "./streamed-batch";

const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe("streamedBatchSettled (NEO-341)", () => {
  const target = { candidateCount: 3, previousBatchId: undefined };

  it("is false with no subscription value yet", () => {
    expect(streamedBatchSettled(undefined, target)).toBe(false);
  });

  it("is false while any row's team lookup is still pending", () => {
    expect(
      streamedBatchSettled(
        { batchId: "b2", total: 3, ready: 2, cards: cards(3) },
        target,
      ),
    ).toBe(false);
  });

  it("is false while the batch has not fully arrived, even if every arrived row is ready", () => {
    expect(
      streamedBatchSettled(
        { batchId: "b2", total: 2, ready: 2, cards: cards(2) },
        target,
      ),
    ).toBe(false);
  });

  it("is true once the whole batch is present and every row is ready", () => {
    expect(
      streamedBatchSettled(
        { batchId: "b2", total: 3, ready: 3, cards: cards(3) },
        target,
      ),
    ).toBe(true);
  });

  it("never settles on the batch the subscription showed before the call", () => {
    // Same count, all ready — a stale snapshot from before this run's clear.
    const stale = { batchId: "b1", total: 3, ready: 3, cards: cards(3) };
    expect(
      streamedBatchSettled(stale, { candidateCount: 3, previousBatchId: "b1" }),
    ).toBe(false);
    expect(
      streamedBatchSettled(
        { ...stale, batchId: "b2" },
        { candidateCount: 3, previousBatchId: "b1" },
      ),
    ).toBe(true);
  });
});
