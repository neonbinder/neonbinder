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
 *     read's log line names its condition and attempt.
 *
 * `fetch` is stubbed; nothing reaches the network.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BSC_SELLER_COPY,
  BSC_SELLER_MAX_BYTES,
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
