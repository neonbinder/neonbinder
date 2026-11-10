// Unit tests for the `resetMyTestState` mutation. Verifies caller-scoped
// deletes across publicProfiles / userProfiles / prizePool and (NEO-358) the
// caller's collection tables, the auth gate
// (must be signed in), and the production fail-closed gate (mutation throws
// unless TESTING_RESET_SECRET is present on the deployment).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { insertTestCard } from "../lib/testing/card-row";
import { drainScheduled } from "../lib/testing/drain-scheduled";

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
    // NEO-358: one copy in a Main binder, and one set being built. The
    // catalog rows they point at are shared reference data the reset never
    // touches.
    // NEO-363 — a card cannot exist without a sport above it.
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: `Sport ${userId}`,
      platformData: {},
      lastUpdated: 0,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: `Set ${userId}`,
      parentId: sportId,
      platformData: {},
      lastUpdated: 0,
    });
    const variantId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      parentId: setId,
      platformData: {},
      lastUpdated: 0,
    });
    const cardId = await insertTestCard(ctx, {
      selectorOptionId: variantId,
      cardNumber: "1",
      cardName: "Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: 0,
    });
    const homeId = await ctx.db.insert("collectionContainers", {
      ownerId: userId,
      kind: "binder",
      system: "main",
      name: "Main",
      lastUpdated: 0,
    });
    await ctx.db.insert("collectionCopies", {
      ownerId: userId,
      cardId,
      variantId,
      setId,
      homeId,
      quantity: 1,
      lastUpdated: 0,
    });
    // NEO-401 — a smart binder's stored fits, drained with its container.
    await ctx.db.insert("collectionBinderFits", {
      ownerId: userId,
      binderId: homeId,
      cardId,
      variantId,
      order: 0,
      generation: 1,
    });
    await ctx.db.insert("collectionBinderFitsState", {
      ownerId: userId,
      binderId: homeId,
      computedAt: 0,
      supported: true,
      complete: true,
      count: 1,
    });
    await ctx.db.insert("collectionBuildingSets", {
      ownerId: userId,
      setId,
      lastUpdated: 0,
    });
    await ctx.db.insert("variantCommonPrices", {
      ownerId: userId,
      variantId,
      priceCents: 25,
      lastUpdated: 0,
    });
    // NEO-370 — one row in each listing table.
    await ctx.db.insert("listingOutbox", {
      ownerId: userId,
      platform: "bsc",
      cardId,
      variantId,
      seq: 1,
      changedAt: 0,
    });
    await ctx.db.insert("marketplaceListingSyncs", {
      ownerId: userId,
      variantId,
      platform: "bsc",
      status: "idle",
      problems: [],
      conditionsPushed: ["near_mint"],
      // NEO-415: the run's steps ride on the row, so the row's delete clears them.
      progress: { runStartedAt: 0, steps: [{ kind: "read", condition: "Near Mint", status: "done", finishedAt: 0 }] },
      lastUpdated: 0,
    });
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: userId,
      platform: "bsc",
      lastUpdated: 0,
    });
    await ctx.db.insert("marketplaceSales", {
      ownerId: userId,
      platform: "bsc",
      orderId: `order-${userId}`,
      orderNo: "1001",
      orderDate: 0,
      status: "READY_TO_SHIP",
      totals: { totalCents: 25 },
      items: [
        {
          platformCardId: "bsc-card-1",
          cardId,
          condition: "near_mint",
          quantity: 1,
          priceCents: 25,
          applied: false,
        },
      ],
      firstSeenAt: 0,
      lastUpdated: 0,
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
  collectionCopies: number;
  collectionContainers: number;
  collectionBuildingSets: number;
  variantCommonPrices: number;
  binderFits: number;
  listing: number;
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
    const cc = (await ctx.db.query("collectionCopies").collect()).filter(
      (r) => r.ownerId === userId,
    );
    const ct = (await ctx.db.query("collectionContainers").collect()).filter(
      (r) => r.ownerId === userId,
    );
    const bs = (await ctx.db.query("collectionBuildingSets").collect()).filter(
      (r) => r.ownerId === userId,
    );
    const vp = (await ctx.db.query("variantCommonPrices").collect()).filter(
      (r) => r.ownerId === userId,
    );
    const bf =
      (await ctx.db.query("collectionBinderFits").collect()).filter((r) => r.ownerId === userId).length +
      (await ctx.db.query("collectionBinderFitsState").collect()).filter((r) => r.ownerId === userId).length;
    let listing = 0;
    for (const table of [
      "listingOutbox",
      "marketplaceListingSyncs",
      "marketplaceListingStates",
      "marketplaceSales",
    ] as const) {
      listing += (await ctx.db.query(table).collect()).filter((r) => r.ownerId === userId).length;
    }
    return {
      publicProfiles: pp.length,
      userProfiles: up.length,
      prizePool: pz.length,
      collectionCopies: cc.length,
      collectionContainers: ct.length,
      collectionBuildingSets: bs.length,
      variantCommonPrices: vp.length,
      binderFits: bf,
      listing,
    };
  });
}

