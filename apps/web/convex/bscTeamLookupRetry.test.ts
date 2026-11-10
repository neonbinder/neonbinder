/**
 * NEO-475 — the card team lookup (`card-listing`) follows the house rule for
 * BSC calls: 5 s per attempt, one retry.
 *
 *   - a timeout, a network error, a 5xx, or a 2xx whose body will not parse is
 *     retried once, after a 250-500 ms pause;
 *   - a 4xx is BSC's answer about the card and is not retried;
 *   - the lookup fails (the card goes to the operator teamless, rule 8) only
 *     when both attempts fail;
 *   - each attempt is its own call on the invocation's one recorder, with
 *     `attempt` 1 or 2 and `timeoutMs` 5000.
 *
 * Driven through `fetchBscCardTeamNames` (the synchronous checklist path);
 * `resolveBscCardTeam` (the background queue) calls the same function and is
 * covered in `bscTeamEnrichmentQueue.test.ts`. Lives at the convex/ root for
 * the convex-test glob (see `bscCallTelemetry.adapters.test.ts`). `fetch` is
 * stubbed throughout.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { resetBscInflightForTests, type BscCallMeta } from "./lib/bscCallTelemetry";
import {
  BSC_TEAM_LOOKUP_MAX_ATTEMPTS,
  BSC_TEAM_LOOKUP_RETRY_PAUSE_MAX_MS,
  BSC_TEAM_LOOKUP_RETRY_PAUSE_MIN_MS,
  BSC_TEAM_LOOKUP_TIMEOUT_MS,
  bscTeamLookupRetryPauseMs,
} from "./adapters/buysportscards";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/**
 * Every `start` the adapter makes, by op. A pass-through: the recorder is the
 * real one, so the summary row and failure lines are what production writes.
 * This is the only place an ANSWERED attempt's `attempt` number is visible
 * (the summary counts calls; only failures carry a sample).
 */
const started = vi.hoisted(() => [] as Array<{ op: string; meta: Record<string, unknown> }>);
vi.mock("./lib/bscCallTelemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/bscCallTelemetry")>();
  return {
    ...actual,
    createBscRecorder: (...args: Parameters<typeof actual.createBscRecorder>) => {
      const rec = actual.createBscRecorder(...args);
      return {
        ...rec,
        start: (meta: BscCallMeta) => {
          started.push({ op: args[0], meta: { ...meta } });
          return rec.start(meta);
        },
      };
    },
  };
});

/** What one stubbed `card-listing` call does. */
type Step =
  | { status: number; body?: string }
  | { team: string }
  | "timeout"
  | "network";

function respond(step: Step): Response {
  if (step === "timeout") {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }
  if (step === "network") throw new TypeError("fetch failed");
  if ("team" in step) return Response.json({ teamName: step.team });
  return new Response(step.body ?? "", { status: step.status, headers: { "content-type": "text/plain" } });
}

/** Per card id, one step per call in order; a call past the plan fails the test. */
function stubCards(plan: Record<string, Step[]>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const id = /\/marketplace\/card\/([^/]+)\/card-listing/.exec(String(url))?.[1] ?? "";
    calls.push(id);
    // Every attempt carries its own abort signal (the 5 s bound). Counted, not
    // asserted here: a throw inside the stub would read as a network error.
    if (!(init?.signal instanceof AbortSignal)) unsignalled += 1;
    const step = plan[id]?.shift();
    if (step === undefined) throw new Error(`unexpected fetch for ${id} (call ${calls.length})`);
    return respond(step);
  }) as typeof fetch);
  return { calls };
}

let warns: string[];
let logs: string[];
let unsignalled = 0;
/** The retry pauses the adapter asked for, with how many fetches had been made. */
let pauses: Array<{ ms: number; afterCalls: number }>;
let callsSoFar: () => number;

