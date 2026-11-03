/**
 * NEO-415 — the testing endpoints' eBay branches: `seedMyTestCredentials`
 * connects the sandbox seller through a refresh token (never a password) and
 * only on a testing deployment that is wired to eBay; `resetMyTestState`
 * clears the caller's own eBay link rows and settings and no one else's.
 * `fetch` is stubbed; nothing reaches the browser service or eBay.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = "user_ebaytest_aaaa";
const USER_B = "user_ebaytest_bbbb";
const BROWSER = "http://localhost:9999";

let calls: Array<{ method: string; path: string; body: any }>;
let connectAnswer: Response;

beforeEach(() => {
  calls = [];
  connectAnswer = Response.json({ username: "sandbox-seller", ebayUserId: "SBX-1", environment: "sandbox", expiresAt: 1 });
  process.env.NEONBINDER_BROWSER_URL = BROWSER;
  __resetContractCache();
  vi.stubEnv("TESTING_RESET_SECRET", "test-enabled");
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("DEV_EBAY_REFRESH_TOKEN", "sandbox-refresh-token");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/health") return Response.json({ status: "ok", environment: "test", contractVersion: 1 });
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (u.pathname === "/oauth/ebay/connect") return connectAnswer.clone();
    throw new Error(`unexpected ${u.pathname}`);
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.NEONBINDER_BROWSER_URL;
});

const seed = (t: ReturnType<typeof convexTest>, listing?: boolean) =>
  t.withIdentity({ subject: USER_A }).action(api.testing.seedMyTestCredentials, {
    sites: ["ebay"],
    ...(listing !== undefined ? { listing } : {}),
  });
const states = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("marketplaceListingStates").collect()).filter((r) => r.ownerId === USER_A));

describe("seedMyTestCredentials for ebay", () => {
  test("connects through the refresh-token grant with the user's own key and holds listing off by default", async () => {
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: true }]);
    expect(calls).toEqual([
      { method: "POST", path: "/oauth/ebay/connect", body: { key: `ebay-credentials-${USER_A}`, refreshToken: "sandbox-refresh-token" } },
    ]);
    const rows = await states(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "ebay", testListingOff: true });
    expect(rows[0].listingStartedAt).toBeUndefined();
    const settings = await t.run(async (ctx) => await ctx.db.query("ebaySellerSettings").collect());
    expect(settings[0]).toMatchObject({ ownerId: USER_A, ebayUsername: "sandbox-seller" });
  });

  test("listing: true starts listing", async () => {
    const t = convexTest(schema, modules);
    expect((await seed(t, true)).seeded).toEqual([{ site: "ebay", stored: true }]);
    expect((await states(t))[0].listingStartedAt).toBeTypeOf("number");
    await drainScheduled(t);
  });

  test("with no refresh token configured it skips without calling anything", async () => {
    vi.stubEnv("DEV_EBAY_REFRESH_TOKEN", "");
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: false, skipped: true }]);
    expect(calls).toEqual([]);
  });

  test("on a deployment not wired to eBay it skips", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "");
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: false, skipped: true }]);
    expect(calls).toEqual([]);
  });

  test("on eBay production it skips: the refresh-token seed is sandbox only", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: false, skipped: true }]);
    expect(calls).toEqual([]);
  });

  test("on a production eBay it skips: a refresh-token seed is a sandbox-only door", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: false, skipped: true }]);
    expect(calls).toEqual([]);
  });

  test("a paused eBay is skipped before anything is read", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    const t = convexTest(schema, modules);
    expect((await seed(t)).seeded).toEqual([{ site: "ebay", stored: false, skipped: true }]);
    expect(calls).toEqual([]);
  });

  test("a failed connect reports why, stores nothing, and never echoes the token", async () => {
    connectAnswer = Response.json({ error_class: "consent_refused" }, { status: 401 });
    const t = convexTest(schema, modules);
    const result = await seed(t);
    expect(result.seeded).toEqual([{ site: "ebay", stored: false, reason: "consentRefused" }]);
    expect(JSON.stringify(result)).not.toContain("sandbox-refresh-token");
    expect(await states(t)).toEqual([]);
  });

  test("a deployment without the testing flag refuses to seed at all", async () => {
    vi.stubEnv("TESTING_RESET_SECRET", "");
    const t = convexTest(schema, modules);
    await expect(seed(t)).rejects.toThrow(/not enabled/);
    expect(calls).toEqual([]);
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(api.testing.seedMyTestCredentials, { sites: ["ebay"] })).rejects.toThrow(/Not authenticated/);
  });
});

describe("resetMyTestState and the eBay tables", () => {
  async function seedOwner(t: ReturnType<typeof convexTest>, userId: string) {
    await t.run(async (ctx) => {
      const sel = await ctx.db.insert("selectorOptions", { level: "sport", value: `S ${userId}`, platformData: {}, isCustom: false, children: [], lastUpdated: 0 } as never);
      const card = await ctx.db.insert("cardChecklist", {
        selectorOptionId: sel, cardNumber: "1", cardName: "P", listingTitle: "t", sportId: sel, platformData: {}, isCustom: false, sortOrder: 0, lastUpdated: 0,
      } as never);
      await ctx.db.insert("marketplaceListingLinks", { ownerId: userId, platform: "ebay", cardId: card, conditionCode: "NM", sku: `NB2-${card}-NM`, status: "draft", lastUpdated: 0 });
      await ctx.db.insert("marketplaceListingLinks", { ownerId: userId, platform: "ebay", cardId: card, conditionCode: "EX", sku: `NB2-${card}-EX`, status: "draft", lastUpdated: 0 });
      await ctx.db.insert("ebaySellerSettings", { ownerId: userId, lastUpdated: 0 });
    });
  }
  const counts = (t: ReturnType<typeof convexTest>, userId: string) =>
    t.run(async (ctx) => ({
      links: (await ctx.db.query("marketplaceListingLinks").collect()).filter((r) => r.ownerId === userId).length,
      settings: (await ctx.db.query("ebaySellerSettings").collect()).filter((r) => r.ownerId === userId).length,
    }));

  test("clears the caller's link rows and settings, counts them, and leaves another owner's alone", async () => {
    const t = convexTest(schema, modules);
    await seedOwner(t, USER_A);
    await seedOwner(t, USER_B);
    const result = await t.withIdentity({ subject: USER_A }).mutation(api.testing.resetMyTestState, {});
    expect(result.marketplaceListing).toBe(3);
    expect(await counts(t, USER_A)).toEqual({ links: 0, settings: 0 });
    expect(await counts(t, USER_B)).toEqual({ links: 2, settings: 1 });
  });

  test("refuses off a testing deployment and clears nothing", async () => {
    const t = convexTest(schema, modules);
    await seedOwner(t, USER_A);
    vi.stubEnv("TESTING_RESET_SECRET", "");
    await expect(t.withIdentity({ subject: USER_A }).mutation(api.testing.resetMyTestState, {})).rejects.toThrow();
    expect(await counts(t, USER_A)).toEqual({ links: 2, settings: 1 });
  });
});