describe("resetMyTestState", () => {
  test("deletes the caller's own rows across every per-user table", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, USER_A);

    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.testing.resetMyTestState, {});

    expect(result).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
      collectionCopies: 1,
      collectionWants: 0,
      cardRequests: 0,
      collectionContainers: 1,
      collectionBuildingSets: 1,
      variantCommonPrices: 1,
      marketplaceListing: 4,
    });
    expect(await countRows(t, USER_A)).toEqual({
      publicProfiles: 0,
      userProfiles: 0,
      prizePool: 0,
      collectionCopies: 0,
      collectionContainers: 0,
      collectionBuildingSets: 0,
      variantCommonPrices: 0,
      binderFits: 0,
      listing: 0,
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
      collectionCopies: 0,
      collectionContainers: 0,
      collectionBuildingSets: 0,
      variantCommonPrices: 0,
      binderFits: 0,
      listing: 0,
    });
    expect(await countRows(t, USER_B)).toEqual({
      publicProfiles: 1,
      userProfiles: 1,
      prizePool: 1,
      collectionCopies: 1,
      collectionContainers: 1,
      collectionBuildingSets: 1,
      variantCommonPrices: 1,
      binderFits: 2,
      listing: 4,
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
      collectionCopies: 0,
      collectionWants: 0,
      cardRequests: 0,
      collectionContainers: 0,
      collectionBuildingSets: 0,
      variantCommonPrices: 0,
      marketplaceListing: 0,
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
      collectionCopies: 1,
      collectionContainers: 1,
      collectionBuildingSets: 1,
      variantCommonPrices: 1,
      binderFits: 2,
      listing: 4,
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
      collectionCopies: 1,
      collectionContainers: 1,
      collectionBuildingSets: 1,
      variantCommonPrices: 1,
      binderFits: 2,
      listing: 4,
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
 * NEO-143: every authenticated browser-service call pre-flights `GET /health`
 * for the contract version. Serve it centrally so these tests keep asserting on
 * the credential calls only.
 */
function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
    }
    return handler(url, init);
  }) as FetchStub);
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
  /** NEO-482: the seller id the browser's login answer carries (BSC logins only read it best-effort). */
  sellerId?: string;
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
      return jsonResponse({
        success: true,
        message: "ok",
        ...(opts.sellerId ? { sellerId: opts.sellerId } : {}),
      });
    }
    // NEO-120: the EasyPost key store — the one credential write that survived
    // NEO-141, easypost-scoped. See services/browser/src/routes/easypost.ts.
    if (method === "PUT" && u.includes("/easypost/")) {
      opts.puts.push({
        url: u,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ success: true, message: "EasyPost key stored" });
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
      const bsc = mine?.siteCredentials?.find((c: { site: string }) => c.site === "buysportscards");
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
    // NEO-143: the contract probe is cached at module scope; reset it so tests
    // cannot inherit a previous test's "healthy" result.
    __resetContractCache();
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
    delete process.env.DEV_EASYPOST_API_KEY;
  });

  // NEO-120: seeding EasyPost is additive. Every test above asserts the exact
  // `seeded` array, so reporting on EasyPost when it is not configured would
  // change the result of seeding on every deployment that has no key — which is
  // why the action stays silent rather than pushing a "skipped" entry.
  test("adds nothing to the result when no EasyPost key is configured", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
      makeCredentialFetch({ metadata: { username: SL_USERNAME }, puts }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded.some((s) => s.site === "easypost")).toBe(false);
  });

  test("stores the EasyPost key when one is configured", async () => {
    process.env.DEV_EASYPOST_API_KEY = "EZTK_test_key";
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
      makeCredentialFetch({ metadata: { username: SL_USERNAME }, puts }),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toContainEqual({ site: "easypost", stored: true });

    // One secret per seller, keyed by Clerk user id — never a shared key. The
    // write goes to the easypost-scoped route (PUT /easypost/:key), the only
    // credential write NEO-141 left reachable over HTTP.
    const easypostPut = puts.find((p) => p.url.includes("/easypost/"));
    expect(easypostPut?.url).toContain(`/easypost/easypost-credentials-${USER_A}`);
    expect(easypostPut?.body).toEqual({ apiKey: "EZTK_test_key" });
  });

  test("skips re-store (preserves token) when the stored username is already correct", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
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
    stubFetch(
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
    stubFetch(
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
    stubFetch(
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
    stubFetch(
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
    stubFetch(makeCredentialFetch({ metadata: 404, puts }));

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
    stubFetch(
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
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called when env creds are missing");
    }) as unknown as typeof fetch);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: false, skipped: true }]);
    expect(fetchCalled).toBe(false);
  });

  test("NEO-287 — a paused site is skipped first, before any credential read, and BSC still seeds", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    // Any call for the PAUSED site is a bug; BSC's own metadata+login calls
    // are expected and answered normally via makeCredentialFetch.
    stubFetch(makeCredentialFetch({ metadata: 404, puts }));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, {
        sites: ["sportlots", "buysportscards"],
      });

    // The paused site: skipped, no read, no store.
    expect(result.seeded).toContainEqual({
      site: "sportlots",
      stored: false,
      skipped: true,
    });
    // BSC is unaffected by the pause and still seeds normally.
    expect(result.seeded).toContainEqual({ site: "buysportscards", stored: true });
    // Every recorded call belongs to BSC — nothing was ever asked FOR
    // sportlots, the paused site.
    expect(puts.every((p) => p.body && (p.body as { key: string }).key.includes("buysportscards"))).toBe(true);
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  test("NEO-287 — a paused site alone makes no browser-service call at all", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("must not reach the browser service for a paused site");
    }) as unknown as typeof fetch);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([
      { site: "sportlots", stored: false, skipped: true },
    ]);
    expect(fetchCalled).toBe(false);
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  test("BSC self-heals identically: skip when correct, re-store when stale", async () => {
    // correct → skip
    const tOk = convexTest(schema, modules);
    const putsOk: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
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
    stubFetch(
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

  // NEO-294 — a failed store now says WHY. Every assertion above pins the exact
  // array on a PASSING path and none of them gained a `reason` key, which is the
  // other half of this contract: the field appears only on a failure, so the
  // "callers assert the exact array" rule the EasyPost comment relies on still
  // holds.
  test("NEO-294 — a failed store carries saveCredentials' own reason, verbatim", async () => {
    const t = convexTest(schema, modules);
    stubFetch((async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      // No secret yet, so the seed goes on to the real store.
      if (u.includes("/metadata")) return jsonResponse({ error: "Credentials not found" }, 404);
      if (method === "POST" && u.includes("/login/bsc")) {
        // NEO-288's shape: the marketplace answered by turning US away. This is
        // the case the CI screenshot most needed to name — it looks identical to
        // a bad password from the outside and is not one.
        return jsonResponse({ error: "Authentication failed", error_class: "challenge" }, 403);
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["buysportscards"] });

    expect(result.seeded).toEqual([
      {
        site: "buysportscards",
        stored: false,
        reason:
          "BSC wouldn't let us in the door — that's on them, not your password. Nothing changed on your end. Give it another go in a bit.",
      },
    ]);
    // The reason is the per-site copy, not an echo of the request: no username,
    // password or session token may reach it (it lands in a public CI artifact).
    const reason = result.seeded[0].reason ?? "";
    expect(reason).not.toContain(BSC_USERNAME);
    expect(reason).not.toContain(BSC_PASSWORD);
  });

  test("NEO-294 — a refused credential reports the credentials wording, not the site-side one", async () => {
    const t = convexTest(schema, modules);
    stubFetch((async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/metadata")) return jsonResponse({ error: "Credentials not found" }, 404);
      if (method === "POST" && u.includes("/login/sportlots")) {
        // `invalid_credentials` is the one class that IS about the password:
        // neither transient nor site-side, so saveCredentials rewrites the copy.
        return jsonResponse(
          { error: "Invalid credentials", error_class: "invalid_credentials" },
          401,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([
      {
        site: "sportlots",
        stored: false,
        reason:
          "Could not sign in to SportLots. Nothing was saved — check your username and password and try again.",
      },
    ]);
  });

  test("NEO-294 — a SKIPPED site carries no reason (it is not a failure)", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    stubFetch((async (url, init) => {
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${String(url)}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["sportlots"] });

    expect(result.seeded).toEqual([{ site: "sportlots", stored: false, skipped: true }]);
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });
});

// NEO-370 Revision 5 — the seed decides whether the seeded BSC sign-in LISTS.
// A saved sign-in is listing (counts pushed, sales polled), so the suite's
// accounts carry the E2E test marker (`testListingOff`) unless a spec asks
// for listing (`listing: true`, the seed page's `listing=on`). A real save
// through the product clears the marker.
describe("seedMyTestCredentials — the listing test marker", () => {
  beforeEach(() => {
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    __resetContractCache();
    process.env.DEV_BSC_USERNAME = BSC_USERNAME;
    process.env.DEV_BSC_PASSWORD = BSC_PASSWORD;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEONBINDER_BROWSER_URL;
    delete process.env.DEV_BSC_USERNAME;
    delete process.env.DEV_BSC_PASSWORD;
  });

  const bscState = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      (await ctx.db.query("marketplaceListingStates").collect()).filter((r) => r.ownerId === USER_A),
    );
  const seed = (t: ReturnType<typeof convexTest>, listing?: boolean) =>
    t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, {
        sites: ["buysportscards"],
        ...(listing !== undefined ? { listing } : {}),
      });

  test.each([
    ["the skip path (stored session still good)", { username: BSC_USERNAME } as const],
    ["the store path (no secret yet)", 404 as const],
  ])("%s: by default the account is held off listing", async (_name, metadata) => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(makeCredentialFetch({ metadata, puts }));
    expect((await seed(t)).seeded).toEqual([{ site: "buysportscards", stored: true }]);
    const rows = await bscState(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "bsc", testListingOff: true });
    expect(rows[0].listingStartedAt).toBeUndefined();
    expect(
      (await t.withIdentity({ subject: USER_A }).query(api.listingSync.listingSettings, {})).bsc,
    ).toMatchObject({ connected: true, listing: false });
    // Nothing was set going: no walk, no drain.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => /startListingWalk|drainOwner/.test(f.name))).toEqual([]);
  });

  test.each([
    ["the skip path (stored session still good)", { username: BSC_USERNAME } as const],
    ["the store path (no secret yet)", 404 as const],
  ])("%s: `listing: true` lists, and clears a marker an earlier seed set", async (_name, metadata) => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(makeCredentialFetch({ metadata: { username: BSC_USERNAME }, puts }));
    await seed(t);
    expect((await bscState(t))[0].testListingOff).toBe(true);
    vi.unstubAllGlobals();
    __resetContractCache();
    // NEO-482: a listing-on BSC seed signs in until the login carries the seller id.
    stubFetch(makeCredentialFetch({ metadata, puts, sellerId: "seller-482" }));
    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);
    const [row] = await bscState(t);
    expect(row.testListingOff).toBeUndefined();
    expect(row.listingStartedAt).toBeTypeOf("number");
    expect(
      (await t.withIdentity({ subject: USER_A }).query(api.listingSync.listingSettings, {})).bsc,
    ).toMatchObject({ connected: true, listing: true });
    await drainScheduled(t);
  });

  test("a real save through the product (saveCredentials) clears the marker and starts listing", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(makeCredentialFetch({ metadata: { username: BSC_USERNAME }, puts }));
    await seed(t);
    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, { site: "buysportscards", username: "me@example.com", password: "pw" });
    expect(result.success).toBe(true);
    const [row] = await bscState(t);
    expect(row.testListingOff).toBeUndefined();
    expect(row.listingStartedAt).toBeTypeOf("number");
    await drainScheduled(t);
  });

  test("the internal store refuses where the testing flag is unset, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    stubFetch(async () => {
      throw new Error("no fetch expected");
    });
    delete process.env.TESTING_RESET_SECRET;
    await expect(
      t.action(internal.credentials.storeTestCredentials, {
        userId: USER_A,
        site: "buysportscards",
        username: BSC_USERNAME,
        password: BSC_PASSWORD,
        listing: false,
      }),
    ).rejects.toThrow(/not enabled/);
    expect(await bscState(t)).toEqual([]);
  });
});

