/**
 * NEO-475 — the BSC call recorder wired into `adapters/buysportscards.ts`:
 *
 *   - `fetchBscSelectorOptions` (the filters retry loop),
 *   - `fetchBscChecklist` and `probeBscChecklistBatch` (the checklist
 *     `doFetch`, first send and post-re-auth retry),
 *   - `fetchBscCardTeamNames` (card-listing, one recorder across chunks).
 *
 * For each: ok, http, timeout and network outcomes are recorded (and
 * body_timeout / parse after a 2xx), the caller's own reading of a non-2xx
 * body is untouched by the recorder's clone, the action's result is what it
 * was, and exactly ONE `bscCallSummaries` row (one `bsc_call_summary` line) is
 * written per invocation.
 *
 * Lives at the convex/ root, not under convex/adapters/: convex-test's
 * `import.meta.glob` registry breaks when invoked from inside adapters/ (see
 * `fetchBscCardTeamNames.test.ts`). `fetch` is stubbed throughout.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { resetBscInflightForTests } from "./lib/bscCallTelemetry";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo475",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo475",
  name: "Admin",
  role: "admin",
};

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-bsc-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

/** What one stubbed BSC call does. */
type Step =
  | { status: number; body?: string; contentType?: string }
  | { json: unknown }
  | "timeout"
  | "network";

function respond(step: Step): Response {
  if (step === "timeout") {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }
  if (step === "network") throw new TypeError("fetch failed");
  if ("json" in step) return Response.json(step.json);
  return new Response(step.body ?? "", {
    status: step.status,
    headers: { "content-type": step.contentType ?? "text/plain", server: "awselb/2.0" },
  });
}

