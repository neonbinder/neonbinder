/**
 * NEO-325 (security round): the BSC re-auth of the Base match probe and of
 * `fetchBscChecklist`, and the wall-clock budget of one probe batch.
 *
 *   - A BSC session spends AT MOST ONE re-auth. It goes through
 *     `credentials.refreshSiteTokenAfterRejection`, so it inherits the
 *     NEO-278 backoff and the per-(user, site) credential lock. The real
 *     refresh runs here; only the login itself (`authenticateBsc`,
 *     `authenticateSportlots`) and the token read (`getSiteToken`) are stubbed
 *     at the `./credentials` module boundary, each with a counter.
 *   - A dead session (failed or skipped re-auth, or any second 401) sends
 *     nothing more and logs nobody in.
 *   - `BSC_PROBE_DEADLINE_MS` bounds the whole batch. The clock is moved by
 *     skewing `Date.now` from inside the fetch / login stubs, so nothing
 *     here waits for real time.
 *
 * The SL / BSC session tests in `baseMatchProbe.test.ts` cover the happy path;
 * this file is the failure and guard matrix.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { BSC_PROBE_DEADLINE_MS } from "./lib/baseMatchProbe";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_reauth_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_reauth_001",
  name: "Admin User",
  role: "admin",
};

const BSC_TOKEN = "STALE-TOKEN-AA";
const FRESH_TOKEN = "FRESH-TOKEN-BB";

const st = vi.hoisted(() => ({
  reads: { sportlots: 0, buysportscards: 0 } as Record<string, number>,
  tokens: {} as Record<string, string | null>,
  authCalls: { buysportscards: 0, sportlots: 0 } as Record<string, number>,
  /** What the stubbed login answers. */
  authSuccess: true,
  /** Runs inside the login, after it is counted; may be slow. */
  onAuth: undefined as undefined | (() => void | Promise<void>),
}));

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async (_ctx, args) => {
        st.reads[args.site] = (st.reads[args.site] ?? 0) + 1;
        const token = st.tokens[args.site];
        return token ? { token } : null;
      },
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => {
        st.authCalls.buysportscards++;
        await st.onAuth?.();
        return { success: st.authSuccess };
      },
    }),
    authenticateSportlots: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => {
        st.authCalls.sportlots++;
        await st.onAuth?.();
        return { success: st.authSuccess };
      },
    }),
  };
});

/** Milliseconds the stubs have moved `Date.now` forward. */
const clock = { skew: 0 };
let logSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  st.reads = { sportlots: 0, buysportscards: 0 };
  st.tokens = { sportlots: "PHPSESSID=x", buysportscards: BSC_TOKEN };
  st.authCalls = { buysportscards: 0, sportlots: 0 };
  st.authSuccess = true;
  st.onAuth = undefined;
  clock.skew = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.skew);
  logSpies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

/** Every `marketplace_limiter` JSON line the console received. */
function limiterLines(): Array<Record<string, unknown>> {
  return logSpies
    .flatMap((s) => s.mock.calls)
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith("{") && line.includes('"marketplace_limiter"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type T = ReturnType<typeof convexTest>;

/** sport > year > setName > a parallel variant type with every BSC slot. */
async function seedParallel(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const ins = (f: Record<string, unknown>) =>
      ctx.db.insert("selectorOptions", {
        platformData: {},
        children: [],
        lastUpdated: 1,
        ...f,
      } as never);
    const sport = await ins({ level: "sport", value: "Baseball", platformData: { bsc: { b0: "baseball" } } });
    const year = await ins({ level: "year", value: "2024", parentId: sport, platformData: { bsc: { b0: "2024" } } });
    const brand = await ins({ level: "manufacturer", value: "Topps", parentId: year });
    const set = await ins({
      level: "setName",
      value: "Topps Chrome",
      parentId: brand,
      platformData: { bsc: { b0: "topps-chrome" } },
    });
    return ins({
      level: "variantType",
      value: "Gold",
      parentId: set,
      metadata: { variantRole: "parallel" },
      platformData: { bsc: { b0: "parallel" } },
      platformFacets: { bsc: { b0: "variant" } },
    });
  });
}

type SiteEntry = Record<string, unknown>;

/** The caller's profile, with one BSC credential entry. */
async function seedProfile(t: T, entry: SiteEntry = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: ADMIN.subject,
      siteCredentials: [
        { site: "buysportscards", hasCredentials: true, lastUpdated: "2026-10-01T00:00:00.000Z", ...entry },
      ],
    } as never);
  });
}

async function bscEntry(t: T) {
  return t.run(async (ctx) => {
    const profile = await ctx.db.query("userProfiles").first();
    return profile?.siteCredentials?.find((c: { site: string }) => c.site === "buysportscards");
  });
}

