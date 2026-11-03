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