/** Stub fetch with one step per call, in order. Records the URLs. */
function stubSteps(steps: Step[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
    urls.push(String(url));
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected fetch ${String(url)}`);
    return respond(step);
  }) as typeof fetch);
  return urls;
}

let logs: string[];
let warns: string[];
let errors: string[];

beforeEach(() => {
  resetBscInflightForTests();
  logs = [];
  warns = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  vi.spyOn(console, "info").mockImplementation(() => {});
  // The selector loop's backoff (500 ms, 1000 ms) runs instantly; every other
  // timer keeps its real delay.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms === 500 || ms === 1000 ? 0 : ms, ...rest)) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonLines(lines: string[], msg: string): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.startsWith("{") && l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.msg === msg);
}
const summaries = () => jsonLines(logs, "bsc_call_summary");
const failures = () => jsonLines(warns, "bsc_call_failed");

async function rows(t: ReturnType<typeof convexTest>) {
  await drainScheduled(t);
  return await t.run(async (ctx) => await ctx.db.query("bscCallSummaries").collect());
}

// ---------------------------------------------------------------------------

describe("fetchBscSelectorOptions — the filters retry loop", () => {
  const call = (t: ReturnType<typeof convexTest>) =>
    t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscSelectorOptions, {
      level: "sport",
      parentFilters: {},
    });

  test("ok: one call, one row", async () => {
    const t = convexTest(schema, modules);
    const urls = stubSteps([{ json: { aggregations: { sport: [{ label: "Baseball", slug: "baseball", count: 3 }] } } }]);
    const r = await call(t);
    expect(r).toEqual({
      success: true,
      options: [{ value: "Baseball", platformValue: "baseball" }],
      message: "Found 1 sport options from BSC",
    });
    expect(urls).toHaveLength(1);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ op: "fetchBscSelectorOptions", calls: 1, ok: 1, byStatus: { "200": 1 } });
    expect(summaries()).toHaveLength(1);
  });

  test("http, timeout, network: every attempt recorded; errText still reads the full body; message unchanged", async () => {
    const t = convexTest(schema, modules);
    const body = "BSC is down for maintenance " + "z".repeat(5000) + " END-OF-BODY";
    stubSteps([{ status: 503, body }, "timeout", "network"]);
    const r = await call(t);
    expect(r).toEqual({ success: false, options: [], message: "BSC API request failed: fetch failed" });
    // The caller's own read of the 503 body, after the recorder's clone.
    expect(errors.some((l) => l.includes("BSC API 503 (attempt 1/3): BSC is down for maintenance zzz"))).toBe(true);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      calls: 3,
      ok: 0,
      byKind: { http: 1, timeout: 1, network: 1 },
      byStatus: { "503": 1 },
    });
    expect(failures().map((f) => [f.kind, f.attempt, f.pathTemplate])).toEqual([
      ["http", 1, "search/bulk-upload/filters"],
      ["timeout", 2, "search/bulk-upload/filters"],
      ["network", 3, "search/bulk-upload/filters"],
    ]);
    expect(String(failures()[0].body)).toContain("BSC is down for maintenance");
    expect(failures()[0].headers).toMatchObject({ server: "awselb/2.0" });
  });

  test("a permanent 4xx: the post-loop errText reads the body too", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ status: 404, body: "no such route here" }]);
    const r = await call(t);
    expect(r).toEqual({ success: false, options: [], message: "BSC API error: 404" });
    expect(errors.some((l) => l.endsWith("BSC API 404 (attempt 1/3): no such route here"))).toBe(true);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 1, ok: 0, byKind: { http: 1 }, byStatus: { "404": 1 } });
  });

  test("a 2xx that will not parse is a parse failure on its attempt; the result is unchanged", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ status: 200, body: "<html>not json</html>", contentType: "text/html" }]);
    const r = await call(t);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/^BSC error: /);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 1, ok: 0, byKind: { parse: 1 }, byStatus: { "200": 1 } });
  });
});

// ---------------------------------------------------------------------------

const SCOPE = { sport: ["baseball"], year: ["1996"], setName: ["score"], variant: ["insert"] };
const card = (n: number) => ({ id: `bsc-${n}`, cardNo: String(n), players: `Player ${n}`, setName: "score" });

describe("fetchBscChecklist — the checklist doFetch", () => {
  const call = (t: ReturnType<typeof convexTest>, variantName: string[]) =>
    t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscChecklist, {
      parentFilters: {},
      facetFilters: { ...SCOPE, variantName },
      sourceFacet: "variantName",
    });

  test("ok and http across a two-request fan-out: one row; the result is the same refusal", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ json: [card(1)] }, { status: 500, body: "Internal error" }]);
    const r = await call(t, ["s-2", "s-1"]);
    expect(r).toMatchObject({
      success: false,
      cards: [],
      failure: { kind: "http_error", httpStatus: 500, requests: 2, requestsOk: 1 },
    });
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      op: "fetchBscChecklist",
      calls: 2,
      ok: 1,
      byKind: { http: 1 },
      byStatus: { "200": 1, "500": 1 },
    });
    expect(failures()[0]).toMatchObject({ kind: "http", pathTemplate: "search/bulk-upload/results", timeoutMs: 30_000 });
  });

  test("timeout and network: recorded, and the failure the caller sees is unchanged", async () => {
    const t = convexTest(schema, modules);
    stubSteps(["timeout", "network"]);
    const r = await call(t, ["s-2", "s-1"]);
    expect(r).toMatchObject({
      success: false,
      failure: { kind: "timeout", timedOut: true, timeoutMs: 30_000, requests: 2, requestsOk: 0 },
    });
    expect(r.message).toContain("BSC API request timed out after 30s");
    expect(r.message).toContain("BSC API request failed: fetch failed");
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 2, ok: 0, byKind: { timeout: 1, network: 1 } });
  });

  test("a 2xx body that will not parse: parse, not ok", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ status: 200, body: "garbage" }]);
    const r = await call(t, ["s-1"]);
    expect(r).toMatchObject({ success: false, failure: { kind: "bad_response", httpStatus: 200 } });
    const stored = await rows(t);
    expect(stored[0]).toMatchObject({ calls: 1, ok: 0, byKind: { parse: 1 } });
  });

  test("a 401 re-authed and retried: both sends on one row, the retry is attempt 2", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ status: 401, body: "expired" }, { json: [card(1)] }]);
    const r = await call(t, ["s-1"]);
    expect(r.success).toBe(true);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ calls: 2, ok: 1, byStatus: { "401": 1, "200": 1 } });
    expect(failures()[0]).toMatchObject({ kind: "http", status: 401, attempt: 1 });
  });

  test("probeBscChecklistBatch: every request of the batch on ONE row", async () => {
    const t = convexTest(schema, modules);
    stubSteps([{ json: [card(1)] }, { json: [card(2), card(3)] }]);
    const r = await t.withIdentity(ADMIN).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
      requests: [
        { id: "a", facetFilters: { ...SCOPE, variantName: ["s-1"] } },
        { id: "b", facetFilters: { ...SCOPE, variantName: ["s-2"] } },
      ],
    });
    expect(r.map((x) => [x.id, x.status])).toEqual([
      ["a", "ok"],
      ["b", "ok"],
    ]);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ op: "probeBscChecklistBatch", calls: 2, ok: 2 });
  });
});

// ---------------------------------------------------------------------------

describe("fetchBscCardTeamNames — card-listing, one recorder across chunks", () => {
  test("ok, http, timeout, network, body_timeout and parse over two chunks: ONE row", async () => {
    const t = convexTest(schema, modules);
    // 12 ids: two chunks of the 10-wide fan-out.
    const plan: Record<string, Step | "slow-body"> = {
      "c-1": { json: { teamName: "Seattle Mariners" } },
      "c-2": { status: 503, body: "<title>Service Unavailable</title>", contentType: "text/html" },
      "c-3": "timeout",
      "c-4": "network",
      "c-5": { status: 200, body: "{not json" },
      "c-6": "slow-body",
    };
    for (let i = 7; i <= 12; i += 1) plan[`c-${i}`] = { json: { teamName: "" } };
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const id = /\/marketplace\/card\/([^/]+)\/card-listing/.exec(String(url))?.[1] ?? "";
      const step = plan[id];
      if (step === "slow-body") {
        // Headers arrive; the body read then hits the abort timer.
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(
              Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
            );
          },
        });
        return new Response(body, { status: 200 });
      }
      return respond(step);
    }) as typeof fetch);

    const ids = Object.keys(plan);
    const r = await t.action(internal.adapters.buysportscards.fetchBscCardTeamNames, { bscCardIds: ids });
    expect(r.map((x) => [x.bscCardId, x.success])).toEqual(
      ids.map((id) => [id, !["c-2", "c-3", "c-4", "c-5", "c-6"].includes(id)]),
    );
    expect(r[0]).toMatchObject({ rawTeamName: "Seattle Mariners", teamNames: ["Seattle Mariners"] });

    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    // NEO-475: each of the five failures is retried once (a 5xx, a timeout, a
    // network error, and a 2xx body that would not parse or timed out), so
    // the one row holds 7 answered calls plus 5 x 2 failed attempts.
    expect(stored[0]).toMatchObject({
      op: "fetchBscCardTeamNames",
      calls: 17,
      ok: 7,
      byKind: { http: 2, timeout: 2, network: 2, parse: 2, body_timeout: 2 },
    });
    expect(summaries()).toHaveLength(1);
    const byCard = Object.fromEntries(failures().map((f) => [f.bscCardId, f.kind]));
    expect(byCard).toEqual({ "c-2": "http", "c-3": "timeout", "c-4": "network", "c-5": "parse", "c-6": "body_timeout" });
    expect(failures().every((f) => f.pathTemplate === "marketplace/card/:id/card-listing")).toBe(true);
    // The pre-existing failure log lines are untouched.
    expect(warns.some((l) => l.includes("card-listing fetch failed status=503 bscCardId=c-2"))).toBe(true);
  });

  test("no ids: no call, no row, no summary", async () => {
    const t = convexTest(schema, modules);
    stubSteps([]);
    expect(await t.action(internal.adapters.buysportscards.fetchBscCardTeamNames, { bscCardIds: [] })).toEqual([]);
    expect(await rows(t)).toHaveLength(0);
    expect(summaries()).toHaveLength(0);
  });
});