type BscCall = { token: string; variantName?: string };

/**
 * Stub the BSC search endpoint. `answer(call, n)` answers each POST; the
 * fetch itself never yields real time.
 */
function stubBsc(answer: (call: BscCall, n: number) => unknown[] | Response | Error) {
  const calls: BscCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body)) as { filters: Record<string, string[]> };
      const call = {
        token: (headers.authorization ?? "").replace(/^Bearer /, ""),
        variantName: body.filters.variantName?.[0],
      };
      calls.push(call);
      const out = answer(call, calls.length);
      if (out instanceof Error) throw out;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200 });
    }),
  );
  return calls;
}

let seq = 0;
const card = (no: string, players: string) => ({ id: `r-${++seq}`, cardNo: no, players });
const ok = () => [card("1", "Some Player")];
const unauthorised = () => new Response("expired", { status: 401 });
/** A 401 for the stale token, the cards for any other. */
const staleThenOk = (call: BscCall) => (call.token === BSC_TOKEN ? unauthorised() : ok());

const asAdmin = (t: T) => t.withIdentity(ADMIN);
const probe = (t: T, variantTypeId: Id<"selectorOptions">, ids: string[]) =>
  asAdmin(t).action(api.baseMatchProbe.probeBscSets, { variantTypeId, variantNameIds: ids });

const statusOf = (out: Array<{ id: string; status: string; kind?: string }>) =>
  out.map((r) => [r.id, r.status, r.kind]);

// ---------------------------------------------------------------------------
// One re-auth per session
// ---------------------------------------------------------------------------

describe("probeBscSets: a session spends at most one re-auth", () => {
  test("a failed re-auth on the first id sends nothing more and logs nobody in again", async () => {
    st.authSuccess = false;
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b", "c", "d"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "signed_out"],
      ["b", "failed", "signed_out"],
      ["c", "failed", "signed_out"],
      ["d", "failed", "signed_out"],
    ]);
    expect(calls).toHaveLength(1);
    expect(st.authCalls.buysportscards).toBe(1);
    expect(st.reads.buysportscards).toBe(1);
  });

  test("a 401 on a later id, after a good re-auth, is signed_out and later ids send nothing", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    // The stale token 401s once; the fresh token works for "a" and 401s for "b".
    const calls = stubBsc((call) =>
      call.token === BSC_TOKEN || call.variantName === "b" ? unauthorised() : ok(),
    );
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b", "c"]);

    expect(statusOf(out)).toEqual([
      ["a", "ok", undefined],
      ["b", "failed", "signed_out"],
      ["c", "failed", "signed_out"],
    ]);
    expect(st.authCalls.buysportscards).toBe(1);
    // a (stale), a (retry), b. Nothing for c.
    expect(calls.map((c) => [c.variantName, c.token])).toEqual([
      ["a", BSC_TOKEN],
      ["a", FRESH_TOKEN],
      ["b", FRESH_TOKEN],
    ]);
  });

  test("a retry that is refused again does not log in a second time", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "signed_out"],
      ["b", "failed", "signed_out"],
    ]);
    expect(st.authCalls.buysportscards).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("a re-auth that succeeds but leaves no token is no_sign_in, and the session is dead", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = null;
    };
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "no_sign_in"],
      ["b", "failed", "signed_out"],
    ]);
    expect(calls).toHaveLength(1);
    expect(st.authCalls.buysportscards).toBe(1);
  });

  test("a login that throws is the same as a failed one: signed_out, nothing more sent", async () => {
    st.onAuth = () => {
      throw new Error("browser service down");
    };
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "signed_out"],
      ["b", "failed", "signed_out"],
    ]);
    expect(calls).toHaveLength(1);
    expect(st.authCalls.buysportscards).toBe(1);
  });

  test("a non-401 failure leaves the session alive for the next id", async () => {
    const calls = stubBsc((call) =>
      call.variantName === "a" ? new Response("boom", { status: 500 }) : ok(),
    );
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "http_error"],
      ["b", "ok", undefined],
    ]);
    expect(calls).toHaveLength(2);
    expect(st.authCalls.buysportscards).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The re-auth goes through the NEO-278 backoff and the credential lock
// ---------------------------------------------------------------------------

