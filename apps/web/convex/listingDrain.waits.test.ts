/**
 * PR 451 (NEO-487) — `ProgressLedger`'s BSC wait bookkeeping (`waitEdge`,
 * `finishWaits`) and `settleSteps`' handling of it.
 *
 * The run's BSC session recorder reports when a call goes out with none
 * outstanding and when none has been out for its idle grace. The ledger
 * stamps `marketplaceWaitingSince` on the step that is working, adds the
 * closed interval to `marketplaceWaitMs`, and writes each change chained
 * behind the step writes. A wait still open when the step changes carries on
 * into the next step; `finishWaits` closes what is open before the record is
 * finished. Pure: the ledger gets a stub ctx, no convex-test.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { ProgressLedger, settleSteps, type DrainCtx, type ListingSyncStep } from "./listingDrain";

const ids = { ownerId: "collector_ledger", platform: "bsc" as const, variantId: "v1" as Id<"selectorOptions">, leaseToken: "l" };

function make() {
  let clock = 1_000;
  const writes: ListingSyncStep[][] = [];
  const runMutation = vi.fn(async (_ref: unknown, args: { steps: ListingSyncStep[] }) => {
    writes.push(args.steps.map((s) => ({ ...s })));
    return true;
  });
  const ledger = new ProgressLedger({ runMutation } as unknown as DrainCtx, ids, () => clock);
  ledger.plan([
    { key: "a", kind: "read" },
    { key: "b", kind: "send" },
  ]);
  return {
    ledger,
    runMutation,
    writes,
    at: (t: number) => {
      clock = t;
    },
  };
}
const step = (l: ProgressLedger, i: number) => l.steps()[i];

afterEach(() => vi.restoreAllMocks());

describe("ProgressLedger.waitEdge", () => {
  test("a wait opening stamps the working step with the edge's time and writes it", async () => {
    const { ledger, writes } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    // The write is chained and sends the ledger as it stands when it runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toHaveLength(2);
    expect(writes.at(-1)![0]).toMatchObject({ status: "working", marketplaceWaitingSince: 1_200 });
  });

  test("a wait closing adds the interval to the step's total, clears the stamp, and writes", async () => {
    const { ledger, writes } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    ledger.waitEdge({ waiting: false, at: 1_900, accumulatedMs: 700 });
    ledger.waitEdge({ waiting: true, at: 3_000, accumulatedMs: 700 });
    ledger.waitEdge({ waiting: false, at: 3_250, accumulatedMs: 950 });
    await ledger.finishWaits();
    expect(step(ledger, 0)).toMatchObject({ marketplaceWaitMs: 950 });
    expect(step(ledger, 0).marketplaceWaitingSince).toBeUndefined();
    expect(writes).toHaveLength(5); // start + four edges
  });

  test("an opening edge on a step already stamped changes and writes nothing", async () => {
    const { ledger, runMutation } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    ledger.waitEdge({ waiting: true, at: 1_300, accumulatedMs: 0 });
    await ledger.finishWaits();
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  test("an edge while no step is working writes nothing; the step that starts picks the open wait up", async () => {
    const { ledger, runMutation, at } = make();
    ledger.waitEdge({ waiting: true, at: 1_100, accumulatedMs: 0 });
    expect(runMutation).not.toHaveBeenCalled();
    at(1_500);
    await ledger.start("a");
    expect(step(ledger, 0)).toMatchObject({ status: "working", marketplaceWaitingSince: 1_500 });
  });

  test("a step that starts after the wait closed is not stamped", async () => {
    const { ledger } = make();
    ledger.waitEdge({ waiting: true, at: 1_100, accumulatedMs: 0 });
    ledger.waitEdge({ waiting: false, at: 1_200, accumulatedMs: 100 });
    await ledger.start("a");
    expect(step(ledger, 0).marketplaceWaitingSince).toBeUndefined();
  });

  test("a wait open across a step change closes in the old step and carries on in the new one", async () => {
    const { ledger, at } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    at(2_000);
    await ledger.start("b");

    expect(step(ledger, 0)).toMatchObject({ status: "done", finishedAt: 2_000, marketplaceWaitMs: 800 });
    expect(step(ledger, 0).marketplaceWaitingSince).toBeUndefined();
    expect(step(ledger, 1)).toMatchObject({ status: "working", marketplaceWaitingSince: 2_000 });

    // The close edge belongs to the new step only; the old total stands.
    ledger.waitEdge({ waiting: false, at: 2_600, accumulatedMs: 1_400 });
    await ledger.finishWaits();
    expect(step(ledger, 0).marketplaceWaitMs).toBe(800);
    expect(step(ledger, 1)).toMatchObject({ marketplaceWaitMs: 600 });
  });

  test("a failed step closes its open wait into its total", async () => {
    const { ledger, at } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    at(1_700);
    ledger.fail("a");
    expect(step(ledger, 0)).toMatchObject({ status: "failed", finishedAt: 1_700, marketplaceWaitMs: 500 });
    expect(step(ledger, 0).marketplaceWaitingSince).toBeUndefined();
  });

  test("endWorking closes an open wait into the step's total", async () => {
    const { ledger, at } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    at(1_500);
    ledger.endWorking();
    expect(step(ledger, 0)).toMatchObject({ status: "done", marketplaceWaitMs: 300 });
  });

  test("writes land in order: a wait edge queued behind a slow step write waits for it", async () => {
    let release!: () => void;
    const seen: Array<ListingSyncStep["status"]> = [];
    let first = true;
    const runMutation = vi.fn(async (_ref: unknown, args: { steps: ListingSyncStep[] }) => {
      seen.push(args.steps[0].status);
      if (first) {
        first = false;
        await new Promise<void>((r) => (release = r));
      }
      return true;
    });
    const ledger = new ProgressLedger({ runMutation } as unknown as DrainCtx, ids, () => 1_000);
    ledger.plan([{ key: "a", kind: "read" }]);
    const started = ledger.start("a");
    await Promise.resolve();
    ledger.waitEdge({ waiting: true, at: 1_100, accumulatedMs: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(runMutation).toHaveBeenCalledTimes(1);
    release();
    await started;
    await ledger.finishWaits();
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  test("a failed wait write is logged by name only and dropped; the next write still goes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const runMutation = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new RangeError("lease token leaked in a message");
      return true;
    });
    const ledger = new ProgressLedger({ runMutation } as unknown as DrainCtx, ids, () => 1_000);
    ledger.plan([{ key: "a", kind: "read" }]);
    await ledger.start("a"); // write 1
    ledger.waitEdge({ waiting: true, at: 1_100, accumulatedMs: 0 }); // write 2 fails
    ledger.waitEdge({ waiting: false, at: 1_200, accumulatedMs: 100 }); // write 3 goes
    await expect(ledger.finishWaits()).resolves.toBeUndefined();
    expect(runMutation).toHaveBeenCalledTimes(3);
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      msg: "listing_wait_write_failed", platform: "bsc", operation: "writeProgress", error: "RangeError",
    });
    expect(line).not.toContain("lease token");
  });
});

describe("ProgressLedger.finishWaits", () => {
  test("closes an open wait at once and the total stays on the step", async () => {
    const { ledger, at } = make();
    await ledger.start("a");
    ledger.waitEdge({ waiting: true, at: 1_200, accumulatedMs: 0 });
    at(1_900);
    await ledger.finishWaits();
    expect(step(ledger, 0)).toMatchObject({ marketplaceWaitMs: 700 });
    expect(step(ledger, 0).marketplaceWaitingSince).toBeUndefined();
  });

  test("afterwards edges are ignored and a new step is not stamped", async () => {
    const { ledger, runMutation } = make();
    await ledger.start("a");
    await ledger.finishWaits();
    const before = runMutation.mock.calls.length;
    ledger.waitEdge({ waiting: true, at: 5_000, accumulatedMs: 0 });
    await ledger.start("b");
    expect(step(ledger, 1).marketplaceWaitingSince).toBeUndefined();
    expect(runMutation.mock.calls.length).toBe(before + 1); // only start's own write
  });

  test("waits for every queued write before it resolves", async () => {
    let release!: () => void;
    let landed = 0;
    const runMutation = vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      landed += 1;
      return true;
    });
    const ledger = new ProgressLedger({ runMutation } as unknown as DrainCtx, ids, () => 1_000);
    ledger.plan([{ key: "a", kind: "read" }]);
    ledger.start("a").catch(() => {});
    await Promise.resolve();
    const done = ledger.finishWaits();
    let finished = false;
    void done.then(() => (finished = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await done;
    expect(landed).toBe(1);
  });
});

describe("settleSteps and the wait fields", () => {
  test("a finished run waits on nothing: the open stamp is dropped, the measured total stays", () => {
    const out = settleSteps(
      [
        { kind: "read", status: "done", finishedAt: 5, marketplaceWaitMs: 800 },
        { kind: "send", status: "working", marketplaceWaitingSince: 900, marketplaceWaitMs: 100 },
      ],
      "ok",
      2_000,
    );
    expect(out).toEqual([
      { kind: "read", status: "done", finishedAt: 5, marketplaceWaitMs: 800 },
      { kind: "send", status: "done", finishedAt: 2_000, marketplaceWaitMs: 100 },
    ]);
  });

  test("a run that died settles its working step failed with no stamp", () => {
    const out = settleSteps([{ kind: "send", status: "working", marketplaceWaitingSince: 900 }], "error", 2_000);
    expect(out).toEqual([{ kind: "send", status: "failed", finishedAt: 2_000 }]);
  });
});
