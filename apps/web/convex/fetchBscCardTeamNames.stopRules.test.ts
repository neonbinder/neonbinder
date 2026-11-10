/**
 * PR 451 (NEO-487) — when `fetchBscCardTeamNames` stops asking BSC.
 *
 * BSC's edge answers 429 and then blocks the IP, and Convex deployments share
 * egress IPs, so asking on only extends the block. The lookup therefore:
 *   - reads the deployment-wide cooldown before EVERY wave (10 cards) and
 *     makes no call while it is open;
 *   - stops at the first 429, never retries it, and records it exactly once;
 *   - stops after a wave in which EVERY card failed (BSC is down);
 *   - hands every card it never asked back as `success: false, skipped: true`.
 * The healthy path writes nothing.
 *
 * Driven through the real action with `fetch` stubbed; the cooldown table is
 * the real one (convex-test). Lives at the convex/ root for the glob (see
 * bscCallTelemetry.adapters.test.ts).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { resetBscInflightForTests } from "./lib/bscCallTelemetry";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** One wave is this many cards (BSC_TEAM_LOOKUP_CONCURRENCY, private to the adapter). */
const WAVE = 10;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `bsc-${i + 1}`);

type Reply = { team: string } | { status: number; headers?: Record<string, string> };
type Calls = string[];

function fetchStub(replyFor: (bscCardId: string, nth: number) => Reply, calls: Calls, onCall?: (id: string) => Promise<void>) {
  const seen = new Map<string, number>();
  return vi.fn(async (url: string | URL | Request) => {
    const id = String(url).match(/\/marketplace\/card\/([^/]+)\/card-listing/)?.[1] ?? "";
    calls.push(id);
    const nth = (seen.get(id) ?? 0) + 1;
    seen.set(id, nth);
    await onCall?.(id);
    const reply = replyFor(id, nth);
    if ("status" in reply) return new Response("", { status: reply.status, headers: reply.headers });
    return new Response(JSON.stringify({ teamName: reply.team }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const run = (t: ReturnType<typeof convexTest>, bscCardIds: string[]) =>
  t.action(internal.adapters.buysportscards.fetchBscCardTeamNames, { bscCardIds });
const cooldownRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("marketplaceCooldowns").collect());
const openWindow = (t: ReturnType<typeof convexTest>, until: number) =>
  t.run(async (ctx) =>
    ctx.db.insert("marketplaceCooldowns", {
      platform: "bsc", endpoint: "cardListing", until, last429At: Date.now(), streak: 1, updatedAt: Date.now(),
    }),
  );

const SKIPPED = (bscCardId: string) => ({
  bscCardId, rawTeamName: "", teamNames: [], success: false, attributeTokens: [], skipped: true,
});

beforeEach(() => {
  resetBscInflightForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchBscCardTeamNames — a 429 stops the lookup at once", () => {
  test("the 429 card is asked once (never retried), is failed not skipped, and later waves are never asked", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal(
      "fetch",
      fetchStub((id) => (id === "bsc-1" ? { status: 429 } : { team: `Team ${id}` }), calls),
    );

    const out = await run(t, ids(WAVE + 2));

    expect(calls.filter((c) => c === "bsc-1")).toHaveLength(1);
    // Wave 1 went out together; wave 2 was never asked.
    expect(calls.sort()).toEqual(ids(WAVE).sort());
    expect(out[0]).toMatchObject({ bscCardId: "bsc-1", success: false });
    expect(out[0].skipped).toBeUndefined();
    expect(out[1]).toMatchObject({ bscCardId: "bsc-2", success: true, rawTeamName: "Team bsc-2" });
    expect(out.slice(WAVE)).toEqual([SKIPPED("bsc-11"), SKIPPED("bsc-12")]);
  });

  test("it records one cooldown, and the window follows BSC's Retry-After when that is longer", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    // Every card in the wave gets 429: still ONE window, recorded once.
    vi.stubGlobal("fetch", fetchStub(() => ({ status: 429, headers: { "Retry-After": "180" } }), calls));
    const before = Date.now();

    await run(t, ids(WAVE));

    const rows = await cooldownRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].streak).toBe(1);
    expect(rows[0].until).toBeGreaterThanOrEqual(before + 180_000);
    expect(rows[0].until).toBeLessThan(Date.now() + 180_000 + 1);
  });

  test("a card in its retry pause does not retry once another card has been 429'd", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal(
      "fetch",
      fetchStub((id) => (id === "bsc-1" ? { status: 503 } : id === "bsc-2" ? { status: 429 } : { team: "Reds" }), calls),
    );

    const out = await run(t, ["bsc-1", "bsc-2", "bsc-3"]);

    // bsc-1 failed its first attempt, paused 250-500 ms, saw the stop flag and did not ask again.
    expect(calls.filter((c) => c === "bsc-1")).toHaveLength(1);
    expect(out.map((o) => o.success)).toEqual([false, false, true]);
    expect(await cooldownRows(t)).toHaveLength(1);
  });
});