beforeEach(() => {
  resetBscInflightForTests();
  started.length = 0;
  unsignalled = 0;
  warns = [];
  logs = [];
  pauses = [];
  callsSoFar = () => -1;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // The retry pause (250-500 ms) is recorded and runs at once; every other
  // timer (the recorder's 2 s body-read deadline) keeps its real delay.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (
      typeof ms === "number" &&
      ms >= BSC_TEAM_LOOKUP_RETRY_PAUSE_MIN_MS &&
      ms <= BSC_TEAM_LOOKUP_RETRY_PAUSE_MAX_MS
    ) {
      pauses.push({ ms, afterCalls: callsSoFar() });
      return realSetTimeout(fn, 0, ...rest);
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
});

afterEach(() => {
  expect(unsignalled).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonLines(lines: string[], msg: string): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.startsWith("{") && l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.msg === msg);
}
const failures = () => jsonLines(warns, "bsc_call_failed");
const summaries = () => jsonLines(logs, "bsc_call_summary");

async function rows(t: ReturnType<typeof convexTest>) {
  await drainScheduled(t);
  return await t.run(async (ctx) => await ctx.db.query("bscCallSummaries").collect());
}

async function lookup(t: ReturnType<typeof convexTest>, ids: string[]) {
  return await t.action(internal.adapters.buysportscards.fetchBscCardTeamNames, { bscCardIds: ids });
}

const cardListingStarts = () =>
  started
    .filter((s) => s.op === "fetchBscCardTeamNames" && s.meta.pathTemplate === "marketplace/card/:id/card-listing")
    .map((s) => ({ bscCardId: s.meta.bscCardId, attempt: s.meta.attempt, timeoutMs: s.meta.timeoutMs }));

// ---------------------------------------------------------------------------

