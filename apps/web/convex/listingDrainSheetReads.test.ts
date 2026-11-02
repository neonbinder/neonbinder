/**
 * NEO-415 — the drain's sheet reads (`readBscSheets`) run concurrently.
 *
 * A sheet read takes seconds on BSC's side and a full read of a modern
 * variant is four of them, so the drain issues them together (up to
 * `BSC_SHEET_READ_CONCURRENCY` at once) and then folds the answers in
 * condition × request order. What that fold returns must be exactly what
 * reading them one by one returned:
 *   - more than one read is in flight at once, never more than the cap;
 *   - the narrowed sheet is the serial one whatever order BSC answers in,
 *     including which row wins a product id two sheets share;
 *   - the failure returned is the first in condition × request order, even
 *     when a later read fails first, and no new read starts after a failure.
 *
 * `fetch` is stubbed with answers the test releases by hand; nothing reaches
 * the network and no read in these tests sees a 401.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { BscSellerSession } from "./adapters/bscSeller";
import { BSC_SHEET_READ_CONCURRENCY, readBscSheets } from "./listingDrain";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One sheet request BSC has received and not yet answered. */
interface PendingRead {
  condition: string;
  filters: Record<string, string[]>;
  answer: Deferred<Response>;
}

/** A BSC whose sheet answers wait for the test; tracks how many are in flight. */
function heldBsc() {
  const reads: PendingRead[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/seller/bulk-upload/results")) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init?.body)) as { condition: string; filters: Record<string, string[]> };
    const answer = deferred<Response>();
    reads.push({ condition: body.condition, filters: body.filters, answer });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await answer.promise;
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return {
    reads,
    fetchStub,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const row = (productId: string, bscCardId: string, condition: string, availableQuantity: number) => ({
  productId,
  productType: "raw",
  cardId: bscCardId,
  price: "0",
  condition,
  availableQuantity,
  card: { id: bscCardId, cardNo: bscCardId.replace(/\D/g, "") || "1" },
});

const session = (): BscSellerSession => ({ ownerId: "owner", token: "tok", reauthAttempted: false, dead: false });
// No read here sees a 401, so the credential actions are never run.
const ctx = { runAction: vi.fn(), runQuery: vi.fn(), runMutation: vi.fn() } as never;

const TEAM_A = { team: ["a"] };
const TEAM_B = { team: ["b"] };

/**
 * Two facet requests per condition. Both requests of a condition carry the
 * shared product `p-shared-<condition>` with different quantities, so the
 * row that wins it says which sheet was folded first.
 */
function answerFor(read: PendingRead): Response {
  const team = read.filters.team?.[0] ?? "?";
  const qty = team === "a" ? 1 : 2;
  return Response.json([
    row(`p-shared-${read.condition}`, "bsc-1", read.condition, qty),
    row(`p-${team}-${read.condition}`, `bsc-${team === "a" ? 2 : 3}`, read.condition, 0),
  ]);
}

async function settle(bsc: ReturnType<typeof heldBsc>, expected: number, order: (reads: PendingRead[]) => PendingRead[]) {
  await vi.waitFor(() => expect(bsc.reads).toHaveLength(expected));
  for (const read of order([...bsc.reads])) {
    read.answer.resolve(answerFor(read));
    // Let that answer be read and narrowed before the next is released.
    await new Promise((r) => setTimeout(r, 0));
  }
}

const CONDITIONS = ["near_mint", "excellent"];
const REQUESTS = [TEAM_A, TEAM_B];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readBscSheets: concurrent reads", () => {
  test("has more than one read in flight at once, and never more than the cap", async () => {
    const bsc = heldBsc();
    vi.stubGlobal("fetch", bsc.fetchStub);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const conditions = ["near_mint", "excellent", "very_good", "poor"];
    const pending = readBscSheets(ctx, session(), REQUESTS, conditions);

    // Every condition × request is 8 reads; the cap is how many start at once.
    await vi.waitFor(() => expect(bsc.reads).toHaveLength(BSC_SHEET_READ_CONCURRENCY));
    expect(BSC_SHEET_READ_CONCURRENCY).toBeGreaterThan(1);
    // Release them one at a time; each answer lets exactly one more start.
    for (let released = 0; released < 8; released += 1) {
      await vi.waitFor(() => expect(bsc.reads.length).toBeGreaterThan(released));
      bsc.reads[released].answer.resolve(answerFor(bsc.reads[released]));
    }
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(bsc.reads).toHaveLength(8);
    expect(bsc.maxInFlight).toBe(BSC_SHEET_READ_CONCURRENCY);
    // Started in condition × request order.
    expect(bsc.reads.map((x) => `${x.condition}/${x.filters.team[0]}`)).toEqual(
      conditions.flatMap((c) => [`${c}/a`, `${c}/b`]),
    );
  });

  test("the narrowed sheet is the serial one whatever order BSC answers in, the same row winning a shared product", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const inOrder = heldBsc();
    vi.stubGlobal("fetch", inOrder.fetchStub);
    const serialPending = readBscSheets(ctx, session(), REQUESTS, CONDITIONS);
    await settle(inOrder, 4, (reads) => reads);
    const serial = await serialPending;

    const reversed = heldBsc();
    vi.stubGlobal("fetch", reversed.fetchStub);
    const reversedPending = readBscSheets(ctx, session(), REQUESTS, CONDITIONS);
    await settle(reversed, 4, (reads) => reads.reverse());
    const concurrent = await reversedPending;

    expect(serial.ok && concurrent.ok).toBe(true);
    if (!serial.ok || !concurrent.ok) return;
    expect(concurrent.sheet).toEqual(serial.sheet);
    // The shared product's row comes from request A (quantity 1), the first
    // in order, though request B's answer arrived first.
    const shared = concurrent.sheet.rows.filter((r) => String(r.raw.productId).startsWith("p-shared-"));
    expect(shared.map((r) => [r.raw.productId, r.quantity])).toEqual([
      ["p-shared-near_mint", 1],
      ["p-shared-excellent", 1],
    ]);
    expect(concurrent.sheet.rows.map((r) => r.raw.productId)).toEqual([
      "p-shared-near_mint",
      "p-a-near_mint",
      "p-b-near_mint",
      "p-shared-excellent",
      "p-a-excellent",
      "p-b-excellent",
    ]);
    expect(concurrent.sheet.total).toBe(8);
  });

  test("returns the first failure in order even when a later read fails first, and starts no read after a failure", async () => {
    const bsc = heldBsc();
    vi.stubGlobal("fetch", bsc.fetchStub);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const conditions = ["near_mint", "excellent", "very_good"];
    const pending = readBscSheets(ctx, session(), REQUESTS, conditions);

    await vi.waitFor(() => expect(bsc.reads).toHaveLength(BSC_SHEET_READ_CONCURRENCY));
    // Read 2 (excellent / a) fails first...
    bsc.reads[2].answer.resolve(new Response("", { status: 503 }));
    await new Promise((r) => setTimeout(r, 0));
    // ...then read 1 (near_mint / b), earlier in order, fails too.
    bsc.reads[1].answer.resolve(new Response("", { status: 500 }));
    bsc.reads[0].answer.resolve(answerFor(bsc.reads[0]));
    bsc.reads[3].answer.resolve(answerFor(bsc.reads[3]));

    const r = await pending;
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 500 } });
    // The two very_good reads were never started.
    expect(bsc.reads).toHaveLength(BSC_SHEET_READ_CONCURRENCY);
  });
});