describe("fetchBscCardTeamNames — the cooldown is read before every wave", () => {
  test("an open window at the start: no BSC call, nothing written, every card skipped in request order", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    const stub = fetchStub(() => ({ team: "Reds" }), calls);
    vi.stubGlobal("fetch", stub);
    await openWindow(t, Date.now() + 60_000);
    const before = await cooldownRows(t);

    const out = await run(t, ids(WAVE + 3));

    expect(calls).toEqual([]);
    expect(out).toEqual(ids(WAVE + 3).map(SKIPPED));
    // The window was already open: it is neither extended nor re-recorded.
    expect(await cooldownRows(t)).toEqual(before);
  });

  test("a window that lapsed is open road", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal("fetch", fetchStub(() => ({ team: "Reds" }), calls));
    await openWindow(t, Date.now() - 1);

    const out = await run(t, ["bsc-1"]);

    expect(calls).toEqual(["bsc-1"]);
    expect(out[0]).toMatchObject({ success: true });
  });

  test("a window another caller opens while wave 1 is out stops wave 2 before any call", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    let opened = false;
    vi.stubGlobal(
      "fetch",
      fetchStub(() => ({ team: "Reds" }), calls, async () => {
        if (opened) return;
        opened = true;
        await openWindow(t, Date.now() + 60_000);
      }),
    );

    const out = await run(t, ids(WAVE + 2));

    expect(calls.sort()).toEqual(ids(WAVE).sort());
    expect(out.slice(0, WAVE).every((o) => o.success)).toBe(true);
    expect(out.slice(WAVE)).toEqual([SKIPPED("bsc-11"), SKIPPED("bsc-12")]);
  });

  test("the healthy path writes no cooldown row", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", fetchStub(() => ({ team: "Reds" }), []));
    await run(t, ids(WAVE + 5));
    expect(await cooldownRows(t)).toEqual([]);
  });
});

describe("fetchBscCardTeamNames — a wave in which every card failed stops the lookup", () => {
  test("BSC down: wave 1 fails both attempts, wave 2 is skipped and never asked, no cooldown is recorded", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal("fetch", fetchStub(() => ({ status: 503 }), calls));

    const out = await run(t, ids(WAVE + 2));

    // Ten cards, two attempts each, and nothing from wave 2.
    expect(calls).toHaveLength(WAVE * 2);
    expect(calls.some((c) => c === "bsc-11" || c === "bsc-12")).toBe(false);
    expect(out.slice(0, WAVE).every((o) => o.success === false && o.skipped === undefined)).toBe(true);
    expect(out.slice(WAVE)).toEqual([SKIPPED("bsc-11"), SKIPPED("bsc-12")]);
    // A 5xx is not a 429: no window.
    expect(await cooldownRows(t)).toEqual([]);
  });

  test("one answered card in the wave keeps the lookup going", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal(
      "fetch",
      fetchStub((id) => (id === "bsc-1" ? { team: "Reds" } : { status: 503 }), calls),
    );

    const out = await run(t, ids(WAVE + 2));

    expect(calls.some((c) => c === "bsc-11")).toBe(true);
    expect(out.some((o) => o.skipped)).toBe(false);
  });

  test("a permanent 4xx (not 429) is a failure that is neither retried nor a cooldown", async () => {
    const t = convexTest(schema, modules);
    const calls: Calls = [];
    vi.stubGlobal("fetch", fetchStub(() => ({ status: 404 }), calls));

    const out = await run(t, ids(WAVE + 1));

    expect(calls).toHaveLength(WAVE); // one attempt each, wave 2 skipped
    expect(out[WAVE]).toEqual(SKIPPED("bsc-11"));
    expect(await cooldownRows(t)).toEqual([]);
  });
});
