/**
 * NEO-370 round 3 — the BSC seller client's transport limits:
 *
 *   - every call refuses a redirect (`redirect: "error"`): the bearer token
 *     goes to BSC's API host and nowhere else;
 *   - every answer is read under a byte cap, by `Content-Length` when BSC
 *     sends one and by counting the stream when it does not, and an answer
 *     past the cap is a `bad_response`, never parsed;
 *   - a sheet comes back narrowed, its unreadable rows counted;
 *   - NEO-475: a failure's sentence is NB's (no operation name), and a sheet
 *     read's log line names its condition and attempt;
 *   - NEO-475: the seller profile read is bounded like the login path's
 *     (NEO-445): 5 s per attempt, and a timeout, network error, unreadable
 *     body or 5xx is retried once, at once; a 4xx or a signed-out session is
 *     not.
 *
 * `fetch` is stubbed; nothing reaches the network.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BSC_PROFILE_MAX_ATTEMPTS,
  BSC_SELLER_COPY,
  BSC_SELLER_MAX_BYTES,
  BSC_SELLER_TIMEOUTS_MS,
  fetchBscSellerId,
  putBscListings,
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
    expect(r.ok ? "" : r.failure.message).toBe(BSC_SELLER_COPY.tooBig);
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

describe("NEO-475: what a failure says, and what a sheet read logs", () => {
  /** Every `bsc_seller_call` line while `work` runs. */
  async function sellerLines(work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith('{"msg":"bsc_seller_call"')) lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    try {
      await work();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  test.each([
    [503, BSC_SELLER_COPY.busy],
    [500, "BuySportsCards fumbled that one (error 500)."],
    [404, "BuySportsCards fumbled that one (error 404)."],
  ])("a %i is said in NB's words, with no operation name", async (status, message) => {
    vi.stubGlobal("fetch", (async () => new Response("<html>gateway</html>", { status })) as typeof fetch);
    const sheet = await readBscSellerSheet(ctx, session(), { filters: {}, condition: "excellent" });
    const put = await putBscListings(ctx, session(), { sellerId: "s-1", listings: [] });
    for (const r of [sheet, put]) {
      expect(r).toEqual({ ok: false, failure: { kind: "http", httpStatus: status, message } });
      expect(r.ok ? "" : r.failure.message).not.toMatch(/sheetRead|listingsPut|operation/);
    }
  });

  test("a timeout, before the answer or while its body streams, is said in NB's words", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch);
    expect(await readBscSellerSheet(ctx, session(), { filters: {}, condition: "excellent" })).toEqual({
      ok: false,
      failure: { kind: "timeout", message: BSC_SELLER_COPY.timeout },
    });

    vi.stubGlobal("fetch", (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(Object.assign(new Error("body timed out"), { name: "TimeoutError" }));
          },
        }),
        { status: 200 },
      )) as typeof fetch);
    expect(await readBscSellerSheet(ctx, session(), { filters: {}, condition: "excellent" })).toEqual({
      ok: false,
      failure: { kind: "timeout", httpStatus: 200, message: BSC_SELLER_COPY.timeout },
    });
  });

  test("a 2xx body that is not JSON, or fails while streaming, is said in NB's words", async () => {
    vi.stubGlobal("fetch", (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch);
    expect(await readBscOrder(ctx, session(), "o-1")).toEqual({
      ok: false,
      failure: { kind: "bad_response", httpStatus: 200, message: BSC_SELLER_COPY.garbled },
    });
    vi.stubGlobal("fetch", (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
        { status: 200 },
      )) as typeof fetch);
    expect(await readBscSellerSheet(ctx, session(), { filters: {}, condition: "excellent" })).toEqual({
      ok: false,
      failure: { kind: "bad_response", httpStatus: 200, message: BSC_SELLER_COPY.garbled },
    });
  });

  test("the copy is short, ends in one full stop, and names no internal word", () => {
    for (const line of [
      BSC_SELLER_COPY.busy,
      BSC_SELLER_COPY.timeout,
      BSC_SELLER_COPY.http(500),
      BSC_SELLER_COPY.garbled,
      BSC_SELLER_COPY.tooBig,
    ]) {
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line).toMatch(/[^.]\.$/);
      expect(line).not.toMatch(/sheet|read|operation|503|gateway|api/i);
    }
  });

  test("a sheet read's line names its condition and attempt (1 when the caller gives none); other calls carry neither", async () => {
    vi.stubGlobal("fetch", (async (url: string | URL | Request) =>
      String(url).endsWith("seller/bulk-upload") ? Response.json({}) : Response.json([])) as typeof fetch);
    const lines = await sellerLines(async () => {
      await readBscSellerSheet(ctx, session(), { filters: {}, condition: "near_mint" });
      await readBscSellerSheet(ctx, session(), { filters: {}, condition: "ex", attempt: 3 });
      await putBscListings(ctx, session(), { sellerId: "s-1", listings: [] });
    });
    expect(lines).toEqual([
      expect.objectContaining({ operation: "sheetRead", condition: "near_mint", attempt: 1, outcome: "ok", httpStatus: 200 }),
      expect.objectContaining({ operation: "sheetRead", condition: "ex", attempt: 3, outcome: "ok" }),
      expect.objectContaining({ operation: "listingsPut", outcome: "ok" }),
    ]);
    expect(lines[2]).not.toHaveProperty("condition");
    expect(lines[2]).not.toHaveProperty("attempt");
    expect(Object.keys(lines[0]).sort()).toEqual(
      ["attempt", "condition", "durationMs", "httpStatus", "msg", "operation", "outcome", "platform"].sort(),
    );
  });

  test("a failed sheet read's line keeps its condition and attempt", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    const lines = await sellerLines(() => readBscSellerSheet(ctx, session(), { filters: {}, condition: "excellent", attempt: 2 }));
    expect(lines).toEqual([expect.objectContaining({ operation: "sheetRead", condition: "excellent", attempt: 2, outcome: "network" })]);
  });
});

