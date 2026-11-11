/**
 * PR 451 (NEO-487) — `createMarketplaceWaitWriter`: a BSC call recorder's wait
 * edges turned into `marketplaceWaits` writes. One writer per recorder; the
 * first open edge inserts the row, every later edge patches it by id, the
 * writes are chained so a close never lands before its open, and a failed
 * write is logged and swallowed.
 */
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createMarketplaceWaitWriter,
  isValidWaitKey,
  WAIT_KEY_MAX_LENGTH,
} from "./marketplaceWaitWriter";

type Call = { name: string; args: Record<string, unknown> };

function fakeCtx(open: () => Promise<unknown> = async () => "wait_1") {
  const calls: Call[] = [];
  const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(ref as never);
    calls.push({ name, args });
    if (name === "marketplaceWaits:open") return open();
    return null;
  });
  return { ctx: { runMutation } as never, calls, runMutation };
}

afterEach(() => vi.restoreAllMocks());

describe("isValidWaitKey", () => {
  test.each([["run_1"], ["A-b_9"], ["x".repeat(WAIT_KEY_MAX_LENGTH)]])("%s is valid", (key) => {
    expect(isValidWaitKey(key)).toBe(true);
  });
  test.each([[""], ["x".repeat(WAIT_KEY_MAX_LENGTH + 1)], ["has space"], ["a/b"], ["é"], [undefined], [42]])(
    "%s is not",
    (key) => {
      expect(isValidWaitKey(key)).toBe(false);
    },
  );
});

describe("createMarketplaceWaitWriter", () => {
  test.each([[undefined], [""], ["bad key!"], ["x".repeat(65)]])("no writer for the run key %s", (key) => {
    const { ctx } = fakeCtx();
    expect(createMarketplaceWaitWriter(ctx, key, "op")).toBeUndefined();
  });

  test("the open edge inserts the row, later edges patch it by id, in order", async () => {
    const { ctx, calls } = fakeCtx();
    const w = createMarketplaceWaitWriter(ctx, "run_1", "fetchBscChecklist")!;
    w.onWaitEdge({ waiting: true, at: 1_000, accumulatedMs: 0 });
    w.onWaitEdge({ waiting: false, at: 1_800, accumulatedMs: 800 });
    w.onWaitEdge({ waiting: true, at: 5_000, accumulatedMs: 800 });
    await w.drain();
    expect(calls).toEqual([
      { name: "marketplaceWaits:open", args: { runKey: "run_1", platform: "bsc", waitingSince: 1_000 } },
      { name: "marketplaceWaits:edge", args: { waitId: "wait_1", waitingSince: null, accumulatedMs: 800 } },
      { name: "marketplaceWaits:edge", args: { waitId: "wait_1", waitingSince: 5_000, accumulatedMs: 800 } },
    ]);
  });

  test("the writes are chained: a close waits for the open to land", async () => {
    let release!: (id: string) => void;
    const { ctx, calls } = fakeCtx(() => new Promise((r) => (release = r as (id: string) => void)));
    const w = createMarketplaceWaitWriter(ctx, "run_1", "op")!;
    w.onWaitEdge({ waiting: true, at: 1, accumulatedMs: 0 });
    w.onWaitEdge({ waiting: false, at: 2, accumulatedMs: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map((c) => c.name)).toEqual(["marketplaceWaits:open"]);
    release("wait_9");
    await w.drain();
    expect(calls.map((c) => c.name)).toEqual(["marketplaceWaits:open", "marketplaceWaits:edge"]);
    expect(calls[1].args.waitId).toBe("wait_9");
  });

  test("a close with no row (the open never happened) writes nothing", async () => {
    const { ctx, calls } = fakeCtx();
    const w = createMarketplaceWaitWriter(ctx, "run_1", "op")!;
    w.onWaitEdge({ waiting: false, at: 2, accumulatedMs: 1 });
    await w.drain();
    expect(calls).toEqual([]);
  });

  test("an open refused for want of an identity (null) stops every later write", async () => {
    const { ctx, calls } = fakeCtx(async () => null);
    const w = createMarketplaceWaitWriter(ctx, "run_1", "op")!;
    w.onWaitEdge({ waiting: true, at: 1, accumulatedMs: 0 });
    w.onWaitEdge({ waiting: false, at: 2, accumulatedMs: 1 });
    w.onWaitEdge({ waiting: true, at: 3, accumulatedMs: 1 });
    await w.drain();
    expect(calls.map((c) => c.name)).toEqual(["marketplaceWaits:open"]);
  });

  test("a failed write is logged by name only, swallowed, and drain never rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runMutation = vi.fn(async () => {
      throw new TypeError("secret detail in the message");
    });
    const w = createMarketplaceWaitWriter({ runMutation } as never, "run_1", "fetchBscCardTeamNames")!;
    w.onWaitEdge({ waiting: true, at: 1, accumulatedMs: 0 });
    await expect(w.drain()).resolves.toBeUndefined();
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      msg: "marketplace_wait_write_failed",
      platform: "bsc",
      operation: "fetchBscCardTeamNames",
      error: "TypeError",
    });
    expect(line).not.toContain("secret detail");
  });

  test("after a failed open the next edge tries to open again (the row never existed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const { ctx, calls } = fakeCtx(async () => {
      n += 1;
      if (n === 1) throw new Error("down");
      return "wait_2";
    });
    const w = createMarketplaceWaitWriter(ctx, "run_1", "op")!;
    w.onWaitEdge({ waiting: true, at: 1, accumulatedMs: 0 });
    w.onWaitEdge({ waiting: true, at: 9, accumulatedMs: 0 });
    await w.drain();
    expect(calls.map((c) => c.name)).toEqual(["marketplaceWaits:open", "marketplaceWaits:open"]);
  });
});
