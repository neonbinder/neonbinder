/**
 * NEO-475 — the seller client's BSC call telemetry (`send` in `bscSeller.ts`):
 *
 *   - every request is recorded on its session's recorder: ok, http (the
 *     401 a refresh answers included), timeout, network, and a 2xx whose body
 *     will not parse;
 *   - the caller still reads the WHOLE body of a non-2xx, although the
 *     recorder samples it from a clone;
 *   - `closeBscSellerSession` flushes once: one `bsc_call_summary` line and
 *     one `bscCallStats.record` scheduled, a second close does nothing;
 *   - a refused `runAfter` is swallowed and logged, and a ctx with no
 *     scheduler gets the log line only;
 *   - the results the callers see are the ones they saw before.
 *
 * `fetch` is stubbed; nothing reaches the network.
 */

import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeBscSellerSession,
  flushBscRecorder,
  openBscSellerSession,
  fetchBscSellerId,
  readBscOrder,
  readBscOrderHistory,
  readBscSellerSheet,
  type BscSellerSession,
} from "./bscSeller";
import { createBscRecorder, resetBscInflightForTests } from "../lib/bscCallTelemetry";

type Scheduled = { name: string; delay: number; args: Record<string, unknown> };

/** A ctx whose credential actions answer a token, and whose scheduler records. */
function makeCtx(opts: { runAfter?: (delay: number, ref: unknown, args: unknown) => Promise<unknown> } = {}) {
  const scheduled: Scheduled[] = [];
  const runAction = vi.fn(async (_ref: unknown, _args: unknown) => ({ token: "tok-2", refreshed: true }));
  const runAfter = vi.fn(
    opts.runAfter ??
      (async (delay: number, ref: unknown, args: unknown) => {
        scheduled.push({ name: getFunctionName(ref as never), delay, args: args as Record<string, unknown> });
        return "scheduled-id";
      }),
  );
  return { ctx: { runAction, scheduler: { runAfter } }, scheduled, runAction, runAfter };
}

const session = (): BscSellerSession => ({ ownerId: "owner", token: "tok", reauthAttempted: false, dead: false });

let logs: string[];
let warns: string[];

/**
 * A fixed clock (Date only; real timers keep running). The leak checks below
 * look for the fixture phone's digits ("555", "867", "5309") in the logged
 * line and the scheduled row, and both carry an epoch-ms stamp: off the real
 * clock, a stamp that happened to hold "5309" failed the test. This instant's
 * digits (1767225600000, 2026-01-01T00:00:00Z) hold none of them.
 */
const FIXED_NOW = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  resetBscInflightForTests();
  logs = [];
  warns = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    warns.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

function jsonLines(lines: string[], msg: string): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.startsWith("{") && l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.msg === msg);
}

const summaries = () => jsonLines(logs, "bsc_call_summary");
const failures = () => jsonLines(warns, "bsc_call_failed");