describe("NEO-475: the seller profile read (5 s per attempt, one immediate retry)", () => {
  type Answer = "timeout" | "network" | "garbled" | number | "ok";
  const PROFILE = Response.json({ sellerProfile: { sellerId: "seller-9" } });

  /** Answers each profile request from `script` in turn; records each request's timeout. */
  function scriptProfile(script: Answer[]) {
    const asked: string[] = [];
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      asked.push(String(url));
      const answer = script.shift() ?? "ok";
      if (answer === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (answer === "network") throw new TypeError("fetch failed");
      if (answer === "garbled") return new Response("<html>not json</html>", { status: 200 });
      if (typeof answer === "number") return new Response("<html>nope</html>", { status: answer });
      return PROFILE.clone();
    }) as typeof fetch);
    return { asked, timeouts };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Every `bsc_seller_call` line for the profile while `work` runs. */
  async function profileLines(work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.startsWith('{"msg":"bsc_seller_call"')) lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    try {
      await work();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  test("the bound is the login path's: 5 s per attempt, two attempts", () => {
    expect(BSC_SELLER_TIMEOUTS_MS.profile).toBe(5_000);
    expect(BSC_PROFILE_MAX_ATTEMPTS).toBe(2);
  });

  test("a timeout, then an answer: the retry reads the seller id, each attempt under 5 s, each logged with its attempt", async () => {
    const { asked, timeouts } = scriptProfile(["timeout", "ok"]);
    let r: Awaited<ReturnType<typeof fetchBscSellerId>> | undefined;
    const lines = await profileLines(async () => {
      r = await fetchBscSellerId(ctx, session());
    });
    expect(r).toEqual({ ok: true, value: "seller-9" });
    expect(asked).toHaveLength(2);
    expect(asked.every((u) => u.endsWith("/marketplace/user/profile"))).toBe(true);
    expect(timeouts).toEqual([5_000, 5_000]);
    expect(lines).toEqual([
      expect.objectContaining({ operation: "sellerProfile", attempt: 1, outcome: "timeout" }),
      expect.objectContaining({ operation: "sellerProfile", attempt: 2, outcome: "ok", httpStatus: 200 }),
    ]);
    expect(lines[0]).not.toHaveProperty("condition");
  });

  test("an answer first time is one request", async () => {
    const { asked } = scriptProfile(["ok"]);
    expect(await fetchBscSellerId(ctx, session())).toEqual({ ok: true, value: "seller-9" });
    expect(asked).toHaveLength(1);
  });

  test("two timeouts: no third request, and the caller gets the timeout in NB's words", async () => {
    const { asked } = scriptProfile(["timeout", "timeout", "ok"]);
    expect(await fetchBscSellerId(ctx, session())).toEqual({
      ok: false,
      failure: { kind: "timeout", message: BSC_SELLER_COPY.timeout },
    });
    expect(asked).toHaveLength(2);
  });

  test.each<[string, Answer]>([
    ["a network error", "network"],
    ["an unreadable body", "garbled"],
    ["a 503", 503],
    ["a 500", 500],
  ])("%s is retried at once", async (_label, first) => {
    const { asked } = scriptProfile([first, "ok"]);
    expect(await fetchBscSellerId(ctx, session())).toEqual({ ok: true, value: "seller-9" });
    expect(asked).toHaveLength(2);
  });

  test("a 503 on both attempts fails as busy after two requests", async () => {
    const { asked } = scriptProfile([503, 503, "ok"]);
    expect(await fetchBscSellerId(ctx, session())).toEqual({
      ok: false,
      failure: { kind: "http", httpStatus: 503, message: BSC_SELLER_COPY.busy },
    });
    expect(asked).toHaveLength(2);
  });

  test.each([400, 403, 404])("a %i is BSC refusing the request: not retried", async (status) => {
    const { asked } = scriptProfile([status, "ok"]);
    expect(await fetchBscSellerId(ctx, session())).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: status } });
    expect(asked).toHaveLength(1);
  });

  test("a 401 takes the session's one refresh inside the attempt; refused again, the session is dead and no profile retry follows", async () => {
    const runAction = vi.fn(async () => ({ token: "tok-2", refreshed: true }));
    const { asked } = scriptProfile([401, 401, "ok"]);
    const s = session();
    expect(await fetchBscSellerId({ runAction } as never, s)).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(asked).toHaveLength(2);
    expect(s.dead).toBe(true);
  });

  test("the retry is immediate: it lands with the fake clock never advanced and no timer left behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] });
    const { asked } = scriptProfile(["timeout", "ok"]);
    expect(await fetchBscSellerId(ctx, session())).toEqual({ ok: true, value: "seller-9" });
    expect(asked).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // NEO-483: the background read (`bscSellerId.ts`) owns its own schedule.
  describe("the options argument (the background read's single, longer attempt)", () => {
    test("attempts: 1 stops after one request, however retryable the failure", async () => {
      const { asked } = scriptProfile(["timeout", "ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts: 1 })).toEqual({
        ok: false,
        failure: { kind: "timeout", message: BSC_SELLER_COPY.timeout },
      });
      expect(asked).toHaveLength(1);
    });

    test.each<[string, Answer]>([
      ["a network error", "network"],
      ["an unreadable body", "garbled"],
      ["a 503", 503],
    ])("attempts: 1 does not retry %s", async (_label, first) => {
      const { asked } = scriptProfile([first, "ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts: 1 })).toMatchObject({ ok: false });
      expect(asked).toHaveLength(1);
    });

    test("attempts: 1 with an answer first time reads the id in one request", async () => {
      const { asked } = scriptProfile(["ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts: 1 })).toEqual({ ok: true, value: "seller-9" });
      expect(asked).toHaveLength(1);
    });

    test("a 429 is one request and a plain http failure", async () => {
      const { asked } = scriptProfile([429, "ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts: 1 })).toMatchObject({
        ok: false,
        failure: { kind: "http", httpStatus: 429 },
      });
      expect(asked).toHaveLength(1);
    });

    test("timeoutMs replaces the 5 s limit on the request", async () => {
      const { timeouts } = scriptProfile(["ok"]);
      await fetchBscSellerId(ctx, session(), { attempts: 1, timeoutMs: 20_000 });
      expect(timeouts).toEqual([20_000]);
    });

    test("attempts: 3 allows a third request after two retryable failures", async () => {
      const { asked } = scriptProfile(["timeout", 503, "ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts: 3 })).toEqual({ ok: true, value: "seller-9" });
      expect(asked).toHaveLength(3);
    });

    test.each([0, -4])("attempts: %i still makes the one request (never none)", async (attempts) => {
      const { asked } = scriptProfile(["ok"]);
      expect(await fetchBscSellerId(ctx, session(), { attempts })).toEqual({ ok: true, value: "seller-9" });
      expect(asked).toHaveLength(1);
    });

    test("omitted options keep today's bounds: two attempts, 5 s each", async () => {
      const { asked, timeouts } = scriptProfile(["timeout", "timeout", "ok"]);
      await fetchBscSellerId(ctx, session(), {});
      expect(asked).toHaveLength(2);
      expect(timeouts).toEqual([5_000, 5_000]);
    });

    test("a custom timeoutMs applies to the retry too", async () => {
      const { timeouts } = scriptProfile(["timeout", "ok"]);
      await fetchBscSellerId(ctx, session(), { timeoutMs: 1_234 });
      expect(timeouts).toEqual([1_234, 1_234]);
    });
  });

  test("a sellerProfile with no usable id is an answer, not a failure: not retried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sellerProfile: { sellerId: "has spaces" } })) as unknown as typeof fetch);
    expect(await fetchBscSellerId(ctx, session())).toEqual({ ok: true, value: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
