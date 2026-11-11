/**
 * PR 451 (NEO-487) — the token leg is BSC wait time.
 *
 * Every BSC read starts with `getBscToken` → `credentials.getSiteToken`. A
 * stale session makes that a BSC sign-in through the browser service (B2C
 * login plus the profile read, 11-12 s seen in CI) with no BSC call in
 * flight, so before this the recorder had nothing open and the client showed
 * no "Waiting on BuySportsCards…" for the whole sign-in. Same for a 401's
 * re-auth inside the checklist path.
 *
 * Pinned here against the real adapters (fetch stubbed, the credential reads
 * mocked with a delay):
 *   - the wait opens before the token read starts, and stays open into the
 *     BSC calls: ONE wait (open, close), never a close and a reopen between
 *     the token and the first call, which would restart the client's clock;
 *   - a token read that fails still closes the wait, and nothing is sent;
 *   - the row's `accumulatedMs` is the one wait's wall clock (close.at -
 *     open.at), so the token time is counted once.
 *
 * The recorder-level rules (grace, overlap, double end) are in
 * `lib/bscCallTelemetry.waitEdges.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resetBscInflightForTests, type BscWaitEdge } from "./lib/bscCallTelemetry";

const st = vi.hoisted(() => ({
  /** How long `getSiteToken` takes (the sign-in). */
  tokenDelayMs: 0,
  /** What `getSiteToken` answers. */
  tokenMode: "token" as "token" | "none" | "throw",
  /** How long the 401 re-auth takes. */
  reauthDelayMs: 0,
  /** Everything that happened, in order. */
  events: [] as Array<
    | { kind: "edge"; edge: BscWaitEdge }
    | { kind: "token:start" | "token:end" | "reauth:start" | "reauth:end" | "fetch"; at: number }
  >,
}));

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => {
        st.events.push({ kind: "token:start", at: Date.now() });
        await pause(st.tokenDelayMs);
        st.events.push({ kind: "token:end", at: Date.now() });
        if (st.tokenMode === "throw") throw new Error("sign-in failed");
        return st.tokenMode === "token" ? { token: "test-bsc-token" } : null;
      },
    }),
    refreshSiteTokenAfterRejection: internalAction({
      args: { site: v.string() },
      returns: v.object({ refreshed: v.boolean() }),
      handler: async () => {
        st.events.push({ kind: "reauth:start", at: Date.now() });
        await pause(st.reauthDelayMs);
        st.events.push({ kind: "reauth:end", at: Date.now() });
        return { refreshed: true };
      },
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

// Every edge the adapter's writer hears, in order with the events above; the
// real writer still writes the row.
vi.mock("./lib/marketplaceWaitWriter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/marketplaceWaitWriter")>();
  return {
    ...actual,
    createMarketplaceWaitWriter: (
      ...args: Parameters<typeof actual.createMarketplaceWaitWriter>
    ) => {
      const writer = actual.createMarketplaceWaitWriter(...args);
      if (!writer) return writer;
      return {
        ...writer,
        onWaitEdge: (edge: BscWaitEdge) => {
          st.events.push({ kind: "edge", edge });
          writer.onWaitEdge(edge);
        },
      };
    },
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo487_token",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo487_token",
  name: "Admin",
  role: "admin",
};

const SIGN_IN_MS = 150;
const KEY = "run_487-token";
const CHECKLIST_FILTERS = {
  sport: ["baseball"],
  year: ["2024"],
  setName: ["topps-chrome"],
  variant: ["base"],
};

/** BSC's answers, in order; the last one repeats. */
let answers: Array<() => Response>;

beforeEach(() => {
  resetBscInflightForTests();
  st.tokenDelayMs = SIGN_IN_MS;
  st.tokenMode = "token";
  st.reauthDelayMs = 0;
  st.events = [];
  answers = [() => Response.json([])];
  let n = 0;
  vi.stubGlobal("fetch", (async () => {
    st.events.push({ kind: "fetch", at: Date.now() });
    const answer = answers[Math.min(n, answers.length - 1)];
    n += 1;
    return answer();
  }) as typeof fetch);
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type T = ReturnType<typeof convexTest>;

const rows = (t: T) => t.run(async (ctx) => ctx.db.query("marketplaceWaits").collect());
const edges = () =>
  st.events.flatMap((e) => (e.kind === "edge" ? [e.edge] : []));
const kinds = () =>
  st.events.map((e) => (e.kind === "edge" ? (e.edge.waiting ? "open" : "close") : e.kind));
const at = (kind: "token:start" | "token:end" | "fetch") => {
  const e = st.events.find((x) => x.kind === kind);
  if (!e || e.kind === "edge") throw new Error(`no ${kind}`);
  return e.at;
};

/** One wait, open → close, covering the sign-in; the row says the same. */
async function expectOneWaitCoveringTheSignIn(t: T, extraMs = 0) {
  const [open, close] = edges();
  expect(edges()).toHaveLength(2);
  expect(open.waiting).toBe(true);
  expect(close.waiting).toBe(false);
  // Opened no later than the sign-in started; closed no earlier than it ended.
  expect(open.at).toBeLessThanOrEqual(at("token:start"));
  expect(close.at).toBeGreaterThanOrEqual(at("token:end"));
  // Counted once: the wait's total is its own wall clock, and it holds the sign-in.
  expect(close.accumulatedMs).toBe(close.at - open.at);
  expect(close.accumulatedMs).toBeGreaterThanOrEqual(SIGN_IN_MS + extraMs - 5);
  const written = await rows(t);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ ownerId: ADMIN.subject, runKey: KEY, platform: "bsc" });
  expect(written[0].waitingSince).toBeUndefined();
  expect(written[0].accumulatedMs).toBe(close.accumulatedMs);
}

describe("fetchBscSelectorOptions — the token leg", () => {
  const run = (t: T) =>
    t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscSelectorOptions, {
      level: "sport",
      parentFilters: {},
      waitKey: KEY,
    });

  test("a slow token read opens the wait before it starts, and the calls after it are the same wait", async () => {
    answers = [
      () => Response.json({ aggregations: { sport: [{ label: "Baseball", slug: "baseball", count: 3 }] } }),
    ];
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(true);
    // No close (or reopen) between the token and the first call.
    expect(kinds().slice(0, 4)).toEqual(["open", "token:start", "token:end", "fetch"]);
    expect(kinds().at(-1)).toBe("close");
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("a token read that finds no token still closes the wait, and nothing is sent", async () => {
    st.tokenMode = "none";
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(false);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("a token read that throws (getBscToken's catch) still closes the wait", async () => {
    st.tokenMode = "throw";
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(false);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });
});

describe("fetchBscChecklist — the token leg and the 401 re-auth", () => {
  const run = (t: T) =>
    t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscChecklist, {
      parentFilters: {},
      facetFilters: CHECKLIST_FILTERS,
      waitKey: KEY,
    });

  test("a slow token read and the checklist request are one wait", async () => {
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(true);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "fetch", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("a failed token read closes the wait and sends nothing", async () => {
    st.tokenMode = "none";
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(false);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("a 401's re-auth keeps the wait open through the sign-in to the retry: still one wait", async () => {
    // Longer than the recorder's 500 ms idle grace: uncovered, the wait would
    // close after the 401 and reopen on the retry.
    st.reauthDelayMs = 700;
    answers = [() => new Response("", { status: 401 }), () => Response.json([])];
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r.success).toBe(true);
    expect(kinds()).toEqual([
      "open",
      "token:start",
      "token:end",
      "fetch",
      "reauth:start",
      "reauth:end",
      "token:start",
      "token:end",
      "fetch",
      "close",
    ]);
    await expectOneWaitCoveringTheSignIn(t, st.reauthDelayMs + SIGN_IN_MS);
  });
});

describe("probeBscChecklistBatch — the token leg", () => {
  const run = (t: T) =>
    t.withIdentity(ADMIN).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
      requests: [{ id: "gold", facetFilters: CHECKLIST_FILTERS }],
      waitKey: KEY,
    });

  test("a slow token read and the probe's request are one wait", async () => {
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r).toEqual([{ id: "gold", status: "ok", count: 0 }]);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "fetch", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("a failed token read closes the wait: every id failed, nothing sent", async () => {
    st.tokenMode = "none";
    const t = convexTest(schema, modules);
    const r = await run(t);

    expect(r).toEqual([{ id: "gold", status: "failed", kind: "no_sign_in" }]);
    expect(kinds()).toEqual(["open", "token:start", "token:end", "close"]);
    await expectOneWaitCoveringTheSignIn(t);
  });

  test("no key: the token read writes nothing", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(ADMIN).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
      requests: [{ id: "gold", facetFilters: CHECKLIST_FILTERS }],
    });

    expect(edges()).toEqual([]);
    expect(await rows(t)).toEqual([]);
  });
});
