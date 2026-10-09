/**
 * NEO-325 (security round): the SportLots selector's empty-result recovery
 * (`fetchSportLotsSelectorOptions`) re-authenticates through
 * `credentials.refreshSiteTokenAfterRejection`, never `authenticateSportlots`
 * directly, so the NEO-278 backoff and the per-(user, site) credential lock
 * apply to it as they do to every fetch-driven refresh.
 *
 * The real refresh runs; only the login (`authenticateSportlots`) and the
 * cookie read (`getSiteToken`) are stubbed at the `./credentials` boundary.
 * Whatever the refresh answers, the loop still re-reads the cookie and
 * re-POSTs: an unchanged cookie simply comes back empty again, and the call
 * ends `empty_after_retries`.
 *
 * Each recovering call sleeps `emptyRetryBackoffMs` twice (real time, ~1s).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_slselector_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_slselector_001",
  name: "Admin User",
  role: "admin",
};

const st = vi.hoisted(() => ({
  authCalls: 0,
  authSuccess: true,
  authThrows: false,
  cookieReads: 0,
  cookie: "PHPSESSID=old",
  /** Runs inside the login: the test's window onto the lock. */
  onAuth: undefined as undefined | (() => Promise<void>),
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
      handler: async () => {
        st.cookieReads++;
        return { token: st.cookie };
      },
    }),
    authenticateSportlots: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => {
        st.authCalls++;
        await st.onAuth?.();
        if (st.authThrows) throw new Error("browser service down");
        return { success: st.authSuccess };
      },
    }),
  };
});

let lines: string[];

beforeEach(() => {
  st.authCalls = 0;
  st.authSuccess = true;
  st.authThrows = false;
  st.cookieReads = 0;
  st.cookie = "PHPSESSID=old";
  st.onAuth = undefined;
  lines = [];
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EMPTY_HTML = "<html><body><h1>Attention Required! | Cloudflare</h1></body></html>";
const OPTIONS_HTML =
  '<select name="sprt"><option value="BB">Baseball</option><option value="FB">Football</option></select>';

type Cookies = string[];

/** Stub SL: `html(n)` answers the n-th POST; records the cookie of each. */
function stubSl(html: (n: number) => string): Cookies {
  const cookies: Cookies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      cookies.push(String((init.headers as Record<string, string>).Cookie));
      return new Response(html(cookies.length), { status: 200, headers: { "Content-Type": "text/html" } });
    }),
  );
  return cookies;
}

type T = ReturnType<typeof convexTest>;

const run = (t: T) =>
  t
    .withIdentity(ADMIN)
    .action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "sport",
      parentFilters: {},
      requestId: "req-neo325-reauth",
    });

async function seedProfile(t: T, entry: Record<string, unknown> = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: ADMIN.subject,
      siteCredentials: [
        { site: "sportlots", hasCredentials: true, lastUpdated: "2026-10-01T00:00:00.000Z", ...entry },
      ],
    } as never);
  });
}

async function slEntry(t: T) {
  return t.run(async (ctx) => {
    const profile = await ctx.db.query("userProfiles").first();
    return profile?.siteCredentials?.find((c: { site: string }) => c.site === "sportlots");
  });
}