describe("the rule's numbers", () => {
  test("5 s per attempt, two attempts, a 250-500 ms pause: no worse than the old single 10 s attempt plus the pause", () => {
    expect(BSC_TEAM_LOOKUP_TIMEOUT_MS).toBe(5_000);
    expect(BSC_TEAM_LOOKUP_MAX_ATTEMPTS).toBe(2);
    expect(BSC_TEAM_LOOKUP_RETRY_PAUSE_MIN_MS).toBe(250);
    expect(BSC_TEAM_LOOKUP_RETRY_PAUSE_MAX_MS).toBe(500);
    expect(BSC_TEAM_LOOKUP_TIMEOUT_MS * BSC_TEAM_LOOKUP_MAX_ATTEMPTS + BSC_TEAM_LOOKUP_RETRY_PAUSE_MAX_MS).toBe(10_500);
  });

  test("the pause is jittered across 250-500 ms and clamps a stray random()", () => {
    expect(bscTeamLookupRetryPauseMs(() => 0)).toBe(250);
    expect(bscTeamLookupRetryPauseMs(() => 0.5)).toBe(375);
    expect(bscTeamLookupRetryPauseMs(() => 0.999999)).toBe(500);
    expect(bscTeamLookupRetryPauseMs(() => -1)).toBe(250);
    expect(bscTeamLookupRetryPauseMs(() => 2)).toBe(500);
    for (let i = 0; i < 50; i += 1) {
      const ms = bscTeamLookupRetryPauseMs();
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });
});

describe("fetchBscCardTeamNames — one retry per card", () => {
  test("the first attempt times out and the second answers: success, two calls on the summary, attempts 1 and 2", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({ "c-1": ["timeout", { team: "Seattle Mariners" }] });
    callsSoFar = () => calls.length;

    const r = await lookup(t, ["c-1"]);
    expect(r).toEqual([
      {
        bscCardId: "c-1",
        rawTeamName: "Seattle Mariners",
        teamNames: ["Seattle Mariners"],
        success: true,
        attributeTokens: [],
      },
    ]);
    expect(calls).toEqual(["c-1", "c-1"]);
    // The pause fell between the two attempts.
    expect(pauses).toHaveLength(1);
    expect(pauses[0].afterCalls).toBe(1);

    expect(cardListingStarts()).toEqual([
      { bscCardId: "c-1", attempt: 1, timeoutMs: 5_000 },
      { bscCardId: "c-1", attempt: 2, timeoutMs: 5_000 },
    ]);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ op: "fetchBscCardTeamNames", calls: 2, ok: 1, byKind: { timeout: 1 } });
    expect(summaries()).toHaveLength(1);
    expect(failures().map((f) => [f.bscCardId, f.kind, f.attempt, f.timeoutMs])).toEqual([
      ["c-1", "timeout", 1, 5_000],
    ]);
  });

  test("both attempts time out: a failed lookup with no team, exactly two calls", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({ "c-1": ["timeout", "timeout"] });
    callsSoFar = () => calls.length;

    const r = await lookup(t, ["c-1"]);
    expect(r).toEqual([{ bscCardId: "c-1", rawTeamName: "", teamNames: [], success: false, attributeTokens: [] }]);
    expect(calls).toEqual(["c-1", "c-1"]);
    // One pause, before the retry; none after the last attempt.
    expect(pauses.map((p) => p.afterCalls)).toEqual([1]);

    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 2, ok: 0, byKind: { timeout: 2 } });
    expect(failures().map((f) => [f.kind, f.attempt])).toEqual([
      ["timeout", 1],
      ["timeout", 2],
    ]);
    // The adapter's own log line names the attempt, after the pinned marker.
    expect(warns.filter((l) => l.includes("card-listing fetch error bscCardId=c-1"))).toEqual([
      expect.stringContaining("attempt=1/2"),
      expect.stringContaining("attempt=2/2"),
    ]);
  });

  test("a 404 is BSC's answer about the card: not retried, no pause", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({ "c-1": [{ status: 404, body: "not found" }] });

    const r = await lookup(t, ["c-1"]);
    expect(r[0]).toMatchObject({ success: false, rawTeamName: "", teamNames: [] });
    expect(calls).toEqual(["c-1"]);
    expect(pauses).toHaveLength(0);
    expect(cardListingStarts()).toEqual([{ bscCardId: "c-1", attempt: 1, timeoutMs: 5_000 }]);
    const stored = await rows(t);
    expect(stored[0]).toMatchObject({ calls: 1, ok: 0, byStatus: { "404": 1 } });
  });

  test("a 500 is retried once: two 500s fail the lookup, a 500 then an answer succeeds", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({
      "c-1": [{ status: 500, body: "Internal error" }, { status: 500, body: "Internal error" }],
      "c-2": [{ status: 500, body: "Internal error" }, { team: "" }],
    });

    const r = await lookup(t, ["c-1", "c-2"]);
    expect(r.map((x) => [x.bscCardId, x.success])).toEqual([
      ["c-1", false],
      ["c-2", true],
    ]);
    expect(calls.filter((c) => c === "c-1")).toHaveLength(2);
    expect(calls.filter((c) => c === "c-2")).toHaveLength(2);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 4, ok: 1, byStatus: { "500": 3, "200": 1 } });
    expect(failures().map((f) => [f.bscCardId, f.status, f.attempt])).toEqual(
      expect.arrayContaining([
        ["c-1", 500, 1],
        ["c-1", 500, 2],
        ["c-2", 500, 1],
      ]),
    );
  });

  test("a network error, and a 2xx that will not parse, are each retried once", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({
      "c-1": ["network", { team: "Boston Red Sox" }],
      "c-2": [{ status: 200, body: "{not json" }, { team: "New York Yankees" }],
    });

    const r = await lookup(t, ["c-1", "c-2"]);
    expect(r.map((x) => [x.bscCardId, x.success, x.rawTeamName])).toEqual([
      ["c-1", true, "Boston Red Sox"],
      ["c-2", true, "New York Yankees"],
    ]);
    expect(calls).toHaveLength(4);
    const stored = await rows(t);
    expect(stored[0]).toMatchObject({ calls: 4, ok: 2, byKind: { network: 1, parse: 1 } });
  });

  test("a 429 is a 4xx: not retried", async () => {
    const t = convexTest(schema, modules);
    const { calls } = stubCards({ "c-1": [{ status: 429, body: "slow down" }] });
    const r = await lookup(t, ["c-1"]);
    expect(r[0].success).toBe(false);
    expect(calls).toEqual(["c-1"]);
  });
});