describe("probeBscSets: the re-auth keeps the NEO-278 backoff and the credential lock", () => {
  test("a session flagged needsReauth 60s ago is not logged in again, and says so", async () => {
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);
    await seedProfile(t, { needsReauth: true, reauthObservedAt: Date.now() - 60_000 });
    const calls = stubBsc(() => unauthorised());

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "signed_out"],
      ["b", "failed", "signed_out"],
    ]);
    expect(st.authCalls.buysportscards).toBe(0);
    expect(calls).toHaveLength(1);
    expect(limiterLines()).toContainEqual(
      expect.objectContaining({ limiter: "reauth_backoff", outcome: "refresh_skipped", platform: "buysportscards" }),
    );
  });

  test("a flag older than the 15-minute backoff is retried: one login", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);
    await seedProfile(t, { needsReauth: true, reauthObservedAt: Date.now() - 16 * 60_000 });
    stubBsc(staleThenOk);

    const out = await probe(t, parallel, ["a"]);

    expect(statusOf(out)).toEqual([["a", "ok", undefined]]);
    expect(st.authCalls.buysportscards).toBe(1);
  });

  test("a credential lock held by another operation means no login, and it is left alone", async () => {
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);
    await seedProfile(t, { lockedAt: Date.now(), lockedOp: "store", lockToken: "someone-else" });
    const calls = stubBsc(() => unauthorised());

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "signed_out"],
      ["b", "failed", "signed_out"],
    ]);
    expect(st.authCalls.buysportscards).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await bscEntry(t)).toMatchObject({ lockedOp: "store", lockToken: "someone-else" });
    expect(limiterLines()).toContainEqual(
      expect.objectContaining({ limiter: "credential_lock", outcome: "busy", heldBy: "store" }),
    );
  });

  test("a successful re-auth takes the lock and gives it back", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);
    stubBsc(staleThenOk);

    await probe(t, parallel, ["a"]);

    const entry = await bscEntry(t);
    expect(entry).toBeDefined();
    expect(entry?.lockedAt).toBeUndefined();
    expect(entry?.lockToken).toBeUndefined();
    expect(limiterLines()).toContainEqual(
      expect.objectContaining({ limiter: "credential_lock", outcome: "released" }),
    );
  });

  test("a failed re-auth still gives the lock back", async () => {
    st.authSuccess = false;
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);
    stubBsc(() => unauthorised());

    await probe(t, parallel, ["a"]);

    expect((await bscEntry(t))?.lockedAt).toBeUndefined();
  });

  test("two probes refused at the same moment, with a slow login, log in once", async () => {
    st.onAuth = async () => {
      await new Promise((r) => setTimeout(r, 60));
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    stubBsc(staleThenOk);
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const [x, y] = await Promise.all([probe(t, parallel, ["a"]), probe(t, parallel, ["b"])]);

    expect(st.authCalls.buysportscards).toBe(1);
    // The winner ends ok; the loser met the lock and is signed out. Which is
    // which is not the point.
    expect([x[0].status, y[0].status].sort()).toEqual(["failed", "ok"]);
  });
});

// ---------------------------------------------------------------------------
// refreshSiteTokenAfterRejection
// ---------------------------------------------------------------------------

describe("refreshSiteTokenAfterRejection", () => {
  const run = (t: T, site: unknown) =>
    asAdmin(t).action(internal.credentials.refreshSiteTokenAfterRejection, { site } as never);

  test("a paused marketplace is never logged in to, and takes no lock", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    const t = convexTest(schema, modules);

    expect(await run(t, "buysportscards")).toEqual({ refreshed: false });
    expect(st.authCalls.buysportscards).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("userProfiles").collect()).length)).toBe(0);
  });

  test("pausing the other marketplace does not stop it", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);

    expect(await run(t, "buysportscards")).toEqual({ refreshed: true });
  });

  test("with no identity it throws before any login", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.credentials.refreshSiteTokenAfterRejection, { site: "buysportscards" }),
    ).rejects.toThrow(/Not authenticated/);
    expect(st.authCalls.buysportscards).toBe(0);
  });

  test.each(["ebay", "myslabs", "", "BuySportsCards"])(
    "the validator rejects the site %j before anything runs",
    async (site) => {
      const t = convexTest(schema, modules);

      await expect(run(t, site)).rejects.toThrow();
      expect(st.authCalls.buysportscards + st.authCalls.sportlots).toBe(0);
    },
  );

  test("each site runs its own login and says whether it worked", async () => {
    const t = convexTest(schema, modules);

    expect(await run(t, "buysportscards")).toEqual({ refreshed: true });
    expect(st.authCalls).toEqual({ buysportscards: 1, sportlots: 0 });
    expect(await run(t, "sportlots")).toEqual({ refreshed: true });
    expect(st.authCalls).toEqual({ buysportscards: 1, sportlots: 1 });

    st.authSuccess = false;
    expect(await run(t, "buysportscards")).toEqual({ refreshed: false });
  });
});

// ---------------------------------------------------------------------------
// fetchBscChecklist: the same session rules across its variantName fan-out
// ---------------------------------------------------------------------------

