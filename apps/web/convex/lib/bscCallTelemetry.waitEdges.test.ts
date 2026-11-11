/**
 * PR 451 (NEO-487) — the BSC call recorder's wait edges (`onWaitEdge`).
 *
 * The recorder tells its owner when it starts waiting on BSC (its first call
 * opens) and when it stops (no call in flight for the 500 ms idle grace), so
 * the client can say "Waiting on BuySportsCards...". Measured from the calls
 * themselves, never from a step's elapsed time. Fake timers drive both the
 * recorder's clock and its grace timer.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BSC_WAIT_IDLE_GRACE_MS,
  createBscRecorder,
  resetBscInflightForTests,
  whileWaitingOnBsc,
  type BscWaitEdge,
} from "./bscCallTelemetry";

const META = { pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 1, timeoutMs: 5000, attempt: 1 };
const T0 = 1_800_000_000_000;
const quietLog = { log: () => {}, warn: () => {} };

function make(extra: Partial<Parameters<typeof createBscRecorder>[1]> = {}) {
  const edges: BscWaitEdge[] = [];
  const rec = createBscRecorder("op", {
    log: quietLog,
    now: Date.now,
    onWaitEdge: (e) => edges.push(e),
    ...extra,
  });
  return { rec, edges };
}
const ok = () => new Response("{}", { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetBscInflightForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetBscInflightForTests();
});

describe("createBscRecorder — wait edges", () => {
  test("the grace is 500 ms", () => {
    expect(BSC_WAIT_IDLE_GRACE_MS).toBe(500);
  });

  test("the first call opens the wait; the close comes one grace after the last call settles, stamped at the settle", () => {
    const { rec, edges } = make();
    const tok = rec.start(META);
    expect(edges).toEqual([{ waiting: true, at: T0, accumulatedMs: 0 }]);
    vi.advanceTimersByTime(300);
    rec.respond(tok, ok());
    // Still inside the grace: not closed yet.
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS - 1);
    expect(edges).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 300, accumulatedMs: 300 },
    ]);
  });

  test("a wave of overlapping calls is ONE wait, closed after the last one settles", () => {
    const { rec, edges } = make();
    const a = rec.start(META);
    vi.advanceTimersByTime(100);
    const b = rec.start(META);
    vi.advanceTimersByTime(100);
    rec.respond(a, ok());
    vi.advanceTimersByTime(1_000); // well past the grace, but b is still out
    expect(edges).toHaveLength(1);
    vi.advanceTimersByTime(200);
    rec.respond(b, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges.map((e) => [e.waiting, e.at, e.accumulatedMs])).toEqual([
      [true, T0, 0],
      [false, T0 + 1_400, 1_400],
    ]);
  });

  test("a retry inside the grace is the same wait, with the gap counted", () => {
    const { rec, edges } = make();
    const first = rec.start(META);
    vi.advanceTimersByTime(200);
    rec.fail(first, { error: new Error("boom") });
    vi.advanceTimersByTime(300); // the retry pause, shorter than the grace
    const second = rec.start({ ...META, attempt: 2 });
    expect(edges).toHaveLength(1);
    vi.advanceTimersByTime(200);
    rec.respond(second, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges.map((e) => [e.waiting, e.accumulatedMs])).toEqual([
      [true, 0],
      [false, 700],
    ]);
  });

  test("a call after the grace is a new wait, and the total accumulates across waits", () => {
    const { rec, edges } = make();
    const a = rec.start(META);
    vi.advanceTimersByTime(400);
    rec.respond(a, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS + 1_000);
    const b = rec.start(META);
    vi.advanceTimersByTime(250);
    rec.respond(b, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges.map((e) => [e.waiting, e.accumulatedMs])).toEqual([
      [true, 0],
      [false, 400],
      [true, 400], // an open edge carries what was closed so far
      [false, 650],
    ]);
  });

  test("two edges in a row are never the same state", () => {
    const { rec, edges } = make();
    for (let i = 0; i < 4; i += 1) {
      const tok = rec.start(META);
      vi.advanceTimersByTime(50);
      rec.respond(tok, ok());
      vi.advanceTimersByTime(i % 2 === 0 ? 100 : 2_000);
    }
    vi.advanceTimersByTime(2_000);
    edges.forEach((e, i) => {
      if (i > 0) expect(e.waiting).not.toBe(edges[i - 1].waiting);
    });
  });

  test("flush closes a wait an abandoned call left open, at once, and no timer fires later", async () => {
    const { rec, edges } = make();
    rec.start(META);
    vi.advanceTimersByTime(900);
    await rec.flush();
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 900, accumulatedMs: 900 },
    ]);
    vi.advanceTimersByTime(10_000);
    expect(edges).toHaveLength(2);
  });

  test("flush inside the grace closes at the last settle, not later", async () => {
    const { rec, edges } = make();
    const tok = rec.start(META);
    vi.advanceTimersByTime(300);
    rec.respond(tok, ok());
    vi.advanceTimersByTime(200);
    await rec.flush();
    expect(edges.at(-1)).toEqual({ waiting: false, at: T0 + 300, accumulatedMs: 300 });
    vi.advanceTimersByTime(5_000);
    expect(edges).toHaveLength(2);
  });

  test("a recorder with no calls, or flushed with nothing waiting, emits no edge", async () => {
    const { rec, edges } = make();
    await rec.flush();
    expect(edges).toEqual([]);
  });

  test("a call started after flush opens no wait", async () => {
    const { rec, edges } = make();
    await rec.flush();
    rec.start(META);
    expect(edges).toEqual([]);
  });

  test("waitIdleGraceMs: 0 closes on the settle itself", () => {
    const { rec, edges } = make({ waitIdleGraceMs: 0 });
    const tok = rec.start(META);
    vi.advanceTimersByTime(120);
    rec.respond(tok, ok());
    expect(edges.at(-1)).toEqual({ waiting: false, at: T0 + 120, accumulatedMs: 120 });
  });

  test("a hook that throws never reaches the call, and later edges still come", () => {
    const seen: BscWaitEdge[] = [];
    const rec = createBscRecorder("op", {
      log: quietLog,
      now: Date.now,
      onWaitEdge: (e) => {
        seen.push(e);
        throw new Error("hook down");
      },
    });
    expect(() => {
      const tok = rec.start(META);
      rec.respond(tok, ok());
    }).not.toThrow();
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(seen.map((e) => e.waiting)).toEqual([true, false]);
  });

  test("with no hook the recorder starts no grace timer", () => {
    const rec = createBscRecorder("op", { log: quietLog, now: Date.now });
    const tok = rec.start(META);
    rec.respond(tok, ok());
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * PR 451 (NEO-487) — the token leg. Before its first call an adapter reads a
 * token, and a stale session makes that read a BSC sign-in through the
 * browser service (11-12 s seen in CI) with no call in flight. `beginWait`
 * (and `whileWaitingOnBsc`) hold the wait open through it with the same state
 * machine as a call, so the token leg and the calls after it are one wait and
 * no millisecond is counted twice.
 */
