/**
 * NEO-370 round 3 — the BSC seller client's transport limits:
 *
 *   - every call refuses a redirect (`redirect: "error"`): the bearer token
 *     goes to BSC's API host and nowhere else;
 *   - every answer is read under a byte cap, by `Content-Length` when BSC
 *     sends one and by counting the stream when it does not, and an answer
 *     past the cap is a `bad_response`, never parsed;
 *   - a sheet comes back narrowed, its unreadable rows counted.
 *
 * `fetch` is stubbed; nothing reaches the network.
 */

import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BSC_SELLER_MAX_BYTES,
  readBscOrder,
  readBscSellerSheet,
  readCappedText,
  type BscSellerSession,
} from "./bscSeller";

const session = (): BscSellerSession => ({ ownerId: "owner", token: "tok", reauthAttempted: false, dead: false });
// No call here reaches a 401, so the credential actions are never run.
const ctx = { runAction: vi.fn() } as never;

/** A body delivered in chunks, with no Content-Length. */
function streamed(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCappedText", () => {
  test("a body under the cap reads whole", async () => {
    expect(await readCappedText(new Response("hello"), 5)).toBe("hello");
  });

  test("a declared Content-Length past the cap is refused without reading the body", async () => {
    const res = new Response("small", { headers: { "content-length": "999999" } });
    expect(await readCappedText(res, 100)).toBeNull();
  });

  test("a streamed body that grows past the cap is refused mid-read", async () => {
    const chunk = new Uint8Array(64).fill(65);
    expect(await readCappedText(streamed([chunk, chunk, chunk]), 100)).toBeNull();
    expect(await readCappedText(streamed([chunk]), 100)).toBe("A".repeat(64));
  });

  test("a character split across chunks decodes intact", async () => {
    const bytes = new TextEncoder().encode("Bodø");
    const res = streamed([bytes.slice(0, 4), bytes.slice(4)]);
    expect(await readCappedText(res, 100)).toBe("Bodø");
  });
});

describe("the seller client's calls", () => {
  test("refuse redirects and read the answer under the order cap", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response("x".repeat(BSC_SELLER_MAX_BYTES.order + 1), { status: 200 });
    }) as typeof fetch);
    const r = await readBscOrder(ctx, session(), "o-1");
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("error");
    expect(r).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
    expect(r.ok ? "" : r.failure.message).toMatch(/too large/);
  });

  test("a redirect BSC answers with is a network failure, not a followed request", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed: unexpected redirect");
    }) as typeof fetch);
    const r = await readBscOrder(ctx, session(), "o-1");
    expect(r).toMatchObject({ ok: false, failure: { kind: "network" } });
  });

  test("a sheet comes back narrowed: readable rows kept, the rest counted", async () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      cardId: id,
      price: "0",
      condition: "near_mint",
      availableQuantity: 0,
      card: { id, cardNo: "1" },
      ...over,
    });
    vi.stubGlobal("fetch", (async () =>
      Response.json([row("c1"), row("c2", { sellerSku: "s".repeat(101) }), { junk: true }])) as typeof fetch);
    const r = await readBscSellerSheet(ctx, session(), { filters: {}, condition: "near_mint" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: "narrowed", total: 3, unreadable: 2 });
    expect(r.value.rows.map((x) => x.bscCardId)).toEqual(["c1"]);
  });
});

/**
 * NEO-415 — the drain reads several sheets at once on one session, so
 * several calls can see a 401 together. They share ONE refresh: every call
 * waits on it and retries once with the new token; a refresh that fails marks
 * the session dead once and every call reports `signed_out`.
 */