const jsonLines = (msg: string): Array<Record<string, unknown>> =>
  lines
    .filter((l) => l.startsWith("{") && l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const reauthLines = () => jsonLines("sl_selector_empty_reauth");
const errorClasses = () => jsonLines("adapter_sync_call").map((l) => l.error_class);

describe("the SL selector's empty-result retry goes through the refresh guards", () => {
  test("a healthy session: the lock is written for the login and released after it", async () => {
    const t = convexTest(schema, modules);
    await seedProfile(t);
    stubSl(() => EMPTY_HTML);
    const heldDuring: Array<Record<string, unknown> | undefined> = [];
    st.onAuth = async () => {
      heldDuring.push(await slEntry(t));
    };

    const result = await run(t);

    expect(result.success).toBe(false);
    expect(errorClasses()).toContain("empty_after_retries");
    // Two recovery rounds, each a login under the lock.
    expect(st.authCalls).toBe(2);
    expect(heldDuring).toHaveLength(2);
    for (const entry of heldDuring) {
      expect(entry).toMatchObject({ lockedOp: "test" });
      expect(typeof entry?.lockedAt).toBe("number");
    }
    const after = await slEntry(t);
    expect(after?.lockedAt).toBeUndefined();
    expect(after?.lockToken).toBeUndefined();
    expect(reauthLines().map((l) => l.refreshed)).toEqual([true, true]);
  }, 15_000);

  test("a session in the NEO-278 backoff is not logged in again: same outcome, same three POSTs", async () => {
    const t = convexTest(schema, modules);
    await seedProfile(t, { needsReauth: true, reauthObservedAt: Date.now() - 60_000 });
    const cookies = stubSl(() => EMPTY_HTML);

    const result = await run(t);

    expect(st.authCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(errorClasses()).toContain("empty_after_retries");
    expect(cookies).toHaveLength(3);
    expect(reauthLines().map((l) => [l.attempt, l.refreshed])).toEqual([
      [2, false],
      [3, false],
    ]);
    expect(
      jsonLines("marketplace_limiter").filter(
        (l) => l.limiter === "reauth_backoff" && l.outcome === "refresh_skipped",
      ),
    ).toHaveLength(2);
  }, 15_000);

  test("a credential lock held by another operation means no login, and the loop still re-POSTs", async () => {
    const t = convexTest(schema, modules);
    await seedProfile(t, { lockedAt: Date.now(), lockedOp: "delete", lockToken: "someone-else" });
    const cookies = stubSl(() => EMPTY_HTML);

    const result = await run(t);

    expect(st.authCalls).toBe(0);
    expect(result.success).toBe(false);
    expect(errorClasses()).toContain("empty_after_retries");
    expect(cookies).toHaveLength(3);
    expect(reauthLines().map((l) => l.refreshed)).toEqual([false, false]);
    expect(await slEntry(t)).toMatchObject({ lockedOp: "delete", lockToken: "someone-else" });
  }, 15_000);

  test("a login that throws is a failed refresh: the loop still re-POSTs", async () => {
    st.authThrows = true;
    const t = convexTest(schema, modules);
    await seedProfile(t);
    const cookies = stubSl(() => EMPTY_HTML);

    const result = await run(t);

    expect(st.authCalls).toBe(2);
    expect(result.success).toBe(false);
    expect(cookies).toHaveLength(3);
    expect(reauthLines().map((l) => l.refreshed)).toEqual([false, false]);
    expect((await slEntry(t))?.lockedAt).toBeUndefined();
  }, 15_000);

  test("a refresh that itself throws is swallowed: the loop still re-POSTs", async () => {
    const { internalAction } = await import("./_generated/server");
    const { v } = await import("convex/values");
    const throwing = {
      ...modules,
      "./credentials.ts": async () => ({
        ...((await modules["./credentials.ts"]()) as Record<string, unknown>),
        refreshSiteTokenAfterRejection: internalAction({
          args: { site: v.string() },
          returns: v.any(),
          handler: async () => {
            throw new Error("refresh blew up");
          },
        }),
      }),
    };
    const t = convexTest(schema, throwing);
    const cookies = stubSl(() => EMPTY_HTML);

    const result = await run(t);

    expect(result.success).toBe(false);
    expect(errorClasses()).toContain("empty_after_retries");
    expect(cookies).toHaveLength(3);
    expect(reauthLines().map((l) => l.refreshed)).toEqual([false, false]);
  }, 15_000);

  test("a recovered session ends the loop: one login, the refreshed cookie sent, options returned", async () => {
    st.onAuth = async () => {
      st.cookie = "PHPSESSID=new";
    };
    const t = convexTest(schema, modules);
    await seedProfile(t);
    const cookies = stubSl((n) => (n === 1 ? EMPTY_HTML : OPTIONS_HTML));

    const result = await run(t);

    expect(result.success).toBe(true);
    expect(result.options.map((o) => o.value)).toEqual(["Baseball", "Football"]);
    expect(st.authCalls).toBe(1);
    expect(cookies).toEqual(["PHPSESSID=old", "PHPSESSID=new"]);
  }, 15_000);

  test("a non-empty first answer never touches the refresh", async () => {
    const t = convexTest(schema, modules);
    stubSl(() => OPTIONS_HTML);

    const result = await run(t);

    expect(result.success).toBe(true);
    expect(st.authCalls).toBe(0);
    expect(reauthLines()).toHaveLength(0);
  });
});
