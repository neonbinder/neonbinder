/**
 * NEO-415 — eBay in credentials.ts: the token refresh through the browser
 * service's /oauth/ebay/refresh route (every error class), connectEbay's
 * error mapping and bookkeeping, disconnectEbay, and saveCredentials
 * refusing a password for eBay. `fetch` is stubbed; nothing leaves the test.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_ebay_cred_1";

function res(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Calls = Array<{ url: string; method: string; body: unknown }>;

function stub(handler: (u: string, init?: RequestInit) => Response | Promise<Response>): Calls {
  const calls: Calls = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return res({ status: "ok", environment: "test", contractVersion: 1 });
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(u, init);
  }) as typeof fetch);
  return calls;
}

async function seedEbay(t: ReturnType<typeof convexTest>, extra: Record<string, unknown> = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: USER,
      siteCredentials: [{ site: "ebay", hasCredentials: true, lastUpdated: "2020-01-01T00:00:00.000Z", ...extra }],
    } as never);
  });
}

async function seedLinkRow(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const sel = await ctx.db.insert("selectorOptions", { level: "sport", value: "x", platformData: {}, isCustom: false, children: [], lastUpdated: 0 } as never);
    const card = await ctx.db.insert("cardChecklist", {
      selectorOptionId: sel, cardNumber: "1", cardName: "P", listingTitle: "t", sportId: sel, platformData: {}, isCustom: false, sortOrder: 0, lastUpdated: 0,
    } as never);
    await ctx.db.insert("marketplaceListingLinks", { ownerId: USER, platform: "ebay", cardId: card, conditionCode: "NM", sku: `NB2-${card}-NM`, offerId: "O1", status: "ended", lastUpdated: 0 });
  });
}

async function seedLinksOnAccount(t: ReturnType<typeof convexTest>, accountId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", { userId: USER, marketplaceAccountIds: { ebayUserId: accountId }, siteCredentials: [{ site: "ebay", hasCredentials: true, needsReauth: true }] } as never);
  });
  await seedLinkRow(t);
}

async function entry(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const p = await ctx.db.query("userProfiles").withIndex("by_user", (q) => q.eq("userId", USER)).unique();
    return p?.siteCredentials?.find((c) => c.site === "ebay") ?? null;
  });
}

beforeEach(() => {
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  __resetContractCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.NEONBINDER_BROWSER_URL;
});

describe("refreshSiteTokenForUser for ebay", () => {
  const refresh = (t: ReturnType<typeof convexTest>) =>
    t.action(internal.credentials.refreshSiteTokenForUser, { site: "ebay", userId: USER });

  test("a 200 refresh answers refreshed:true, posts the user's key, and clears needsReauth", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t, { needsReauth: true, needsReauthSince: Date.now() - 1000 });
    const calls = stub(() => res({ token: "x", expiresAt: 1 }));
    expect(await refresh(t)).toEqual({ refreshed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://localhost:9999/oauth/ebay/refresh", method: "POST", body: { key: `ebay-credentials-${USER}` } });
    expect((await entry(t))?.needsReauth).toBeFalsy();
  });

  test("401 reauth_required flags needsReauth and refreshes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    stub(() => res({ error_class: "reauth_required" }, 401));
    expect(await refresh(t)).toEqual({ refreshed: false });
    expect((await entry(t))?.needsReauth).toBe(true);
  });

  test.each([
    ["503 ebay_not_configured", () => res({ error_class: "ebay_not_configured" }, 503)],
    ["502 ebay_unavailable", () => res({ error_class: "ebay_unavailable" }, 502)],
    ["404 with a non-JSON body (an older service without the route)", () => res("<html>Not Found</html>", 404)],
    ["500 internal (the service's own store fault)", () => res({ error_class: "internal" }, 500)],
  ])("%s fails the refresh without flagging needsReauth", async (_label, make) => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    stub(make);
    expect(await refresh(t)).toEqual({ refreshed: false });
    expect((await entry(t))?.needsReauth).toBeFalsy();
  });

  test("a 401 whose body is not reauth_required does not flag needsReauth", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    stub(() => res("nope", 401));
    expect(await refresh(t)).toEqual({ refreshed: false });
    expect((await entry(t))?.needsReauth).toBeFalsy();
  });

  test("a network failure fails the refresh quietly", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    stub(() => {
      throw new TypeError("fetch failed");
    });
    expect(await refresh(t)).toEqual({ refreshed: false });
  });

  test("an unconfigured deployment never contacts the browser service", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const t = convexTest(schema, modules);
    await seedEbay(t);
    const calls = stub(() => res({}));
    expect(await refresh(t)).toEqual({ refreshed: false });
    expect(calls).toHaveLength(0);
  });

  test("getSiteTokenForUser answers null for ebay when unconfigured, without a request", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "");
    const t = convexTest(schema, modules);
    await seedEbay(t);
    const calls = stub(() => res({ token: "t" }));
    expect(await t.action(internal.credentials.getSiteTokenForUser, { site: "ebay", userId: USER })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("connectEbay", () => {
  beforeEach(() => vi.stubEnv("TESTING_RESET_SECRET", "s"));
  const connect = (t: ReturnType<typeof convexTest>, args: { code?: string; refreshToken?: string } = { code: "c1" }) =>
    t.action(internal.credentials.connectEbay, { userId: USER, listing: "testOff", ...args });

  test("refuses both-or-neither of code and refreshToken", async () => {
    const t = convexTest(schema, modules);
    const calls = stub(() => res({}));
    expect(await connect(t, {})).toEqual({ ok: false, error: "badRequest" });
    expect(await connect(t, { code: "a", refreshToken: "b" })).toEqual({ ok: false, error: "badRequest" });
    expect(calls).toHaveLength(0);
  });

  test("a refresh-token seed is refused off a testing deployment", async () => {
    vi.stubEnv("TESTING_RESET_SECRET", "");
    const t = convexTest(schema, modules);
    await expect(connect(t, { refreshToken: "r" })).rejects.toThrow(/not enabled/);
  });

  test("unconfigured answers notConfigured without a request", async () => {
    vi.stubEnv("EBAY_RU_NAME", "");
    const t = convexTest(schema, modules);
    const calls = stub(() => res({}));
    expect(await connect(t)).toEqual({ ok: false, error: "notConfigured" });
    expect(calls).toHaveLength(0);
  });

  test("a code over 4096 characters is a badRequest and is never sent", async () => {
    const t = convexTest(schema, modules);
    const calls = stub(() => res({}));
    expect(await connect(t, { code: "x".repeat(4097) })).toEqual({ ok: false, error: "badRequest" });
    expect(calls).toHaveLength(0);
  });

  test("success posts the key and code, records the account id and connection, and flags credentials", async () => {
    const t = convexTest(schema, modules);
    const calls = stub(() => res({ username: "slabking", ebayUserId: "EB-123", environment: "sandbox", expiresAt: 5 }));
    expect(await connect(t)).toEqual({ ok: true, username: "slabking", ebayUserId: "EB-123" });
    expect(calls[0]).toMatchObject({
      url: "http://localhost:9999/oauth/ebay/connect",
      body: { key: `ebay-credentials-${USER}`, code: "c1" },
    });
    // No link rows yet: the service is not told to hold the connect to an account.
    expect(calls[0].body).not.toHaveProperty("expectEbayUserId");
    expect((await entry(t))?.hasCredentials).toBe(true);
    const conn = await t.run(async (ctx) => ctx.db.query("ebaySellerSettings").collect());
    expect(conn).toHaveLength(1);
    expect(conn[0]).toMatchObject({ ownerId: USER, ebayUsername: "slabking" });
  });

  test("a missing username falls back to the eBay user id", async () => {
    const t = convexTest(schema, modules);
    stub(() => res({ ebayUserId: "EB-123", environment: "sandbox" }));
    expect(await connect(t)).toMatchObject({ ok: true, username: "EB-123" });
  });

  test("an answer without a usable eBay user id refuses to start listing", async () => {
    const t = convexTest(schema, modules);
    const calls = stub((u, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : res({ username: "slabking", ebayUserId: "bad id with spaces", environment: "sandbox" }),
    );
    expect(await connect(t)).toEqual({ ok: false, error: "unavailable" });
    expect((await entry(t))?.hasCredentials).toBeFalsy();
    // The session the service stored for an account NB cannot name is discarded.
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/credentials/ebay-credentials-${USER}`))).toBe(true);
  });

  test.each([
    ["401 consent_refused", res({ error_class: "consent_refused" }, 401), "consentRefused"],
    ["503 ebay_not_configured", res({ error_class: "ebay_not_configured" }, 503), "notConfigured"],
    ["400 bad_request", res({ error_class: "bad_request" }, 400), "badRequest"],
    ["500 internal", res({ error_class: "internal" }, 500), "internal"],
    ["502 ebay_unavailable", res({ error_class: "ebay_unavailable" }, 502), "unavailable"],
    ["404 non-JSON (older service)", res("<html/>", 404), "serviceNotReady"],
  ] as const)("%s maps to %s", async (_label, response, expected) => {
    const t = convexTest(schema, modules);
    stub(() => response.clone());
    expect(await connect(t)).toEqual({ ok: false, error: expected });
    expect((await entry(t))?.hasCredentials).toBeFalsy();
  });

  test.each([
    ["the other environment", { environment: "production" }],
    ["no environment", {}],
  ])("a session from %s than this deployment's is discarded, never recorded", async (_label, extra) => {
    const t = convexTest(schema, modules);
    const calls = stub((u, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : res({ username: "slabking", ebayUserId: "EB-9", ...extra }),
    );
    expect(await connect(t)).toEqual({ ok: false, error: "environmentMismatch" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await entry(t))?.hasCredentials).toBeFalsy();
    expect(await t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId ?? null)).toBeNull();
    expect(await t.run(async (ctx) => await ctx.db.query("ebaySellerSettings").collect())).toEqual([]);
  });

  test("a connect while link rows sit on one eBay account tells the service to accept only that seller", async () => {
    const t = convexTest(schema, modules);
    await seedLinksOnAccount(t, "EB-OLD");
    const calls = stub(() => res({ username: "slabking", ebayUserId: "EB-OLD", environment: "sandbox" }));
    expect(await connect(t)).toMatchObject({ ok: true, ebayUserId: "EB-OLD" });
    expect(calls[0].body).toMatchObject({ code: "c1", expectEbayUserId: "EB-OLD" });
  });

  test("the service refusing a different seller (409 account_mismatch) is an account switch, with nothing stored or discarded", async () => {
    const t = convexTest(schema, modules);
    await seedLinksOnAccount(t, "EB-OLD");
    const calls = stub(() => res({ error_class: "account_mismatch" }, 409));
    expect(await connect(t)).toEqual({ ok: false, error: "accountSwitch" });
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(await t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId)).toBe("EB-OLD");
  });

  test("if the service somehow stored a different seller, NB refuses it and discards that session", async () => {
    const t = convexTest(schema, modules);
    await seedLinksOnAccount(t, "EB-OLD");
    const calls = stub((u, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : res({ username: "other", ebayUserId: "EB-NEW", environment: "sandbox" }),
    );
    expect(await connect(t)).toEqual({ ok: false, error: "accountSwitch" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId)).toBe("EB-OLD");
  });

  test("a different seller is fine when no link rows tie NB to the old account", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", { userId: USER, marketplaceAccountIds: { ebayUserId: "EB-OLD" }, siteCredentials: [] } as never);
    });
    const calls = stub(() => res({ username: "new", ebayUserId: "EB-NEW", environment: "sandbox" }));
    expect(await connect(t)).toMatchObject({ ok: true, ebayUserId: "EB-NEW" });
    expect(calls[0].body).not.toHaveProperty("expectEbayUserId");
    expect(await t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId)).toBe("EB-NEW");
  });

  test("link rows left from a different account a Disconnect could not fully end are cleared when a new account connects", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", { userId: USER, siteCredentials: [] } as never);
      await ctx.db.insert("marketplaceListingStates", { ownerId: USER, platform: "ebay", platformAccountId: "EB-OLD", lastUpdated: 0 });
    });
    await seedLinkRow(t);
    stub(() => res({ username: "new", ebayUserId: "EB-NEW", environment: "sandbox" }));
    expect(await connect(t)).toMatchObject({ ok: true });
    expect(await t.run(async (ctx) => await ctx.db.query("marketplaceListingLinks").collect())).toEqual([]);
    await drainScheduled(t);
  });

  test("a refresh-token seed needs the sandbox", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const t = convexTest(schema, modules);
    await expect(connect(t, { refreshToken: "r" })).rejects.toThrow(/sandbox/);
  });

  test("a network failure is unavailable", async () => {
    const t = convexTest(schema, modules);
    stub(() => {
      throw new TypeError("down");
    });
    expect(await connect(t)).toEqual({ ok: false, error: "unavailable" });
  });

  test("a live credential lock answers busy", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER,
        siteCredentials: [{ site: "ebay", hasCredentials: false, lockedAt: Date.now(), lockedOp: "store", lockToken: "x" }],
      } as never);
    });
    const calls = stub(() => res({}));
    expect(await connect(t)).toEqual({ ok: false, error: "busy" });
    expect(calls).toHaveLength(0);
  });
});

describe("disconnectEbay", () => {
  test("deletes the stored session by key and clears the credential entry", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    const calls = stub(() => new Response(null, { status: 204 }));
    expect(await t.action(internal.credentials.disconnectEbay, { userId: USER })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: `http://localhost:9999/credentials/ebay-credentials-${USER}`, method: "DELETE" });
    expect((await entry(t))?.hasCredentials).toBeFalsy();
  });

  test("a 404 is already gone and still clears; a 500 keeps the entry", async () => {
    const t = convexTest(schema, modules);
    await seedEbay(t);
    stub(() => res({}, 404));
    expect(await t.action(internal.credentials.disconnectEbay, { userId: USER })).toEqual({ ok: true });
    const t2 = convexTest(schema, modules);
    await seedEbay(t2);
    stub(() => res({}, 500));
    expect(await t2.action(internal.credentials.disconnectEbay, { userId: USER })).toEqual({ ok: false });
    expect((await entry(t2))?.hasCredentials).toBe(true);
  });
});

describe("saveCredentials for ebay", () => {
  test("refuses a password for eBay without touching the browser service", async () => {
    const t = convexTest(schema, modules);
    const calls = stub(() => res({}));
    const asUser = t.withIdentity({ subject: USER, issuer: "https://clerk.test" });
    const r = await asUser.action(api.credentials.saveCredentials, { site: "ebay", username: "u", password: "p" } as never);
    expect(r).toMatchObject({ success: false });
    expect(calls).toHaveLength(0);
  });
});

describe("verifyEbayNotification", () => {
  const verify = (t: ReturnType<typeof convexTest>) =>
    t.action(internal.credentials.verifyEbayNotification, { signatureHeader: "sig", body: "{\"a\":1}" });

  test("posts the signature header and the raw body to the browser service", async () => {
    const t = convexTest(schema, modules);
    const calls = stub(() => res({ valid: true }));
    expect(await verify(t)).toBe("valid");
    expect(calls[0]).toMatchObject({ url: "http://localhost:9999/webhooks/ebay/verify", method: "POST", body: { signatureHeader: "sig", body: "{\"a\":1}" } });
  });

  test.each([
    ["a valid:false verdict", () => res({ valid: false }), "invalid"],
    ["503 ebay_not_configured", () => res({ error_class: "ebay_not_configured" }, 503), "notConfigured"],
    ["502 ebay_unavailable", () => res({ error_class: "ebay_unavailable" }, 502), "unavailable"],
    ["400 bad_request (a shape the service refuses)", () => res({ error_class: "bad_request" }, 400), "unavailable"],
    ["404 from an older service", () => res("<html/>", 404), "unavailable"],
    ["a 200 that is not a verdict", () => res({ nope: 1 }), "unavailable"],
    ["a 200 that is not JSON", () => res("ok"), "unavailable"],
  ] as const)("%s reads as %s", async (_label, make, expected) => {
    const t = convexTest(schema, modules);
    stub(make);
    expect(await verify(t)).toBe(expected);
  });

  test("a network failure is unavailable, never valid", async () => {
    const t = convexTest(schema, modules);
    stub(() => {
      throw new TypeError("down");
    });
    expect(await verify(t)).toBe("unavailable");
  });
});