describe("concurrent calls that see a 401 together", () => {
  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
  const deferred = <T>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  /** A fetch whose answers to the stale token wait for the test to release them. */
  function staleThenFresh() {
    const sent: string[] = [];
    const stale: Array<Deferred<Response>> = [];
    const state = { refuseFresh: false };
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
      sent.push(auth);
      if (auth === "Bearer tok-1") {
        const d = deferred<Response>();
        stale.push(d);
        return d.promise;
      }
      return state.refuseFresh ? new Response("", { status: 401 }) : Response.json([]);
    }) as typeof fetch;
    return { sent, stale, fetchStub, state };
  }

  /** The two credential actions, by name; the refresh waits for the test. */
  function credentials(refreshed: boolean) {
    const calls = { refresh: 0, token: 0 };
    const refreshGate = deferred<void>();
    const runAction = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never);
      if (name === "credentials:refreshSiteTokenForUser") {
        calls.refresh += 1;
        await refreshGate.promise;
        return { refreshed };
      }
      if (name === "credentials:getSiteTokenForUser") {
        calls.token += 1;
        return { token: "tok-2" };
      }
      throw new Error(`unexpected action ${name}`);
    });
    return { calls, refreshGate, ctx: { runAction } as never };
  }

  const read = (c: never, s: BscSellerSession, condition: string) =>
    readBscSellerSheet(c, s, { filters: {}, condition });

  const reauthLogs = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((args: unknown[]) => String(args[0]).includes('"operation":"reauth"')).length;

  test("share one refresh, and every call retries once with the new token and succeeds", async () => {
    const bsc = staleThenFresh();
    vi.stubGlobal("fetch", bsc.fetchStub);
    const cred = credentials(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = session();
    s.token = "tok-1";

    const reads = [read(cred.ctx, s, "near_mint"), read(cred.ctx, s, "excellent"), read(cred.ctx, s, "very_good")];
    await vi.waitFor(() => expect(bsc.stale).toHaveLength(3));
    // Two 401s land while the refresh is still running...
    bsc.stale[0].resolve(new Response("", { status: 401 }));
    bsc.stale[1].resolve(new Response("", { status: 401 }));
    await vi.waitFor(() => expect(cred.calls.refresh).toBe(1));
    cred.refreshGate.resolve();
    // ...and the third after it finished: the token already moved on, so it
    // retries with the new one rather than refreshing again.
    await vi.waitFor(() => expect(s.token).toBe("tok-2"));
    bsc.stale[2].resolve(new Response("", { status: 401 }));

    const results = await Promise.all(reads);
    const reauths = reauthLogs(log);
    log.mockRestore();
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(cred.calls.refresh).toBe(1);
    expect(s).toMatchObject({ token: "tok-2", reauthAttempted: true, dead: false });
    expect(bsc.sent).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-1", "Bearer tok-2", "Bearer tok-2", "Bearer tok-2"]);
    expect(reauths).toBe(1);

    // A call sent on the refreshed token that BSC still refuses kills the
    // session: no second refresh, no retry.
    bsc.state.refuseFresh = true;
    expect(await read(cred.ctx, s, "poor")).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(cred.calls.refresh).toBe(1);
    expect(bsc.sent).toHaveLength(7);
    expect(s.dead).toBe(true);
  });

  test("a refresh that fails marks the session dead once, and every call reports signed_out without a retry", async () => {
    const bsc = staleThenFresh();
    vi.stubGlobal("fetch", bsc.fetchStub);
    const cred = credentials(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const s = session();
    s.token = "tok-1";
    // Count every write that marks the session dead.
    let deadValue = false;
    let deadMarks = 0;
    Object.defineProperty(s, "dead", {
      get: () => deadValue,
      set: (v: boolean) => {
        if (v) deadMarks += 1;
        deadValue = v;
      },
    });

    const reads = [read(cred.ctx, s, "near_mint"), read(cred.ctx, s, "excellent"), read(cred.ctx, s, "very_good")];
    await vi.waitFor(() => expect(bsc.stale).toHaveLength(3));
    bsc.stale[0].resolve(new Response("", { status: 401 }));
    bsc.stale[1].resolve(new Response("", { status: 401 }));
    await vi.waitFor(() => expect(cred.calls.refresh).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    // The second 401 waits on the refresh; it does not call the session dead.
    expect(s.dead).toBe(false);
    cred.refreshGate.resolve();
    await vi.waitFor(() => expect(s.dead).toBe(true));
    bsc.stale[2].resolve(new Response("", { status: 401 }));

    const results = await Promise.all(reads);
    const reauths = reauthLogs(log);
    log.mockRestore();
    for (const r of results) expect(r).toMatchObject({ ok: false, failure: { kind: "signed_out", httpStatus: 401 } });
    expect(cred.calls.refresh).toBe(1);
    expect(cred.calls.token).toBe(0);
    expect(s).toMatchObject({ token: "tok-1", reauthAttempted: true, dead: true });
    expect(deadMarks).toBe(1);
    // Only the three first requests: nothing was retried on a dead session.
    expect(bsc.sent).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-1"]);
    expect(reauths).toBe(1);
    // A later call sends nothing at all.
    expect(await read(cred.ctx, s, "poor")).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(bsc.sent).toHaveLength(3);
  });
});