// NEO-482 — a listing-on BSC seed leaves the caller's BSC seller id saved, or
// says why not. The E2E reset deletes the userProfiles row (and the id with
// it). The id arrives only through a password login: the browser service
// reads BSC's profile inside the login (best effort, so a stalled read still
// returns a session with no id) and `credentials.runSiteLogin` saves it. The
// seed makes no profile read of its own. With no id saved it signs in again
// (no logout), up to 5 sign-ins and none started after 58 s. With an id
// already saved it adds nothing to the old behaviour.
describe("seedMyTestCredentials — NEO-482 seller id", () => {
  beforeEach(() => {
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    __resetContractCache();
    process.env.DEV_BSC_USERNAME = BSC_USERNAME;
    process.env.DEV_BSC_PASSWORD = BSC_PASSWORD;
    process.env.DEV_SPORTLOTS_USERNAME = SL_USERNAME;
    process.env.DEV_SPORTLOTS_PASSWORD = SL_PASSWORD;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.NEONBINDER_BROWSER_URL;
    delete process.env.DEV_BSC_USERNAME;
    delete process.env.DEV_BSC_PASSWORD;
    delete process.env.DEV_SPORTLOTS_USERNAME;
    delete process.env.DEV_SPORTLOTS_PASSWORD;
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  /** The flag-only branch: the stored session is correct and renewable. */
  const SIGNED_IN = { username: BSC_USERNAME } as const;
  const SELLER = "seller-482";
  const stalled = (tries: number) =>
    `BuySportsCards seller id not saved: the profile read stalled on every sign-in (${tries} tries).`;

  /** What one browser-service login answers. */
  type LoginStep = { sellerId?: string } | { fail: string } | "http500" | "throw";

  /**
   * A browser-service stub that counts logins. Login N answers `steps[N]`
   * (the last step repeats). `onLogin` runs before each answer, so a test can
   * move the clock. Any call to a BSC host is recorded in `bscHosts`: the
   * seed makes no marketplace profile read of its own.
   */
  function loginStub(opts: {
    metadata: { username: string } | 404;
    steps: LoginStep[];
    onLogin?: (n: number) => void;
  }) {
    const state = { logins: 0, loginUrls: [] as string[], bscHosts: [] as string[], loginBodies: [] as unknown[] };
    const fetchFn: FetchStub = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("buysportscards.com")) {
        state.bscHosts.push(u);
        throw new Error(`unexpected BSC call: ${u}`);
      }
      if (u.includes("/metadata")) {
        if (opts.metadata === 404) return jsonResponse({ error: "Credentials not found" }, 404);
        return jsonResponse({ username: opts.metadata.username, hasToken: true, expiresAt: 1_900_000_000_000 });
      }
      if (method === "POST" && u.includes("/login/")) {
        const n = state.logins;
        state.logins += 1;
        state.loginUrls.push(u);
        state.loginBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        opts.onLogin?.(n);
        const step = opts.steps[Math.min(n, opts.steps.length - 1)];
        if (step === "throw") throw new TypeError("fetch failed");
        if (step === "http500") return jsonResponse({ error: "boom" }, 500);
        if ("fail" in step) return jsonResponse({ success: false, message: step.fail });
        return jsonResponse({ success: true, message: "ok", ...(step.sellerId ? { sellerId: step.sellerId } : {}) });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    };
    return { state, fetchFn };
  }

  const seed = (t: ReturnType<typeof convexTest>, listing?: boolean, sites = ["buysportscards"]) =>
    t.withIdentity({ subject: USER_A }).action(api.testing.seedMyTestCredentials, {
      sites,
      ...(listing !== undefined ? { listing } : {}),
    });

  const sellerIdOf = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => {
      const profile = (await ctx.db.query("userProfiles").collect()).find((r) => r.userId === USER_A);
      return profile?.marketplaceAccountIds?.bscSellerId ?? null;
    });

  const bscCredentialEntry = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => {
      const profile = (await ctx.db.query("userProfiles").collect()).find((r) => r.userId === USER_A);
      return profile?.siteCredentials?.find((c: { site: string }) => c.site === "buysportscards");
    });

  const preseedSellerId = (t: ReturnType<typeof convexTest>, accountId: string) =>
    t.mutation(internal.userProfile.setMarketplaceAccountIdInternal, {
      userId: USER_A,
      site: "buysportscards",
      accountId,
    });

  /** Spy on both console channels; `lines()` is everything written to either. */
  function captureConsole() {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const all = () => [...log.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(" "));
    const relogins = () =>
      log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("{") && line.includes('"seed_bsc_relogin"'))
        .map((line) => JSON.parse(line) as { msg: string; attempt: number; idSaved: boolean; elapsedMs: number });
    return { all, relogins };
  }

  /** Move `Date.now` forward by `ms` per call to `advance`, leaving real time otherwise. */
  function skewClock() {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    return (ms: number) => {
      skew += ms;
    };
  }

  test("the first login returns the seller id: saved, exactly one login, stored true", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{ sellerId: SELLER }] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(1);
    expect(await sellerIdOf(t)).toBe(SELLER);
    expect(con.relogins()).toEqual([expect.objectContaining({ attempt: 1, idSaved: true })]);
    expect((await bscCredentialEntry(t))?.hasCredentials).toBe(true);
    await drainScheduled(t);
  });

  test("the first login has no id and the second has it: two logins, saved, the log shows false then true", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}, { sellerId: SELLER }] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(2);
    expect(await sellerIdOf(t)).toBe(SELLER);
    expect(con.relogins().map((l) => [l.msg, l.attempt, l.idSaved])).toEqual([
      ["seed_bsc_relogin", 1, false],
      ["seed_bsc_relogin", 2, true],
    ]);
    for (const line of con.relogins()) expect(line.elapsedMs).toBeGreaterThanOrEqual(0);
    await drainScheduled(t);
  });

  test("every login has no id: exactly five logins, then stored false naming five tries, nothing saved", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([
      { site: "buysportscards", stored: false, reason: stalled(5) },
    ]);

    expect(state.logins).toBe(5);
    expect(con.relogins().map((l) => [l.attempt, l.idSaved])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(await sellerIdOf(t)).toBeNull();
    // The sign-in itself worked, so the credential stays flagged as stored.
    expect((await bscCredentialEntry(t))?.hasCredentials).toBe(true);
    await drainScheduled(t);
  });

  test("the id turns up on the fifth (last) login: still stored true, five logins", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}, {}, {}, {}, { sellerId: SELLER }] });
    stubFetch(fetchFn);

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(5);
    expect(await sellerIdOf(t)).toBe(SELLER);
    await drainScheduled(t);
  });

  test("the 58 s window stops new sign-ins: fewer than five logins and the stalled reason", async () => {
    const t = convexTest(schema, modules);
    const advance = skewClock();
    // Each login "takes" 30 s: after login 2 the seed is at 60 s.
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}], onLogin: () => advance(30_000) });
    stubFetch(fetchFn);
    const con = captureConsole();

    const result = await seed(t, true);

    expect(state.logins).toBe(2);
    expect(result.seeded).toEqual([{ site: "buysportscards", stored: false, reason: stalled(2) }]);
    expect(con.relogins().map((l) => l.attempt)).toEqual([1, 2]);
    expect(con.relogins()[1].elapsedMs).toBeGreaterThanOrEqual(58_000);
    await drainScheduled(t);
  });

  test("a sign-in that finishes inside the window still allows the next one", async () => {
    const t = convexTest(schema, modules);
    const advance = skewClock();
    // 10 s each: 4 logins end at 40 s, so the fifth may start.
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}], onLogin: () => advance(10_000) });
    stubFetch(fetchFn);

    const result = await seed(t, true);

    expect(state.logins).toBe(5);
    expect(result.seeded[0].reason).toBe(stalled(5));
    await drainScheduled(t);
  });

  test.each([
    ["a non-ok response", "http500" as const],
    ["a browser success:false", { fail: "BSC refused the sign-in." } as const],
    ["a thrown request", "throw" as const],
  ])("%s on the first login stops at once: stored false, one login, no stalled reason", async (_name, step) => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [step] });
    stubFetch(fetchFn);
    const con = captureConsole();

    const [entry] = (await seed(t, true)).seeded;

    expect(entry.stored).toBe(false);
    expect(entry.reason).toBeTruthy();
    expect(entry.reason).not.toContain("seller id not saved");
    expect(state.logins).toBe(1);
    expect(con.relogins()).toEqual([]); // the id was never checked
    expect(await sellerIdOf(t)).toBeNull();
    await drainScheduled(t);
  });

  test("a success:false login's own message is the reason", async () => {
    const t = convexTest(schema, modules);
    const { fetchFn } = loginStub({ metadata: 404, steps: [{ fail: "BSC refused the sign-in." }] });
    stubFetch(fetchFn);
    // The same login, called straight, gives the message the seed must pass on.
    const direct = await t.action(internal.credentials.storeTestCredentials, {
      userId: USER_A,
      site: "buysportscards",
      username: BSC_USERNAME,
      password: BSC_PASSWORD,
      listing: true,
    });
    expect(direct.success).toBe(false);

    __resetContractCache();
    const [entry] = (await seed(t, true)).seeded;
    expect(entry).toEqual({ site: "buysportscards", stored: false, reason: direct.message });
    await drainScheduled(t);
  });

  test.each([
    ["a non-ok response", "http500" as const],
    ["a browser success:false", { fail: "BSC refused the sign-in." } as const],
    ["a thrown request", "throw" as const],
  ])("%s on a later login stops at once: stored false, no further logins", async (_name, step) => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}, {}, step, {}, {}] });
    stubFetch(fetchFn);
    const con = captureConsole();

    const [entry] = (await seed(t, true)).seeded;

    expect(entry.stored).toBe(false);
    expect(entry.reason).toBeTruthy();
    expect(entry.reason).not.toContain("seller id not saved");
    expect(state.logins).toBe(3);
    expect(con.relogins().map((l) => l.attempt)).toEqual([1, 2]);
    expect(await sellerIdOf(t)).toBeNull();
    await drainScheduled(t);
  });

  test("flag-only branch, id already saved: no login at all, the flag is written, the id is kept", async () => {
    const t = convexTest(schema, modules);
    await preseedSellerId(t, "seller-kept");
    const { state, fetchFn } = loginStub({ metadata: SIGNED_IN, steps: [{ sellerId: "seller-other" }] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(0);
    expect(con.relogins()).toEqual([]);
    expect(await sellerIdOf(t)).toBe("seller-kept");
    expect((await bscCredentialEntry(t))?.hasCredentials).toBe(true);
    const [row] = await t.run(async (ctx) =>
      (await ctx.db.query("marketplaceListingStates").collect()).filter((r) => r.ownerId === USER_A),
    );
    expect(row.testListingOff).toBeUndefined(); // listing: true clears the marker
    await drainScheduled(t);
  });

  test("flag-only branch, no id: a fresh sign-in happens and saves the id", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: SIGNED_IN, steps: [{ sellerId: SELLER }] });
    stubFetch(fetchFn);

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(1);
    expect(await sellerIdOf(t)).toBe(SELLER);
    await drainScheduled(t);
  });

  test.each([
    [58_000, 1, "stops at exactly 58000 ms elapsed"],
    [57_999, 2, "signs in again at 57999 ms elapsed"],
  ])("deadline boundary: after a stalled login at %i ms, %i login(s) in total (%s)", async (elapsed, logins, _name) => {
    const t = convexTest(schema, modules);
    // A frozen clock, so elapsed is exactly what the login advances.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { state, fetchFn } = loginStub({
      metadata: 404,
      steps: [{}, { sellerId: SELLER }],
      onLogin: (n) => {
        if (n === 0) now += elapsed;
      },
    });
    stubFetch(fetchFn);

    const [entry] = (await seed(t, true)).seeded;

    expect(state.logins).toBe(logins);
    if (logins === 1) {
      expect(entry).toEqual({ site: "buysportscards", stored: false, reason: stalled(1) });
      expect(await sellerIdOf(t)).toBeNull();
    } else {
      expect(entry).toEqual({ site: "buysportscards", stored: true });
      expect(await sellerIdOf(t)).toBe(SELLER);
    }
    await drainScheduled(t);
  });

  test("flag-only branch, no id, a stale needsReauth: the fresh sign-in clears it and the listing marker", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          { site: "buysportscards", hasCredentials: true, needsReauth: true, needsReauthSince: Date.now() - 1000 },
        ],
      });
    });
    const { state, fetchFn } = loginStub({ metadata: SIGNED_IN, steps: [{ sellerId: SELLER }] });
    stubFetch(fetchFn);

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(1);
    expect(await sellerIdOf(t)).toBe(SELLER);
    expect((await bscCredentialEntry(t))?.needsReauth).toBeFalsy(); // cleared (absent), not written as false
    const [row] = await t.run(async (ctx) =>
      (await ctx.db.query("marketplaceListingStates").collect()).filter((r) => r.ownerId === USER_A),
    );
    expect(row.testListingOff).toBeUndefined();
    await drainScheduled(t);
  });

  test("store branch, id already saved: one login, no re-check loop, the id kept", async () => {
    const t = convexTest(schema, modules);
    await preseedSellerId(t, "seller-kept");
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(1);
    expect(con.relogins()).toEqual([]);
    expect(await sellerIdOf(t)).toBe("seller-kept");
    await drainScheduled(t);
  });

  test.each([
    ["success:false", { fail: "BSC refused the sign-in." } as const],
    ["a thrown request", "throw" as const],
  ])("store branch, id already saved, the login fails (%s): stored false with a reason, one login", async (_name, step) => {
    const t = convexTest(schema, modules);
    await preseedSellerId(t, "seller-kept");
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [step] });
    stubFetch(fetchFn);

    const [entry] = (await seed(t, true)).seeded;

    expect(entry.stored).toBe(false);
    expect(entry.reason).toBeTruthy();
    expect(state.logins).toBe(1);
    expect(await sellerIdOf(t)).toBe("seller-kept");
    await drainScheduled(t);
  });

  test("store branch, id already saved, storeTestCredentials itself throws: stored false with the message", async () => {
    // A throw out of the action (not a result): wrap its handler so the
    // seed's runAction rejects.
    const real = (await modules["./credentials.ts"]()) as Record<string, unknown>;
    const t = convexTest(schema, {
      ...modules,
      "./credentials.ts": async () => ({
        ...real,
        storeTestCredentials: Object.assign(() => undefined, real.storeTestCredentials as object, {
          _handler: async () => {
            throw new Error("store exploded");
          },
        }),
      }),
    });
    await preseedSellerId(t, "seller-kept");
    stubFetch(async () => {
      throw new Error("no fetch expected");
    });

    const [entry] = (await seed(t, true)).seeded;

    expect(entry.stored).toBe(false);
    expect(entry.reason).toContain("store exploded");
    expect(await sellerIdOf(t)).toBe("seller-kept");
  });

  test.each([
    ["listing off (flag-only)", SIGNED_IN, false],
    ["listing off (store)", 404 as const, false],
    ["listing unset (store)", 404 as const, undefined],
  ])("%s: no re-login loop, no seller id read, even with a login that returns no id", async (_name, metadata, listing) => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata, steps: [{}] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, listing)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(state.logins).toBe(metadata === 404 ? 1 : 0);
    expect(con.relogins()).toEqual([]);
    expect(state.bscHosts).toEqual([]);
    expect(await sellerIdOf(t)).toBeNull();
  });

  test("SportLots with listing on: one login at most, no seller id loop", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{}] });
    stubFetch(fetchFn);
    const con = captureConsole();

    expect((await seed(t, true, ["sportlots"])).seeded).toEqual([{ site: "sportlots", stored: true }]);

    expect(state.logins).toBe(1);
    expect(state.loginUrls[0]).toContain("/login/sportlots");
    expect(con.relogins()).toEqual([]);
    expect(await sellerIdOf(t)).toBeNull();
    await drainScheduled(t);
  });

  test("BSC paused: skipped first, no browser-service or BSC call, no id", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    stubFetch(async (url, init) => {
      fetchCalled = true;
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${String(url)}`);
    });
    const con = captureConsole();

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: false, skipped: true }]);

    expect(fetchCalled).toBe(false);
    expect(con.relogins()).toEqual([]);
    expect(await sellerIdOf(t)).toBeNull();
  });

  test("the seed never calls a BSC host itself, on any path", async () => {
    for (const [metadata, steps] of [
      [404, [{}]],
      [SIGNED_IN, [{}]],
      [404, [{ sellerId: SELLER }]],
    ] as const) {
      const t = convexTest(schema, modules);
      __resetContractCache();
      const { state, fetchFn } = loginStub({ metadata, steps: [...steps] });
      stubFetch(fetchFn);
      await seed(t, true);
      expect(state.bscHosts).toEqual([]);
      await drainScheduled(t);
    }
  });

  test("no reason or console line carries the seller id, the password or a token", async () => {
    const SECRET_ID = "seller-secret-id-482";
    const cases: Array<[string, { username: string } | 404, LoginStep[]]> = [
      ["saved on login 1", 404, [{ sellerId: SECRET_ID }]],
      ["saved on login 3", 404, [{}, {}, { sellerId: SECRET_ID }]],
      ["exhausted", 404, [{}]],
      ["login fails later", 404, [{}, "http500"]],
      ["login throws", 404, ["throw"]],
      ["success:false", SIGNED_IN, [{ fail: "BSC refused the sign-in." }]],
    ];
    for (const [, metadata, steps] of cases) {
      const t = convexTest(schema, modules);
      __resetContractCache();
      const { fetchFn } = loginStub({ metadata, steps });
      stubFetch(fetchFn);
      const con = captureConsole();

      const result = await seed(t, true);

      const haystack = [JSON.stringify(result), ...con.all()].join("\n");
      expect(haystack).not.toContain(SECRET_ID);
      expect(haystack).not.toContain(BSC_PASSWORD);
      expect(haystack).not.toMatch(/token/i);
      await drainScheduled(t);
      vi.restoreAllMocks();
    }
  });

  test("the login request carries the dev password only in its body, and the seed result never does", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{ sellerId: SELLER }] });
    stubFetch(fetchFn);

    const result = await seed(t, true);

    expect(state.loginBodies).toEqual([expect.objectContaining({ username: BSC_USERNAME, password: BSC_PASSWORD })]);
    expect(JSON.stringify(result)).not.toContain(BSC_PASSWORD);
    await drainScheduled(t);
  });

  test("fails closed when TESTING_RESET_SECRET is unset: throws, no login, nothing saved", async () => {
    const t = convexTest(schema, modules);
    const { state, fetchFn } = loginStub({ metadata: 404, steps: [{ sellerId: SELLER }] });
    stubFetch(fetchFn);
    delete process.env.TESTING_RESET_SECRET;

    await expect(seed(t, true)).rejects.toThrow(/not enabled/i);

    expect(state.logins).toBe(0);
    expect(await sellerIdOf(t)).toBeNull();
  });
});

// NEO-121 — the scan-visibility fixture. It exists so an E2E flow can look at a
// purchase row that has USPS scans on it; the only organic route to one is a
// real purchase plus three days of USPS, neither of which a CI run has.
//
// What matters here is that it writes through the SAME two internal writers the
// product uses, that it is idempotent (a re-run must not accumulate rows on a
// worker account that is reused for the life of the deployment), that it is
// scoped to the caller, and that it is dead on production.
describe("seedMyTestCredentials — label-scans fixture", () => {
  beforeEach(() => {
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    __resetContractCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEONBINDER_BROWSER_URL;
    delete process.env.DEV_EASYPOST_API_KEY;
  });

  async function readFixtureRows(
    t: ReturnType<typeof convexTest>,
    userId: string,
  ) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("labelPurchases").collect();
      return rows.filter((row) => row.userId === userId);
    });
  }

  test("files one purchase with the four-scan history, and calls no marketplace", async () => {
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    vi.stubGlobal("fetch", (async () => {
      fetchCalled = true;
      throw new Error("the scan fixture must not call out");
    }) as unknown as typeof fetch);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["label-scans"] });

    expect(result.seeded).toEqual([{ site: "label-scans", stored: true }]);
    // The selector is NOT a site: it must never fall through to the loop's
    // "no dev creds configured" skip branch, and it must not trigger a login.
    expect(fetchCalled).toBe(false);

    const rows = await readFixtureRows(t, USER_A);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.trackingCode).toHaveLength(31);
    expect(row.trackingStatus).toBe("out_for_delivery");
    expect(row.publicTrackingUrl).toMatch(/^https:\/\//);
    expect(row.scans?.map((scan: { message: string }) => scan.message)).toEqual([
      "Origin Processing Cancellation of Postage",
      "Origin Primary Processing",
      "Destination MMP Processing",
      "Delivery",
    ]);
    // Oldest → newest, and the newest is the one the row summarises.
    expect(row.scans?.at(-1)?.city).toBe("OLYMPIA");
    expect(row.lastScanAt).toBe(row.scans?.at(-1)?.at);
  });

  test("is idempotent: a second seed re-uses the row instead of filing another", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", (async () => {
      throw new Error("the scan fixture must not call out");
    }) as unknown as typeof fetch);

    const caller = t.withIdentity({ subject: USER_A });
    await caller.action(api.testing.seedMyTestCredentials, {
      sites: ["label-scans"],
    });
    const first = (await readFixtureRows(t, USER_A))[0];

    await caller.action(api.testing.seedMyTestCredentials, {
      sites: ["label-scans"],
    });
    const rows = await readFixtureRows(t, USER_A);

    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toEqual(first._id);
    // Re-applied rather than no-op'd: the snapshot's `updatedAt` is `now`, so
    // it clears the monotonic guard every run and the scan times stay recent.
    expect(rows[0].trackerUpdatedAt).toBeGreaterThanOrEqual(
      first.trackerUpdatedAt ?? 0,
    );
    expect(rows[0].scans).toHaveLength(4);
  });

  test("seeds only the caller — one worker's fixture is not another's", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", (async () => {
      throw new Error("the scan fixture must not call out");
    }) as unknown as typeof fetch);

    await t
      .withIdentity({ subject: USER_A })
      .action(api.testing.seedMyTestCredentials, { sites: ["label-scans"] });
    await t
      .withIdentity({ subject: USER_B })
      .action(api.testing.seedMyTestCredentials, { sites: ["label-scans"] });

    // Two rows carrying the SAME synthetic shipment id, one per user — which is
    // exactly why the lookup filters on userId as well as the index.
    expect(await readFixtureRows(t, USER_A)).toHaveLength(1);
    expect(await readFixtureRows(t, USER_B)).toHaveLength(1);
  });

  test("is dead on production: no enabling flag, no row", async () => {
    delete process.env.TESTING_RESET_SECRET;
    const t = convexTest(schema, modules);

    await expect(
      t
        .withIdentity({ subject: USER_A })
        .action(api.testing.seedMyTestCredentials, { sites: ["label-scans"] }),
    ).rejects.toThrow(/not enabled on this deployment/);

    expect(await readFixtureRows(t, USER_A)).toHaveLength(0);
  });
});