function timeoutError(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

describe("send records every request on the session", () => {
  test("ok: one call, ok, scheduled once on close; a second close does nothing", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({ results: [], totalElements: 0 })) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    const r = await readBscOrderHistory(ctx as never, s, 0);
    expect(r).toEqual({ ok: true, value: { orders: [], unreadable: 0 } });

    await closeBscSellerSession(ctx, s);
    await closeBscSellerSession(ctx, s);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ op: "bscSellerSession", calls: 1, ok: 1, byKind: {}, byStatus: { "200": 1 } });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ name: "bscCallStats:record", delay: 0 });
    expect(scheduled[0].args).toMatchObject({ op: "bscSellerSession", calls: 1, ok: 1, samples: [] });
  });

  test("http: the caller still reads the whole body; the result is unchanged; the sample carries a scrubbed body", async () => {
    // A body far past the 4 KB the recorder samples, so only the CALLER can
    // have drained the source to its end.
    let drained = false;
    const chunk = new TextEncoder().encode("<html><title>Service Unavailable</title>" + "x".repeat(2000) + "</html>");
    vi.stubGlobal("fetch", (async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < 6) {
            controller.enqueue(chunk);
            sent += 1;
          } else {
            drained = true;
            controller.close();
          }
        },
      });
      return new Response(body, { status: 503, headers: { "content-type": "text/html", server: "awselb/2.0" } });
    }) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    const r = await readBscOrder(ctx as never, s, "order-123");
    expect(r).toEqual({
      ok: false,
      failure: { kind: "http", httpStatus: 503, message: "BuySportsCards was snoozing and didn't wake up in time." },
    });
    expect(drained).toBe(true);

    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 1, ok: 0, byKind: { http: 1 }, byStatus: { "503": 1 } });
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({
      kind: "http",
      status: 503,
      pathTemplate: "seller/order/:id",
      headers: { server: "awselb/2.0", "content-type": "text/html" },
    });
    expect(String(failures()[0].body)).toContain('title="Service Unavailable"');
    expect(JSON.stringify(failures()[0])).not.toContain("order-123");
    expect(scheduled).toHaveLength(1);
  });

  test("timeout and network: classified from the thrown error, results unchanged", async () => {
    const errors = [timeoutError(), new TypeError("fetch failed")];
    vi.stubGlobal("fetch", (async () => {
      throw errors.shift();
    }) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    expect(await readBscOrder(ctx as never, s, "o-1")).toEqual({
      ok: false,
      failure: { kind: "timeout", message: "BuySportsCards left NeonBinder hanging with no answer." },
    });
    expect(await readBscOrder(ctx as never, s, "o-2")).toEqual({
      ok: false,
      failure: { kind: "network", message: "NeonBinder couldn't reach BuySportsCards." },
    });
    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 2, ok: 0, byKind: { timeout: 1, network: 1 } });
    expect(failures().map((f) => [f.kind, f.timeoutMs])).toEqual([
      ["timeout", 30_000],
      ["network", 30_000],
    ]);
    expect(scheduled).toHaveLength(1);
  });

  test("a 2xx body that is not JSON is a parse failure on that call, not an ok", async () => {
    vi.stubGlobal("fetch", (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch);
    const { ctx } = makeCtx();
    const s = session();
    expect(await readBscOrder(ctx as never, s, "o-1")).toEqual({
      ok: false,
      failure: { kind: "bad_response", httpStatus: 200, message: "BuySportsCards sent back a garbled answer." },
    });
    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 1, ok: 0, byKind: { parse: 1 }, byStatus: { "200": 1 } });
  });

  test("a 401 refreshed once and retried: two calls on one summary, the retry ok", async () => {
    const statuses = [401, 200];
    vi.stubGlobal("fetch", (async () => {
      const status = statuses.shift() ?? 500;
      return status === 200 ? Response.json({ results: [], totalElements: 0 }) : new Response("expired", { status });
    }) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    const r = await readBscOrderHistory(ctx as never, s, 0);
    expect(r.ok).toBe(true);
    expect(s.token).toBe("tok-2");
    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 2, ok: 1, byKind: { http: 1 }, byStatus: { "401": 1, "200": 1 } });
    expect(failures()[0]).toMatchObject({ attempt: 1, status: 401 });
    expect(scheduled).toHaveLength(1);
  });
});

describe("NEO-475: the profile read's retry is recorded per attempt", () => {
  test("two timeouts: two calls on the summary, each failure line naming its attempt and the 5 s bound", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw timeoutError();
    }) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    expect(await fetchBscSellerId(ctx as never, s)).toMatchObject({ ok: false, failure: { kind: "timeout" } });
    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 2, ok: 0, byKind: { timeout: 2 } });
    expect(failures().map((f) => [f.pathTemplate, f.kind, f.attempt, f.timeoutMs])).toEqual([
      ["marketplace/user/profile", "timeout", 1, 5_000],
      ["marketplace/user/profile", "timeout", 2, 5_000],
    ]);
    expect(scheduled).toHaveLength(1);
  });

  test("a timeout then an answer: one failure line (attempt 1), the second call ok", async () => {
    const answers: Array<"timeout" | "ok"> = ["timeout", "ok"];
    vi.stubGlobal("fetch", (async () => {
      if (answers.shift() === "timeout") throw timeoutError();
      return Response.json({ sellerProfile: { sellerId: "seller-9" } });
    }) as typeof fetch);
    const { ctx } = makeCtx();
    const s = session();
    expect(await fetchBscSellerId(ctx as never, s)).toEqual({ ok: true, value: "seller-9" });
    await closeBscSellerSession(ctx, s);
    expect(summaries()[0]).toMatchObject({ calls: 2, ok: 1, byKind: { timeout: 1 } });
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({ kind: "timeout", attempt: 1, timeoutMs: 5_000 });
  });

  test("a sheet read the caller retries is recorded under the caller's attempt, as its log line is", async () => {
    vi.stubGlobal("fetch", (async () => new Response("<html>Service Unavailable</html>", { status: 503 })) as typeof fetch);
    const { ctx } = makeCtx();
    const s = session();
    await readBscSellerSheet(ctx as never, s, { filters: {}, condition: "near_mint", attempt: 3 });
    await closeBscSellerSession(ctx, s);
    expect(failures()[0]).toMatchObject({ kind: "http", status: 503, attempt: 3 });
  });
});

