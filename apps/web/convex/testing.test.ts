// Unit tests for the `resetMyTestState` mutation. Verifies caller-scoped
// deletes across publicProfiles / userProfiles / prizePool, the auth gate
// (must be signed in), and the production fail-closed gate (mutation throws
// unless TESTING_RESET_SECRET is present on the deployment).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = "user_aaaabbbbcccc";
const USER_B = "user_ddddeeeeffff";

beforeEach(() => {
  // Enabling flag — present on dev/preview, absent on prod.
  process.env.TESTING_RESET_SECRET = "test-enabled";
});

afterEach(() => {
  delete process.env.TESTING_RESET_SECRET;
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("publicProfiles", {
      userId,
      username: userId,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.insert("userProfiles", {
      userId,
      // NEO-96: preferences.defaultSport was dropped (zero readers).
      preferences: { defaultYear: 2024 },
    });
    await ctx.db.insert("prizePool", {
      userId,
      prizeName: "test-prize",
      percentage: 10,
      createdAt: 0,
      updatedAt: 0,
    });
  });
}

async function countRows(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<{
  publicProfiles: number;
  userProfiles: number;
  prizePool: number;
}> {
  return t.run(async (ctx) => {
    const pp = (await ctx.db.query("publicProfiles").collect()).filter(
      (r) => r.userId === userId,
    );
    const up = (await ctx.db.query("userProfiles").collect()).filter(
      (r) => r.userId === userId,
    );
    const pz = (await ctx.db.query("prizePool").collect()).filter(
      (r) => r.userId === userId,
    );
    return {
      publicProfiles: pp.length,
      userProfiles: up.length,
      prizePool: pz.length,
    };
  });
}

describe("resetMyTestState", () => {
  test("deletes the caller's own rows across all three tables", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER_A);

    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.resetMyTestState, {});

    expect(result).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
    });
    expect(await countRows(t, USER_A)).toEqual({
      publicProfiles: 0,
      userProfiles: 0,
      prizePool: 0,
    });
  });

  test("leaves other users' rows untouched", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER_A);
    await seedUser(t, USER_B);

    await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.resetMyTestState, {});

    expect(await countRows(t, USER_A)).toEqual({
      publicProfiles: 0,
      userProfiles: 0,
      prizePool: 0,
    });
    expect(await countRows(t, USER_B)).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
    });
  });

  test("zero-count happy path when the caller has no rows", async () => {
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.resetMyTestState, {});

    expect(result).toEqual({
      publicProfiles: 0,
      userProfiles: 0,
      prizePool: 0,
    });
  });

  test("throws when the caller is not authenticated", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER_A);

    await expect(
      t.mutation(api.testing.resetMyTestState, {}),
    ).rejects.toThrow(/Not authenticated/);

    // Existing rows must be untouched.
    expect(await countRows(t, USER_A)).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
    });
  });

  test("throws (fails closed) when TESTING_RESET_SECRET is unset", async () => {
    delete process.env.TESTING_RESET_SECRET;
    const t = convexTest(schema, modules);
    await seedUser(t, USER_A);

    await expect(
      t
        .withIdentity({ subject: USER_A })
        .mutation(api.testing.resetMyTestState, {}),
    ).rejects.toThrow(/not enabled/);

    expect(await countRows(t, USER_A)).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// seedMyTestCredentials — server-side marketplace credential seeding (NEO-29).
//
// Regression target: the seed must SELF-HEAL a stale stored username (it used
// to skip re-storing whenever ANY secret existed, so a stale secret from a
// prior run was never refreshed → SportLots "Not a valid Email Address"), while
// still SKIPPING (and preserving the warmed token) when the stored username is
// already correct (the token-storm protection).
//
// `getSiteCredentials` / `saveCredentials` reach the browser service only
// through `fetch`, so we point Convex at a loopback URL (skips OIDC via the
// credentials.ts LOOPBACK_HOSTS check) and stub `fetch` to fake the browser
// service's GET /metadata and POST /login/<site>. The seed env values are read
// from process.env (DEV_*); set them per-test.
//
// NEO-141: a re-store is no longer a cheap `PUT /credentials`. `saveCredentials`
// is connect-and-store now — it POSTs the transient username/password to the
// site's login route and the browser service persists only the resulting
// session (never the password). The stub records those login calls where it
// used to record PUTs.
// ---------------------------------------------------------------------------

const SL_USERNAME = "dev-sl@example.com";
const SL_PASSWORD = "sl-pass";
const BSC_USERNAME = "dev-bsc@example.com";
const BSC_PASSWORD = "bsc-pass";

type FetchStub = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a fetch stub for the browser credential endpoints. `metadata` controls
 * what GET /credentials/<key>/metadata returns: a 404 (no secret) or an object
 * with the currently-stored username. Every POST /login/<site> — the store path
 * since NEO-141 — is recorded in `puts` and answered as a successful login.
 */
function makeCredentialFetch(opts: {
  metadata:
    | {
        username: string;
        /** Session state; the defaults describe a healthy long-lived session. */
        hasToken?: boolean;
        expiresAt?: number;
        hasRefreshToken?: boolean;
        refreshExpiresAt?: number;
      }
    | 404;
  puts: Array<{ url: string; method: string; body: unknown }>;
}): FetchStub {
  return async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/metadata")) {
      if (opts.metadata === 404) return jsonResponse({ error: "Credentials not found" }, 404);
      const meta = opts.metadata;
      return jsonResponse({
        username: meta.username,
        hasToken: meta.hasToken ?? true,
        expiresAt: meta.expiresAt ?? 1_900_000_000_000,
        ...(meta.hasRefreshToken !== undefined && {
          hasRefreshToken: meta.hasRefreshToken,
        }),
        ...(meta.refreshExpiresAt !== undefined && {
          refreshExpiresAt: meta.refreshExpiresAt,
        }),
      });
    }
    if (method === "POST" && u.includes("/login/")) {
      opts.puts.push({
        url: u,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ success: true, message: "ok" });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

describe("markSiteNeedsReauth", () => {
  test("fails closed when TESTING_RESET_SECRET is unset (production)", async () => {
    const t = convexTest(schema, modules);
    delete process.env.TESTING_RESET_SECRET;
    await expect(
      t
        .withIdentity({ subject: USER_A })
        .mutation(api.testing.markSiteNeedsReauth, { site: "sportlots" }),
    ).rejects.toThrow(/not enabled/i);
  });

  test("flags only the caller's own entry, and only the named site", async () => {
    const t = convexTest(schema, modules);
    process.env.TESTING_RESET_SECRET = "enabled";
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          { site: "sportlots", hasCredentials: true },
          { site: "buysportscards", hasCredentials: true },
        ],
      });
      // A second user who must be left untouched — the mutation takes no
      // userId, but pin that it cannot reach across accounts.
      await ctx.db.insert("userProfiles", {
        userId: "user_other",
        siteCredentials: [{ site: "sportlots", hasCredentials: true }],
      });
    });

    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.markSiteNeedsReauth, { site: "sportlots" });
    expect(result).toEqual({ updated: true });

    await t.run(async (ctx) => {
      const mine = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", USER_A))
        .first();
      const sl = mine?.siteCredentials?.find((c) => c.site === "sportlots");
      const bsc = mine?.siteCredentials?.find((c) => c.site === "buysportscards");
      expect(sl?.needsReauth).toBe(true);
      expect(typeof sl?.needsReauthSince).toBe("number");
      // hasCredentials survives: the account is still connected, the session
      // just died. The UI relies on this to render re-auth rather than "not
      // connected".
      expect(sl?.hasCredentials).toBe(true);
      expect(bsc?.needsReauth).toBeUndefined();

      const other = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", "user_other"))
        .first();
      expect(other?.siteCredentials?.[0]?.needsReauth).toBeUndefined();
    });
    delete process.env.TESTING_RESET_SECRET;
  });

  test("is a no-op when the caller has no entry for that site", async () => {
    const t = convexTest(schema, modules);
    process.env.TESTING_RESET_SECRET = "enabled";
    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.markSiteNeedsReauth, { site: "sportlots" });
    expect(result).toEqual({ updated: false });
    delete process.env.TESTING_RESET_SECRET;
  });
});