describe("createBscRecorder — waits that are not calls (beginWait)", () => {
  test("a slow token leg opens the wait at its start; the first call joins it; one close after the last call", () => {
    const { rec, edges } = make();
    const end = rec.beginWait();
    expect(edges).toEqual([{ waiting: true, at: T0, accumulatedMs: 0 }]);
    vi.advanceTimersByTime(11_000); // the sign-in
    end();
    // The first call goes out at once: same wait, no close/open between.
    const tok = rec.start(META);
    vi.advanceTimersByTime(400);
    rec.respond(tok, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 11_400, accumulatedMs: 11_400 },
    ]);
  });

  test("a token leg that fails still closes the wait, stamped at its end", async () => {
    const { rec, edges } = make();
    await expect(
      whileWaitingOnBsc(rec, async () => {
        vi.advanceTimersByTime(3_000);
        throw new Error("sign-in failed");
      }),
    ).rejects.toThrow("sign-in failed");
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 3_000, accumulatedMs: 3_000 },
    ]);
  });

  test("a token leg answered with no token (no throw) closes too, and the flush right after closes it at once", async () => {
    const { rec, edges } = make();
    const answer = await whileWaitingOnBsc(rec, async () => {
      vi.advanceTimersByTime(800);
      return { success: false as const };
    });
    expect(answer).toEqual({ success: false });
    // The adapter returns at once and flushes inside the grace.
    await rec.flush();
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 800, accumulatedMs: 800 },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(edges).toHaveLength(2);
  });

  test("no double counting: a call overlapping the span adds only the time outside it", () => {
    const { rec, edges } = make();
    const end = rec.beginWait();
    vi.advanceTimersByTime(1_000);
    const tok = rec.start(META); // overlaps the span
    vi.advanceTimersByTime(1_000);
    end();
    vi.advanceTimersByTime(500);
    rec.respond(tok, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    // Wall clock from the span's start to the call's settle: 2.5 s, not 2 + 1.5.
    expect(edges.map((e) => [e.waiting, e.accumulatedMs])).toEqual([
      [true, 0],
      [false, 2_500],
    ]);
  });

  test("calling the end twice ends the span once (a call still out keeps the wait open)", () => {
    const { rec, edges } = make();
    const end = rec.beginWait();
    const tok = rec.start(META);
    vi.advanceTimersByTime(100);
    end();
    end();
    vi.advanceTimersByTime(2_000);
    expect(edges).toHaveLength(1); // the call is still in flight
    rec.respond(tok, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges.map((e) => [e.waiting, e.accumulatedMs])).toEqual([
      [true, 0],
      [false, 2_100],
    ]);
  });

  test("a fast (cached) token read before quick calls stays one short wait: two edges, nothing for the client to announce", () => {
    const { rec, edges } = make();
    const end = rec.beginWait();
    vi.advanceTimersByTime(40);
    end();
    const tok = rec.start(META);
    vi.advanceTimersByTime(300);
    rec.respond(tok, ok());
    vi.advanceTimersByTime(BSC_WAIT_IDLE_GRACE_MS);
    expect(edges.map((e) => [e.waiting, e.accumulatedMs])).toEqual([
      [true, 0],
      [false, 340],
    ]);
    // Well under the client's 1.5 s announce (WaitingOnMarketplace).
    expect(edges[1].at - edges[0].at).toBeLessThan(1_500);
  });

  test("a span is not a call: no summary, no latency, no call counted", async () => {
    const { rec } = make();
    const end = rec.beginWait();
    vi.advanceTimersByTime(500);
    end();
    expect(await rec.flush()).toBeNull();
  });

  test("a span alongside a call leaves the call summary untouched", async () => {
    const { rec } = make();
    const end = rec.beginWait();
    vi.advanceTimersByTime(5_000);
    end();
    const tok = rec.start(META);
    vi.advanceTimersByTime(200);
    rec.respond(tok, ok());
    const out = await rec.flush();
    expect(out?.summary.calls).toBe(1);
    expect(out?.summary.lat.max).toBe(200);
    expect(out?.summary.maxInflight).toBe(1);
  });

  test("flush with a span still open closes the wait at once; its later end does nothing", async () => {
    const { rec, edges } = make();
    const end = rec.beginWait();
    vi.advanceTimersByTime(700);
    await rec.flush();
    expect(edges).toEqual([
      { waiting: true, at: T0, accumulatedMs: 0 },
      { waiting: false, at: T0 + 700, accumulatedMs: 700 },
    ]);
    end();
    vi.advanceTimersByTime(5_000);
    expect(edges).toHaveLength(2);
  });

  test("a span begun after flush opens no wait", async () => {
    const { rec, edges } = make();
    await rec.flush();
    rec.beginWait()();
    expect(edges).toEqual([]);
  });

  test("with no hook a span starts no timer and emits nothing", () => {
    const rec = createBscRecorder("op", { log: quietLog, now: Date.now });
    const end = rec.beginWait();
    vi.advanceTimersByTime(100);
    end();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("whileWaitingOnBsc with no recorder just runs the work", async () => {
    await expect(whileWaitingOnBsc(undefined, async () => 7)).resolves.toBe(7);
  });
});