describe("a seller session samples failed bodies keysOnly", () => {
  test("a 4xx naming an order, an address and a phone keeps only the code and status values", async () => {
    const sellerBody = {
      code: "ORDER_NOT_SHIPPABLE",
      status: "BAD_REQUEST",
      message: "Order ORD-88123 for Jane Doe at 12 Elm Street, Springfield cannot ship; call 555-867-5309",
      error: "Jane Doe, 12 Elm Street, Springfield",
      title: "Order ORD-88123",
      // A code that is not safe-shaped is free text too, and is dropped.
      detail: { code: "Jane Doe 555 867 5309", phone: "555-867-5309" },
    };
    vi.stubGlobal("fetch", (async () =>
      Response.json(sellerBody, { status: 400, headers: { server: "awselb/2.0" } })) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const s = session();
    const r = await readBscOrder(ctx as never, s, "ord-77");
    expect(r).toEqual({
      ok: false,
      failure: { kind: "http", httpStatus: 400, message: "BuySportsCards fumbled that one (error 400)." },
    });
    await closeBscSellerSession(ctx, s);

    expect(failures()).toHaveLength(1);
    const body = String(failures()[0].body);
    // Key names survive (they are field names, not values); of the values,
    // only the safe-shaped code and status do.
    const values = body.replace(/^keys=\[[^\]]*\]\s*/, "");
    expect(values).toBe('code="ORDER_NOT_SHIPPABLE" status="BAD_REQUEST"');
    expect(body).toContain("keys=[");
    // The row the table keeps carries the same sample, and nothing of the
    // order, the buyer, the address or the phone reaches either.
    expect(scheduled).toHaveLength(1);
    const samples = scheduled[0].args.samples as Array<Record<string, unknown>>;
    expect(samples).toHaveLength(1);
    expect(samples[0].body).toBe(body);
    for (const out of [JSON.stringify(failures()[0]), JSON.stringify(scheduled[0].args)]) {
      for (const leak of ["ORD-88123", "ord-77", "Jane", "Doe", "Elm", "Springfield", "555", "867", "5309"]) {
        expect(out).not.toContain(leak);
      }
    }
  });

  test("a session opened by its owner samples keysOnly too", async () => {
    vi.stubGlobal("fetch", (async () =>
      Response.json({ code: "E42", message: "Jane Doe, 12 Elm Street" }, { status: 422 })) as typeof fetch);
    const { ctx } = makeCtx();
    const opened = await openBscSellerSession(ctx as never, "owner", { op: "drainOwner" });
    if (!opened.ok) throw new Error("expected a session");
    await readBscOrderHistory(ctx as never, opened.value, 0);
    await closeBscSellerSession(ctx, opened.value);
    const body = String(failures()[0].body);
    expect(body).toContain('code="E42"');
    expect(body).not.toContain("Jane");
    expect(body).not.toContain("Elm");
  });
});

describe("openBscSellerSession names the session's summary", () => {
  test("the opener's op is the summary's op", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({ results: [], totalElements: 0 })) as typeof fetch);
    const { ctx, scheduled } = makeCtx();
    const opened = await openBscSellerSession(ctx as never, "owner", { op: "pollOwner" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value).toEqual({ ownerId: "owner", token: "tok-2", reauthAttempted: false, dead: false });
    await readBscOrderHistory(ctx as never, opened.value, 0);
    await closeBscSellerSession(ctx, opened.value);
    expect(summaries()[0]).toMatchObject({ op: "pollOwner", calls: 1 });
    expect(scheduled[0].args).toMatchObject({ op: "pollOwner" });
  });

  test("a session that sent nothing writes nothing", async () => {
    const { ctx, scheduled } = makeCtx();
    const opened = await openBscSellerSession(ctx as never, "owner", { op: "drainOwner" });
    if (!opened.ok) throw new Error("expected a session");
    await closeBscSellerSession(ctx, opened.value);
    expect(summaries()).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });
});

describe("flushBscRecorder never throws into its caller", () => {
  test("a refused runAfter is logged and swallowed", async () => {
    const { ctx, runAfter } = makeCtx({
      runAfter: async () => {
        throw new Error("scheduler unavailable");
      },
    });
    const rec = createBscRecorder("fetchBscCardTeamNames");
    rec.ok(rec.start({ pathTemplate: "marketplace/card/:id/card-listing" }), new Response("{}", { status: 200 }));
    await expect(flushBscRecorder(ctx, rec)).resolves.toBeUndefined();
    expect(runAfter).toHaveBeenCalledTimes(1);
    expect(summaries()).toHaveLength(1);
    expect(jsonLines(warns, "bsc_call_summary_not_recorded")).toEqual([
      { msg: "bsc_call_summary_not_recorded", platform: "bsc", operation: "fetchBscCardTeamNames", error: "Error" },
    ]);
  });

  test("no scheduler: the log line only", async () => {
    const rec = createBscRecorder("resolveBscCardTeam");
    rec.ok(rec.start({ pathTemplate: "marketplace/card/:id/card-listing" }), new Response("{}", { status: 200 }));
    await expect(flushBscRecorder(undefined, rec)).resolves.toBeUndefined();
    await expect(flushBscRecorder({ runAction: vi.fn() }, createBscRecorder("x"))).resolves.toBeUndefined();
    expect(summaries()).toEqual([expect.objectContaining({ op: "resolveBscCardTeam", calls: 1, ok: 1 })]);
  });
});
