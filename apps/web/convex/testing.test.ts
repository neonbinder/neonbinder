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

/** BSC's own profile route, where the seller id is read (`fetchBscSellerId`). */
const BSC_PROFILE_URL = "https://api-prod.buysportscards.com/marketplace/user/profile";

/** The error `AbortSignal.timeout` raises, as `bscSeller.telemetry.test.ts` models it. */
function timeoutError(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

/**
 * NEO-482 — a listing-on BSC seed reads the seller id through a BSC seller
 * session: GET /credentials/<key>/token on the browser service (the session's
 * token), then BSC's own `marketplace/user/profile`. Both are answered here
 * and counted; everything else goes to `inner`. `profile` is BSC's answer:
 * a seller id, a profile naming none, or a stall (`AbortSignal.timeout`).
 */
function withBscSellerProfile(
  inner: FetchStub,
  opts: {
    profile: { sellerId: string } | "no_seller" | "timeout";
    hits: { token: number; profile: number };
  },
): FetchStub {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/credentials/buysportscards-credentials-") && u.endsWith("/token")) {
      opts.hits.token += 1;
      return jsonResponse({ token: "bsc-session-token", expiresAt: Date.now() + 3_600_000 });
    }
    if (u === BSC_PROFILE_URL) {
      opts.hits.profile += 1;
      if (opts.profile === "timeout") throw timeoutError();
      return jsonResponse({
        sellerProfile: opts.profile === "no_seller" ? {} : { sellerId: opts.profile.sellerId },
      });
    }
    return inner(url, init);
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
    // NEO-482: a listing-on BSC seed also reads and saves the seller id.
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata, puts }), {
        profile: { sellerId: "seller-482" },
        hits: { token: 0, profile: 0 },
      }),
    );
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
// it), the login reads the id only best-effort, and the "already signed in"
// path never signs in, so without this the first Sync's drain had to read the
// id inside "Send changes". The seed reads it through a BSC seller session
// (`openBscSellerSession` → `fetchBscSellerId`, 5 s per attempt, one retry)
// only when listing is on and no id is stored.
describe("seedMyTestCredentials — NEO-482 seller id", () => {
  beforeEach(() => {
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    __resetContractCache();
    process.env.DEV_BSC_USERNAME = BSC_USERNAME;
    process.env.DEV_BSC_PASSWORD = BSC_PASSWORD;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.NEONBINDER_BROWSER_URL;
    delete process.env.DEV_BSC_USERNAME;
    delete process.env.DEV_BSC_PASSWORD;
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  /** The flag-only branch: the stored session is correct and renewable. */
  const SIGNED_IN = { username: BSC_USERNAME } as const;
  const READ_FAILED =
    "BuySportsCards seller id not saved: BuySportsCards left NeonBinder hanging with no answer.";
  const NO_SELLER =
    "BuySportsCards seller id not saved: BuySportsCards didn't say which seller account this is.";

  const seed = (t: ReturnType<typeof convexTest>, listing?: boolean) =>
    t.withIdentity({ subject: USER_A }).action(api.testing.seedMyTestCredentials, {
      sites: ["buysportscards"],
      ...(listing !== undefined ? { listing } : {}),
    });

  const sellerIdOf = (t: ReturnType<typeof convexTest>, userId = USER_A) =>
    t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      return profile?.marketplaceAccountIds?.bscSellerId ?? null;
    });

  const bscCredentialEntry = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", USER_A))
        .unique();
      return profile?.siteCredentials?.find((c) => c.site === "buysportscards");
    });

  const preseedSellerId = (t: ReturnType<typeof convexTest>, accountId: string) =>
    t.mutation(internal.userProfile.setMarketplaceAccountIdInternal, {
      userId: USER_A,
      site: "buysportscards",
      accountId,
    });

  /** The `bsc_seller_call` log lines for the seller profile read. */
  const sellerProfileCalls = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("{") && line.includes('"bsc_seller_call"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((o) => o.operation === "sellerProfile");

  /**
   * `modules` with the two userProfile writers tapped, so a test can see the
   * order the seed calls them in. convex-test runs a registered function's
   * `_handler` (validators come from `exportArgs`, kept as they are), so that
   * is what is wrapped.
   */
  const tappedModules = (order: string[]) => ({
    ...modules,
    "./userProfile.ts": async () => {
      const real = (await modules["./userProfile.ts"]()) as Record<string, unknown>;
      const tap = (name: string) => {
        const fn = real[name] as { _handler: (ctx: unknown, args: unknown) => unknown };
        return Object.assign(() => undefined, fn, {
          _handler: (ctx: unknown, args: unknown) => {
            order.push(name);
            return fn._handler(ctx, args);
          },
        });
      };
      return {
        ...real,
        setMarketplaceAccountIdInternal: tap("setMarketplaceAccountIdInternal"),
        updateSiteCredentialStatus: tap("updateSiteCredentialStatus"),
      };
    },
  });

  test("signed in already, listing on, no id stored: reads the profile once and saves the id before the status write", async () => {
    const order: string[] = [];
    const t = convexTest(schema, tappedModules(order));
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: SIGNED_IN, puts }), {
        profile: { sellerId: "seller-482" },
        hits,
      }),
    );
    const log = vi.spyOn(console, "log");

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(puts).toHaveLength(0); // still the no-login path
    expect(hits.profile).toBe(1);
    expect(sellerProfileCalls(log)).toEqual([
      expect.objectContaining({ operation: "sellerProfile", attempt: 1, outcome: "ok" }),
    ]);
    expect(await sellerIdOf(t)).toBe("seller-482");
    // A listing-on status write starts listing, so the id must already be there.
    expect(order).toEqual(["setMarketplaceAccountIdInternal", "updateSiteCredentialStatus"]);
    expect((await bscCredentialEntry(t))?.hasCredentials).toBe(true);
    await drainScheduled(t);
  });

  test("BSC stalls on both attempts: stored false with the read-failed reason, two attempts, no id saved", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: SIGNED_IN, puts }), { profile: "timeout", hits }),
    );
    const log = vi.spyOn(console, "log");

    expect((await seed(t, true)).seeded).toEqual([
      { site: "buysportscards", stored: false, reason: READ_FAILED },
    ]);

    expect(hits.profile).toBe(2);
    expect(sellerProfileCalls(log).map((c) => [c.attempt, c.outcome])).toEqual([
      [1, "timeout"],
      [2, "timeout"],
    ]);
    expect(await sellerIdOf(t)).toBeNull();
    // The session is closed on the failure path too: its one call summary,
    // named for the seed, covering both attempts.
    const summaries = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("{") && line.includes('"bsc_call_summary"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(summaries).toEqual([expect.objectContaining({ op: "seedSellerId", calls: 2, ok: 0 })]);
    // The stored sign-in is still good; only the id is missing.
    expect((await bscCredentialEntry(t))?.hasCredentials).toBe(true);
    await drainScheduled(t);
  });

  test("an id already stored: no session, no profile read, the id unchanged", async () => {
    const t = convexTest(schema, modules);
    await preseedSellerId(t, "seller-kept");
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: SIGNED_IN, puts }), {
        profile: { sellerId: "seller-other" },
        hits,
      }),
    );

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(hits).toEqual({ token: 0, profile: 0 });
    expect(await sellerIdOf(t)).toBe("seller-kept");
    await drainScheduled(t);
  });

  test("the store branch, the login returned the seller id: no profile read, the login's id kept", async () => {
    const t = convexTest(schema, modules);
    const hits = { token: 0, profile: 0 };
    const logins: string[] = [];
    stubFetch(
      withBscSellerProfile(
        async (url, init) => {
          const u = String(url);
          const method = init?.method ?? "GET";
          if (u.includes("/metadata")) return jsonResponse({ error: "Credentials not found" }, 404);
          if (method === "POST" && u.includes("/login/bsc")) {
            logins.push(u);
            return jsonResponse({ success: true, message: "ok", sellerId: "seller-from-login" });
          }
          throw new Error(`unexpected fetch: ${method} ${u}`);
        },
        { profile: { sellerId: "seller-from-profile" }, hits },
      ),
    );

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(logins).toHaveLength(1);
    expect(hits).toEqual({ token: 0, profile: 0 });
    expect(await sellerIdOf(t)).toBe("seller-from-login");
    await drainScheduled(t);
  });

  test("the store branch, the login returned no seller id: the seed reads and saves it", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: 404, puts }), {
        profile: { sellerId: "seller-482" },
        hits,
      }),
    );

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain("/login/bsc");
    expect(hits.profile).toBe(1);
    expect(await sellerIdOf(t)).toBe("seller-482");
    await drainScheduled(t);
  });

  test("BSC answers with no seller id: stored false with the didn't-say reason, nothing saved", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: SIGNED_IN, puts }), { profile: "no_seller", hits }),
    );

    expect((await seed(t, true)).seeded).toEqual([
      { site: "buysportscards", stored: false, reason: NO_SELLER },
    ]);

    // A profile naming no seller is an answer, not a failure: no retry.
    expect(hits.profile).toBe(1);
    expect(await sellerIdOf(t)).toBeNull();
    await drainScheduled(t);
  });

  test("a failure reason never carries the session token", async () => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata: SIGNED_IN, puts }), {
        profile: "timeout",
        hits: { token: 0, profile: 0 },
      }),
    );

    const reason = (await seed(t, true)).seeded[0].reason ?? "";
    expect(reason).not.toContain("bsc-session-token");
    expect(reason).not.toContain(BSC_USERNAME);
    await drainScheduled(t);
  });

  test.each([
    ["the flag-only branch", SIGNED_IN],
    ["the store branch", 404 as const],
  ])("listing off (%s): no seller session, no profile read", async (_name, metadata) => {
    const t = convexTest(schema, modules);
    const puts: Array<{ url: string; method: string; body: unknown }> = [];
    const hits = { token: 0, profile: 0 };
    stubFetch(
      withBscSellerProfile(makeCredentialFetch({ metadata, puts }), {
        profile: { sellerId: "seller-482" },
        hits,
      }),
    );

    expect((await seed(t)).seeded).toEqual([{ site: "buysportscards", stored: true }]);
    expect((await seed(t, false)).seeded).toEqual([{ site: "buysportscards", stored: true }]);

    expect(hits).toEqual({ token: 0, profile: 0 });
    expect(await sellerIdOf(t)).toBeNull();
  });

  test("BSC paused: skipped first, no browser-service or BSC call, no id", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    stubFetch(async (url, init) => {
      fetchCalled = true;
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${String(url)}`);
    });

    expect((await seed(t, true)).seeded).toEqual([{ site: "buysportscards", stored: false, skipped: true }]);

    expect(fetchCalled).toBe(false);
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
    expect(row.scans?.map((scan) => scan.message)).toEqual([
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