describe("fetchBscChecklist: a fan-out over two variantName values", () => {
  const FILTERS = {
    sport: ["baseball"],
    year: ["2024"],
    setName: ["topps-chrome"],
    variant: ["parallel"],
    variantName: ["gold", "blue"],
  };
  const fetchChecklist = (t: T) =>
    asAdmin(t).action(api.adapters.buysportscards.fetchBscChecklist, {
      parentFilters: {},
      facetFilters: FILTERS,
    });

  test("a failed re-auth on the first request leaves the second unsent, and the message says so", async () => {
    st.authSuccess = false;
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);

    const res = await fetchChecklist(t);

    expect(res.success).toBe(false);
    expect(res.message).toContain("request not sent");
    expect(res.failure).toMatchObject({ kind: "signed_out" });
    expect(calls).toHaveLength(1);
    expect(st.authCalls.buysportscards).toBe(1);
  });

  test("a good re-auth hands the refreshed token to the second request", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    const calls = stubBsc(staleThenOk);
    const t = convexTest(schema, modules);

    const res = await fetchChecklist(t);

    expect(res.success).toBe(true);
    expect(calls.map((c) => [c.variantName, c.token])).toEqual([
      ["gold", BSC_TOKEN],
      ["gold", FRESH_TOKEN],
      ["blue", FRESH_TOKEN],
    ]);
    expect(st.authCalls.buysportscards).toBe(1);
  });

  test("a second 401 on the second request is not a second login", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
    };
    const calls = stubBsc((call) =>
      call.token === BSC_TOKEN || call.variantName === "blue" ? unauthorised() : ok(),
    );
    const t = convexTest(schema, modules);

    const res = await fetchChecklist(t);

    expect(res.success).toBe(false);
    expect(st.authCalls.buysportscards).toBe(1);
    expect(calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The batch's wall-clock budget
// ---------------------------------------------------------------------------

describe("probeBscSets: the batch has a wall-clock budget", () => {
  const pastBudget = () => {
    clock.skew += BSC_PROBE_DEADLINE_MS + 1;
  };

  test("once the budget is spent after the first id, the rest time out with nothing sent", async () => {
    const calls = stubBsc(() => {
      pastBudget();
      return ok();
    });
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b", "c", "d"]);

    expect(statusOf(out)).toEqual([
      ["a", "ok", undefined],
      ["b", "failed", "timeout"],
      ["c", "failed", "timeout"],
      ["d", "failed", "timeout"],
    ]);
    expect(calls).toHaveLength(1);
    expect(st.authCalls.buysportscards).toBe(0);
  });

  test("a 401 that arrives after the budget starts no re-auth and ends as a timeout", async () => {
    const calls = stubBsc(() => {
      pastBudget();
      return unauthorised();
    });
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "timeout"],
      ["b", "failed", "timeout"],
    ]);
    expect(st.authCalls.buysportscards).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a re-auth that finishes after the budget does not send the retry", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = FRESH_TOKEN;
      pastBudget();
    };
    const calls = stubBsc(() => unauthorised());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b"]);

    expect(statusOf(out)).toEqual([
      ["a", "failed", "timeout"],
      ["b", "failed", "timeout"],
    ]);
    expect(st.authCalls.buysportscards).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("a request's abort timer is cut to the time the budget has left", async () => {
    const timers: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timers.push(ms);
      return realTimeout(ms);
    });
    // Leave 5s of the budget after the first request.
    stubBsc((_call, n) => {
      if (n === 1) clock.skew += BSC_PROBE_DEADLINE_MS - 5_000;
      return ok();
    });
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    await probe(t, parallel, ["a", "b"]);

    expect(timers[0]).toBe(30_000);
    expect(timers[1]).toBeGreaterThan(4_000);
    expect(timers[1]).toBeLessThanOrEqual(5_000);
  });

  test("with budget to spare every id is fetched", async () => {
    const calls = stubBsc(() => ok());
    const t = convexTest(schema, modules);
    const parallel = await seedParallel(t);

    const out = await probe(t, parallel, ["a", "b", "c", "d"]);

    expect(out.every((r) => r.status === "ok")).toBe(true);
    expect(calls).toHaveLength(4);
  });
});

// A plain `fetchBscChecklist` has no budget: the deadline is the probe's only.
describe("fetchBscChecklist has no wall-clock budget of its own", () => {
  test("a clock far in the future does not stop a request", async () => {
    clock.skew = 10 * BSC_PROBE_DEADLINE_MS;
    const calls = stubBsc(() => ok());
    const t = convexTest(schema, modules);

    const res = await asAdmin(t).action(api.adapters.buysportscards.fetchBscChecklist, {
      parentFilters: {},
      facetFilters: {
        sport: ["baseball"],
        year: ["2024"],
        setName: ["topps-chrome"],
        variant: ["parallel"],
        variantName: ["gold"],
      },
    });

    expect(res.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