describe("seedMyTestCredentials", () => {
  beforeEach(() => {
    // Loopback browser URL → getIdTokenClient short-circuits (no OIDC / no GCP creds).
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    process.env.DEV_SPORTLOTS_USERNAME = SL_USERNAME;
    process.env.DEV_SPORTLOTS_PASSWORD = SL_PASSWORD;
    process.env.DEV_BSC_USERNAME = BSC_USERNAME;
    process.env.DEV_BSC_PASSWORD = BSC_PASSWORD;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEONBINDER_BROWSER_URL;
    delete process.env.DEV_SPORTLOTS_USERNAME;
    delete process.env.DEV_SPORTLOTS_PASSWORD;
    delete process.env.DEV_BSC_USERNAME;
    delete process.env.DEV_BSC_PASSWORD;
  });

  test("skips re-store (preserves token) when the stored username is already correct", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: SL_USERNAME }, puts }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(0); // no login → warmed session left intact
  });

  test("clears a stale needsReauth flag on the skip path (seeding must repair)", async () => {
    // Seeding is the suite's repair mechanism, so it has to actually repair.
    // `reauthPatch(undefined)` returns `{}`, so without an explicit
    // `needsReauth: false` the flag is STICKY here — a worker left flagged by
    // an interrupted run would stay flagged through every later seed, and the
    // re-auth card renders no "Test Credentials" button, so the util flows
    // would keep failing on that runner with no way to self-heal.
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: "sportlots",
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: Date.now() - 1000,
          },
        ],
      });
    });
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: SL_USERNAME }, puts }),
    );

    await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(puts).toHaveLength(0); // still the cheap skip path
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", USER_A))
        .first();
      const entry = profile?.siteCredentials?.find((c) => c.site === "sportlots");
      expect(entry?.hasCredentials).toBe(true);
      expect(entry?.needsReauth ?? false).toBe(false);
    });
  });

  test("re-authenticates when the username is correct but the session has EXPIRED", async () => {
    // The idle-worker failure this guards (NEO-141). A BSC refresh token lives
    // 24h; a worker idle longer keeps a perfectly correct username but a dead
    // session. Matching on the username alone would skip the re-store, mint
    // nothing, and leave the first fetch to come back `reauth_required` — at
    // which point the panel renders the re-auth card, which deliberately does
    // NOT offer "Test Credentials", so every shared util flow would HANG on
    // its extendedWaitUntil for that label rather than fail fast.
    //
    // The seed is the only place that still holds a password, so it is the
    // only place that can mint a replacement.
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({
        metadata: {
          username: SL_USERNAME,
          hasToken: true,
          expiresAt: Date.now() - 60_000,
          hasRefreshToken: true,
          refreshExpiresAt: Date.now() - 60_000,
        },
        puts,
      }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain("/login/sportlots");
  });

  test("re-authenticates when the browser service reports no renewable session", async () => {
    // A revision predating NEO-141 omits `hasRefreshToken` entirely. Coercing
    // that to false costs one redundant sign-in and never skips wrongly, which
    // is the correct direction for an ambiguous signal.
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({
        metadata: { username: SL_USERNAME, hasToken: false },
        puts,
      }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(1);
  });

  test("re-stores from env when the stored username is stale (self-heal)", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: "old-stale@example.com" }, puts }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(1);
    expect(puts[0].method).toBe("POST");
    expect(puts[0].url).toContain("/login/sportlots");
    // The password rides along transiently for this one login and is never
    // persisted (NEO-141) — the key identifies the secret to write the session to.
    expect(puts[0].body).toEqual({
      key: expect.stringContaining("sportlots-credentials-"),
      username: SL_USERNAME,
      password: SL_PASSWORD,
    });
  });

  test("stores from env when no secret exists yet (metadata 404)", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", makeCredentialFetch({ metadata: 404, puts }));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({
      key: expect.stringContaining("sportlots-credentials-"),
      username: SL_USERNAME,
      password: SL_PASSWORD,
    });
  });

  test("treats benign casing/whitespace drift as a match (no needless re-store)", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: `  ${SL_USERNAME.toUpperCase()} ` }, puts }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: true }]);
    expect(puts).toHaveLength(0); // normalized equal → skip, token preserved
  });

  test("skips the site (no browser calls) when its env creds are not configured", async () => {
    delete process.env.DEV_SPORTLOTS_USERNAME;
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    vi.stubGlobal("fetch", (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called when env creds are missing");
    }) as unknown as typeof fetch);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: false, skipped: true }]);
    expect(fetchCalled).toBe(false);
  });

  test("BSC self-heals identically: skip when correct, re-store when stale", async () => {
    // correct → skip
    const tOk = convexTest(schema, modules);
    const putsOk: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: BSC_USERNAME }, puts: putsOk }),
    );
    const okResult = await tOk
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["buysportscards"] });
    expect(okResult.seeded).toEqual([{ site: "buysportscards", stored: true }]);
    expect(putsOk).toHaveLength(0);

    // stale → re-store with BSC env creds
    vi.unstubAllGlobals();
    const tStale = convexTest(schema, modules);
    const putsStale: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      makeCredentialFetch({ metadata: { username: "stale-bsc@example.com" }, puts: putsStale }),
    );
    const staleResult = await tStale
      .withIdentity({ subject: USER_B })
      .action(api.testing.seedMyTestCredentials, { sites: ["buysportscards"] });
    expect(staleResult.seeded).toEqual([{ site: "buysportscards", stored: true }]);
    expect(putsStale).toHaveLength(1);
    expect(putsStale[0].url).toContain("/login/bsc");
    expect(putsStale[0].body).toEqual({
      key: expect.stringContaining("buysportscards-credentials-"),
      username: BSC_USERNAME,
      password: BSC_PASSWORD,
    });
  });
});
