/**
 * NEO-415 — a collector's eBay connection and settings (`ebayConnect.ts`):
 * every public function refuses an anonymous caller, the Connect nonce
 * (one-use, expiring, replaced by a new press), the policy rules (an
 * ESE-only policy never fills the $20-and-up slot), "Set me up" filling only
 * empty slots, the ship-from location, Best Offer, the card weight,
 * Disconnect's ordering
 * (listings come down before the session is forgotten), and eBay's
 * Marketplace Account Deletion endpoint.
 *
 * `fetch` is stubbed for both the browser service (token exchange, session
 * delete) and a small in-memory eBay seller account. Nothing leaves the test.
 */
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import {
  CARD_WEIGHT_REFUSED,
  NB_POLICY_NAMES,
  SETUP_CHECK_LABEL,
  deletionRetryDelayMs,
  fulfillmentBody,
  logFulfillmentPoliciesRead,
  returnStateFor,
} from "./ebayConnect";
import { ebayReturnTarget } from "../lib/marketplace/ebay-oauth-return";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const creds = vi.hoisted(() => ({ token: "tok-1" as string | null }));

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => (creds.token === null ? null : { token: creds.token }),
    }),
    refreshSiteTokenForUser: internalAction({
      args: { site: v.string(), userId: v.string() },
      returns: v.any(),
      handler: async () => ({ refreshed: false }),
    }),
  };
});

const OWNER = "collector_conn_001";
const ME = { subject: OWNER, issuer: "https://clerk.test" };
const NOW = 1_700_000_000_000;
const BROWSER = "http://localhost:9999";
const ESE = "US_eBayStandardEnvelope";

// ── A fake seller account plus the browser service ───────────────────────────

interface FakePolicy {
  id: string;
  name: string;
  /** The DOMESTIC cost type a policy NB made was sent with (fixture policies leave it out). */
  costType?: string;
  services: Array<{ code: string; cost: string | null; free?: boolean }>;
}

class World {
  events: string[] = [];
  calls: Array<{ host: "browser" | "ebay"; method: string; path: string; json: any }> = [];
  optedIn = true;
  fulfillment: FakePolicy[] = [];
  payment: Array<{ id: string; name: string }> = [];
  returns: Array<{ id: string; name: string }> = [];
  shippingServices: Array<{
    shippingService: string;
    description?: string;
    internationalService?: boolean;
    validForSellingFlow?: boolean;
    shippingCostTypes?: string[];
    shippingCarrier?: string;
    shippingCategory?: string;
    minShippingTime?: number;
    maxShippingTime?: number;
    packageLimits?: Record<string, unknown>;
  }> = [
    { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCarrier: "USPS" },
    { shippingService: "USPSPriorityMail", validForSellingFlow: true, shippingCarrier: "USPS" },
    { shippingService: ESE, validForSellingFlow: true, shippingCarrier: "eBay Send" },
  ];
  /** What eBay answers a create of a location that is not there yet. */
  locationStatus = 204;
  /** The seller's inventory location on eBay, by key (it outlives a Disconnect). */
  locations = new Map<string, { address: Record<string, string>; status: "ENABLED" | "DISABLED" }>();
  failWithdraw = false;
  failBrowserDelete = false;
  connectResponse: Response = Response.json({ username: "slabking", ebayUserId: "EB-9", environment: "sandbox", expiresAt: 1 });
  verifyAnswer: Response = Response.json({ valid: true });
  next = 0;

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const json = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (u.origin === BROWSER) {
      if (u.pathname === "/health") return Response.json({ status: "ok", environment: "test", contractVersion: 1 });
      this.calls.push({ host: "browser", method, path: u.pathname, json });
      if (u.pathname === "/oauth/ebay/connect") return this.connectResponse.clone();
      if (u.pathname === "/webhooks/ebay/verify") return this.verifyAnswer.clone();
      if (method === "GET" && /^\/credentials\/[^/]+\/token$/.test(u.pathname)) {
        return creds.token === null
          ? Response.json({ error: "Credentials not found" }, { status: 404 })
          : Response.json({ token: creds.token, expiresAt: Date.now() + 60 * 60 * 1000 });
      }
      if (method === "DELETE" && u.pathname.startsWith("/credentials/")) {
        this.events.push("forget-session");
        return new Response(null, { status: this.failBrowserDelete ? 500 : 204 });
      }
      throw new Error(`unexpected browser call ${method} ${u.pathname}`);
    }
    this.calls.push({ host: "ebay", method, path: u.pathname, json });
    const ok = (body: unknown, status = 200) => Response.json(body, { status });
    const p = u.pathname;
    if (p === "/sell/account/v1/program/get_opted_in_programs") {
      return ok({ programs: this.optedIn ? [{ programType: "SELLING_POLICY_MANAGEMENT" }] : [] });
    }
    if (p === "/sell/account/v1/program/opt_in") {
      this.optedIn = true;
      return ok({});
    }
    if (p === "/sell/account/v1/fulfillment_policy" && method === "GET") {
      return ok({
        fulfillmentPolicies: this.fulfillment.map((f) => ({
          fulfillmentPolicyId: f.id,
          name: f.name,
          shippingOptions: [
            {
              optionType: "DOMESTIC",
              shippingServices: f.services.map((s) => ({
                shippingServiceCode: s.code,
                ...(s.cost === null ? {} : { shippingCost: { value: s.cost } }),
                freeShipping: s.free === true,
              })),
            },
          ],
        })),
      });
    }
    if (p === "/sell/account/v1/payment_policy" && method === "GET") {
      return ok({ paymentPolicies: this.payment.map((x) => ({ paymentPolicyId: x.id, name: x.name })) });
    }
    if (p === "/sell/account/v1/return_policy" && method === "GET") {
      return ok({ returnPolicies: this.returns.map((x) => ({ returnPolicyId: x.id, name: x.name, returnsAccepted: false })) });
    }
    if (p === "/sell/account/v1/fulfillment_policy/" && method === "POST") {
      const id = `F${++this.next}`;
      const option = json.shippingOptions[0];
      this.fulfillment.push({
        id,
        name: json.name,
        costType: option.costType,
        services: option.shippingServices.map((svc: any) => ({
          code: svc.shippingServiceCode,
          cost: svc.shippingCost?.value ?? null,
          free: svc.freeShipping,
        })),
      });
      return ok({ fulfillmentPolicyId: id }, 201);
    }
    if (p === "/sell/account/v1/payment_policy" && method === "POST") {
      const id = `P${++this.next}`;
      this.payment.push({ id, name: json.name });
      return ok({ paymentPolicyId: id }, 201);
    }
    if (p === "/sell/account/v1/return_policy" && method === "POST") {
      const id = `R${++this.next}`;
      this.returns.push({ id, name: json.name });
      return ok({ returnPolicyId: id }, 201);
    }
    if (p.endsWith("/get_shipping_services")) return ok({ shippingServices: this.shippingServices });
    const loc = /^\/sell\/inventory\/v1\/location\/([^/]+)(?:\/(update_location_details|enable))?$/.exec(p);
    if (loc) {
      const [, key, verb] = loc;
      const held = this.locations.get(key);
      if (method === "GET" && !verb) {
        return held ? ok({ merchantLocationKey: key, merchantLocationStatus: held.status, location: { address: held.address } }) : ok({ errors: [{ errorId: 25805 }] }, 404);
      }
      if (method === "POST" && !verb) {
        // What the sandbox did on a key it already held: 400, not the contract's 409.
        if (held) return ok({ errors: [{ errorId: 25803 }] }, 400);
        if (this.locationStatus < 300) this.locations.set(key, { address: json.location.address, status: "ENABLED" });
        return new Response(null, { status: this.locationStatus });
      }
      if (method === "POST" && verb === "update_location_details" && held) {
        held.address = json.location.address;
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && verb === "enable" && held) {
        held.status = "ENABLED";
        return ok({});
      }
      return ok({ errors: [{ errorId: 25805 }] }, 404);
    }
    const wd = /^\/sell\/inventory\/v1\/offer\/([^/]+)\/withdraw$/.exec(p);
    if (wd) {
      this.events.push(`withdraw:${wd[1]}`);
      return this.failWithdraw ? ok({ errors: [{ errorId: 1 }] }, 500) : ok({});
    }
    throw new Error(`unexpected eBay call ${method} ${p}`);
  }) as typeof fetch;

  ebayWrites() {
    return this.calls.filter((c) => c.host === "ebay" && c.method !== "GET");
  }
  ebayPosts(path: string) {
    return this.calls.filter((c) => c.host === "ebay" && c.method === "POST" && c.path === path);
  }
}

let world: World;

beforeEach(() => {
  world = new World();
  creds.token = "tok-1";
  process.env.NEONBINDER_BROWSER_URL = BROWSER;
  __resetContractCache();
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  vi.stubEnv("TESTING_RESET_SECRET", "");
  vi.stubGlobal("fetch", world.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.NEONBINDER_BROWSER_URL;
});

type T = ReturnType<typeof convexTest>;

async function setup(opts: { connected?: boolean; settings?: Record<string, unknown> | null } = {}) {
  const t = convexTest(schema, modules);
  const me = t.withIdentity(ME);
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId: OWNER,
      marketplaceAccountIds: { ebayUserId: "EB-1" },
      siteCredentials: opts.connected === false ? [] : [{ site: "ebay", hasCredentials: true }],
    } as never);
    if (opts.settings !== null && opts.settings !== undefined) {
      await ctx.db.insert("ebaySellerSettings", { ownerId: OWNER, ebayUsername: "slabking", lastUpdated: NOW, ...opts.settings } as never);
    }
  });
  return { t, me };
}
type S = Awaited<ReturnType<typeof setup>>;

const settingsRow = (s: S) => s.t.run(async (ctx) => await ctx.db.query("ebaySellerSettings").first());
const fulfillmentNames = () => world.fulfillment.map((f) => f.name);

// ── Authentication ───────────────────────────────────────────────────────────

describe("every public function needs a signed-in caller", () => {
  test("anonymous callers are refused and nothing is written or sent", async () => {
    const t = convexTest(schema, modules);
    const attempts: Array<() => Promise<unknown>> = [
      () => t.query(api.ebayConnect.connectionState, {}),
      () => t.mutation(api.ebayConnect.beginConnect, {}),
      () => t.mutation(api.ebayConnect.setBestOffer, { on: false }),
      () => t.mutation(api.ebayConnect.setCardWeight, { ounces: 2 }),
      () => t.action(api.ebayConnect.completeConnect, { code: "c", state: "s" }),
      () => t.action(api.ebayConnect.disconnect, {}),
      () => t.action(api.ebayConnect.readPolicies, {}),
      () => t.action(api.ebayConnect.createStandardPolicies, {}),
      () => t.action(api.ebayConnect.savePolicies, { paymentPolicyId: "x" }),
      () => t.action(api.ebayConnect.saveLocation, { postalCode: "53703", city: "Madison", stateOrProvince: "WI" }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/Not authenticated/);
    expect(await t.run(async (ctx) => ctx.db.query("ebaySellerSettings").collect())).toEqual([]);
    expect(world.calls).toEqual([]);
  });
});

// ── connectionState ──────────────────────────────────────────────────────────

describe("connectionState", () => {
  test("an unconfigured deployment says so, with nothing to connect to", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const s = await setup({ connected: false });
    const st = await s.me.query(api.ebayConnect.connectionState, {});
    expect(st).toMatchObject({ configured: false, environment: null, status: "notConnected", ebayUsername: null, setupComplete: false });
    expect(st.missing).toEqual(["location", "shippingUnder20", "shipping20Plus", "payment", "returns"]);
    expect(st.settings.bestOffer).toBe(true);
    // No settings row yet: a single card weighs the default 1 oz.
    expect(st.cardWeightOz).toBe(1);
  });

  test("reads the stored card weight; a row without one reads 1", async () => {
    const s = await setup({ settings: {} });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).cardWeightOz).toBe(1);
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").first();
      await ctx.db.patch(row!._id, { cardWeightOz: 3 });
    });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).cardWeightOz).toBe(3);
  });

  test("connected with complete settings is setupComplete; a missing slot is named", async () => {
    const s = await setup({
      settings: {
        fulfillmentPolicyUnder20Id: "a",
        fulfillmentPolicy20PlusId: "b",
        paymentPolicyId: "c",
        returnPolicyId: "d",
        merchantLocationKey: "k",
        location: { postalCode: "53703", city: "Madison", stateOrProvince: "WI" },
        connectedAt: NOW,
      },
    });
    const st = await s.me.query(api.ebayConnect.connectionState, {});
    expect(st).toMatchObject({ configured: true, environment: "sandbox", status: "connected", ebayUsername: "slabking", since: NOW, setupComplete: true, missing: [] });
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").first();
      await ctx.db.patch(row!._id, { paymentPolicyId: undefined });
    });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).missing).toEqual(["payment"]);
  });

  test("never returns the connect nonce", async () => {
    const s = await setup({ settings: { connectNonce: "SECRET-NONCE", connectNonceAt: NOW } });
    expect(JSON.stringify(await s.me.query(api.ebayConnect.connectionState, {}))).not.toContain("SECRET-NONCE");
  });

  test("status words: needsReauth, paused and not connected", async () => {
    const s = await setup({ settings: {} });
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { siteCredentials: [{ site: "ebay", hasCredentials: true, needsReauth: true }] } as never);
    });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).status).toBe("needsReauth");
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    expect((await s.me.query(api.ebayConnect.connectionState, {})).status).toBe("paused");
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { siteCredentials: [] } as never);
    });
    const st = await s.me.query(api.ebayConnect.connectionState, {});
    expect(st).toMatchObject({ status: "notConnected", ebayUsername: null, since: null });
  });
});

// ── Connect: nonce lifecycle ─────────────────────────────────────────────────

describe("beginConnect and completeConnect", () => {
  const stateOf = (r: { authorizeUrl: string } | { ok: false; error: string }) =>
    new URL((r as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") as string;

  test("beginConnect stores a nonce and puts it in the consent URL as state", async () => {
    const s = await setup({ connected: false });
    const begun = await s.me.mutation(api.ebayConnect.beginConnect, {});
    const authorizeUrl = (begun as { authorizeUrl: string }).authorizeUrl;
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    const row = await settingsRow(s);
    expect(row?.connectNonce).toBe(stateOf(begun));
    expect(row?.connectNonce).toMatch(/^[0-9a-f]{48}$/);
  });

  // NEO-422: eBay returns to one fixed page on the production site; the origin
  // Connect was pressed on rides in the state so that page can send it home.
  const PREVIEW = "https://neonbinder-abc123def-neon-binder.vercel.app";

  test("a Connect from a preview folds its origin into the state, which the return page reads back and completeConnect accepts whole", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin: PREVIEW }));
    expect(state).toMatch(/^[0-9a-f]{48}\.[A-Za-z0-9_-]+$/);
    // The whole state is what is kept, so the comparison on return is unchanged.
    expect((await settingsRow(s))?.connectNonce).toBe(state);
    // The sandbox return page on production forwards it to the preview, query intact.
    const search = `?code=v%5E1.1%23abc&state=${state}&expires_in=299`;
    expect(ebayReturnTarget(search, "https://www.neonbinder.io", "sandbox")).toEqual({
      ok: true,
      url: `${PREVIEW}/profile/ebay${search}`,
    });
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "v%5E1.1%23abc", state });
    expect(r).toEqual({ ok: true, ebayUsername: "slabking" });
    expect((await settingsRow(s))?.connectNonce).toBeUndefined();
    await drainScheduled(s.t);
  });

  test("the nonce alone does not complete a composite state", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin: PREVIEW }));
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state: state.split(".")[0] });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect((await settingsRow(s))?.connectNonce).toBe(state);
    expect(world.calls).toEqual([]);
  });

  test("a junk returnOrigin never reaches the state: the bare nonce is used, which keeps the return on its own origin", async () => {
    const s = await setup({ connected: false });
    const junk = [
      "",
      "not a url",
      "javascript:alert(1)",
      "ftp://neonbinder.io",
      "https://neonbinder.io/",
      "https://neonbinder.io/profile/ebay",
      "https://user@neonbinder.io",
      "https://NEONBINDER.io",
      "https://neonbinder.io:443",
      "https://neonbinder.io\\@evil.test",
      `https://${"a".repeat(300)}.test`,
    ];
    for (const returnOrigin of junk) {
      const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin }));
      expect(state, returnOrigin).toMatch(/^[0-9a-f]{48}$/);
      expect((await settingsRow(s))?.connectNonce).toBe(state);
    }
  });

  test("returnStateFor: every origin the return pages forward to fits the state cap; one that cannot fit falls back", () => {
    const nonce = "f".repeat(48);
    for (const origin of [PREVIEW, "https://www.neonbinder.io", "https://neonbinder.io", "http://localhost:3000", "http://127.0.0.1:65535"]) {
      const state = returnStateFor(nonce, origin, "sandbox");
      expect(state.length, origin).toBeLessThanOrEqual(128);
      expect(state.startsWith(`${nonce}.`), origin).toBe(true);
      expect(ebayReturnTarget(`?state=${state}`, "https://www.neonbinder.io", "sandbox"), origin).toEqual({
        ok: true,
        url: `${origin}/profile/ebay?state=${state}`,
      });
    }
    // A bare origin too long to fit 128 is one no return page forwards to anyway.
    expect(returnStateFor(nonce, `https://${"a".repeat(60)}.test`, "sandbox")).toBe(nonce);
    expect(returnStateFor(nonce, undefined, "sandbox")).toBe(nonce);
  });

  test("returnStateFor encodes only what the keyset's return page would forward to", () => {
    const nonce = "f".repeat(48);
    // Production keys → the production page: NB's production origins only.
    for (const origin of ["https://www.neonbinder.io", "https://neonbinder.io"]) {
      const state = returnStateFor(nonce, origin, "production");
      expect(state.startsWith(`${nonce}.`), origin).toBe(true);
      expect(ebayReturnTarget(`?state=${state}`, "https://www.neonbinder.io", "production"), origin).toEqual({
        ok: true,
        url: `${origin}/profile/ebay?state=${state}`,
      });
    }
    for (const origin of [PREVIEW, "http://localhost:3000", "http://127.0.0.1:5173"]) {
      expect(returnStateFor(nonce, origin, "production"), origin).toBe(nonce);
      expect(returnStateFor(nonce, origin, "sandbox"), origin).not.toBe(nonce);
    }
    // Bare origins neither page forwards to: someone else's site, a Vercel branch alias, a foreign Vercel app.
    for (const origin of [
      "https://evil.test",
      "https://neonbinder-git-some-branch-neon-binder.vercel.app",
      "https://neonbinder-abc123def-someone-else.vercel.app",
      "https://localhost:3000",
    ]) {
      expect(returnStateFor(nonce, origin, "sandbox"), origin).toBe(nonce);
      expect(returnStateFor(nonce, origin, "production"), origin).toBe(nonce);
    }
  });

  test("on production eBay keys a Connect from a preview or local build gets the bare nonce; from production, its origin", async () => {
    vi.stubEnv("EBAY_ENVIRONMENT", "production");
    const s = await setup({ connected: false });
    for (const returnOrigin of [PREVIEW, "http://localhost:3000"]) {
      const begun = await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin });
      expect(new URL((begun as { authorizeUrl: string }).authorizeUrl).origin).toBe("https://auth.ebay.com");
      const state = stateOf(begun);
      expect(state, returnOrigin).toMatch(/^[0-9a-f]{48}$/);
      expect((await settingsRow(s))?.connectNonce).toBe(state);
    }
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin: "https://www.neonbinder.io" }));
    expect(state).toMatch(/^[0-9a-f]{48}\.[A-Za-z0-9_-]+$/);
    expect(ebayReturnTarget(`?code=c&state=${state}`, "https://www.neonbinder.io", "production")).toEqual({
      ok: true,
      url: `https://www.neonbinder.io/profile/ebay?code=c&state=${state}`,
    });
  });

  test("a composite state from a preview still goes through completeConnect's length check", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, { returnOrigin: PREVIEW }));
    expect(state.length).toBeLessThanOrEqual(128);
    expect((await s.me.action(api.ebayConnect.completeConnect, { code: "c", state: `${state}${"A".repeat(129 - state.length)}` })).ok).toBe(false);
    expect((await settingsRow(s))?.connectNonce).toBe(state);
  });

  test("a second press replaces the first nonce, which then no longer works", async () => {
    const s = await setup({ connected: false });
    const first = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    const second = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    expect(second).not.toBe(first);
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "c1", state: first });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(world.calls).toEqual([]);
  });

  test("beginConnect answers a sentence, and writes nothing, when eBay is not configured or paused", async () => {
    const s = await setup({ connected: false });
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    expect(await s.me.mutation(api.ebayConnect.beginConnect, {})).toMatchObject({ ok: false, error: expect.stringContaining("pause") });
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
    vi.stubEnv("EBAY_RU_NAME", "");
    expect(await s.me.mutation(api.ebayConnect.beginConnect, {})).toMatchObject({ ok: false, error: expect.stringContaining("isn't hooked up") });
    expect(await settingsRow(s)).toBeNull();
  });

  test("beginConnect is refused while eBay is connected and working: switching accounts goes through Disconnect", async () => {
    const s = await setup({ connected: true, settings: {} });
    const r = await s.me.mutation(api.ebayConnect.beginConnect, {});
    expect(r).toEqual({ ok: false, error: "Disconnect eBay first, then connect the other account." });
    expect((await settingsRow(s))?.connectNonce).toBeUndefined();
  });

  test("beginConnect is allowed when the connection needs signing in again", async () => {
    const s = await setup({ connected: true, settings: {} });
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { siteCredentials: [{ site: "ebay", hasCredentials: true, needsReauth: true }] } as never);
    });
    const r = await s.me.mutation(api.ebayConnect.beginConnect, {});
    expect("authorizeUrl" in r).toBe(true);
  });

  test("the right state connects: code goes to the browser service, username comes back, nonce is spent", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "v^1.1%23abc", state });
    expect(r).toEqual({ ok: true, ebayUsername: "slabking" });
    const connect = world.calls.find((c) => c.path === "/oauth/ebay/connect");
    // The URL-encoded code is decoded before the browser service sees it.
    expect(connect?.json).toEqual({ key: `ebay-credentials-${OWNER}`, code: "v^1.1#abc" });
    const row = await settingsRow(s);
    expect(row?.connectNonce).toBeUndefined();
    expect(row?.ebayUsername).toBe("slabking");
    await drainScheduled(s.t);
  });

  test("replaying a spent state is refused", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    world.calls = [];
    const again = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect(world.calls).toEqual([]);
    await drainScheduled(s.t);
  });

  test("a wrong state is refused and leaves the live nonce for the real redirect", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    const wrong = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state: "not-the-nonce" });
    expect(wrong).toMatchObject({ ok: false });
    expect((await settingsRow(s))?.connectNonce).toBe(state);
    expect(world.calls).toEqual([]);
    const right = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(right.ok).toBe(true);
    await drainScheduled(s.t);
  });

  test("an expired nonce is refused and cleared", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("ebaySellerSettings").first();
      await ctx.db.patch(row!._id, { connectNonceAt: Date.now() - 16 * 60 * 1000 });
    });
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    expect((await settingsRow(s))?.connectNonce).toBeUndefined();
    expect(world.calls).toEqual([]);
  });

  test("another collector's nonce is no good for this caller", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    const other = s.t.withIdentity({ subject: "someone_else", issuer: "https://clerk.test" });
    const r = await other.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(r.ok).toBe(false);
    expect(world.calls).toEqual([]);
    expect((await settingsRow(s))?.connectNonce).toBe(state);
  });

  test("a code or state of absurd length is refused before the nonce is spent", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    expect((await s.me.action(api.ebayConnect.completeConnect, { code: "x".repeat(5000), state })).ok).toBe(false);
    expect((await s.me.action(api.ebayConnect.completeConnect, { code: "c", state: "s".repeat(200) })).ok).toBe(false);
    expect((await s.me.action(api.ebayConnect.completeConnect, { code: "", state })).ok).toBe(false);
    expect((await settingsRow(s))?.connectNonce).toBe(state);
  });

  test("a malformed percent-escape in the code is refused with a sentence, not thrown", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "%E0%A4%A", state });
    expect(r).toMatchObject({ ok: false });
    expect(world.calls.filter((c) => c.path === "/oauth/ebay/connect")).toEqual([]);
  });

  test("eBay refusing consent comes back as an NB sentence", async () => {
    const s = await setup({ connected: false });
    const state = stateOf(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    world.connectResponse = Response.json({ error_class: "consent_refused" }, { status: 401 });
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("say yes") });
  });
});

// ── Policies ─────────────────────────────────────────────────────────────────

describe("savePolicies", () => {
  async function accountWithPolicies() {
    world.fulfillment = [
      { id: "F-ESE", name: "Envelope only", services: [{ code: ESE, cost: "1.00" }] },
      { id: "F-MIX", name: "Envelope or parcel", services: [{ code: ESE, cost: "1.00" }, { code: "USPSGroundAdvantage", cost: "4.99" }] },
      { id: "F-GA", name: "Ground", services: [{ code: "USPSGroundAdvantage", cost: "4.99" }] },
    ];
    world.payment = [{ id: "P1", name: "Pay" }];
    world.returns = [{ id: "R1", name: "Ret" }];
    return setup({ settings: {} });
  }

  test("an ESE-only policy is refused for $20 and up", async () => {
    const s = await accountWithPolicies();
    const r = await s.me.action(api.ebayConnect.savePolicies, { fulfillmentPolicy20PlusId: "F-ESE" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("under $20") });
    expect((await settingsRow(s))?.fulfillmentPolicy20PlusId).toBeUndefined();
  });

  test("ESE-only is fine for the under-$20 slot; a mixed or parcel policy is fine for $20+", async () => {
    const s = await accountWithPolicies();
    expect(await s.me.action(api.ebayConnect.savePolicies, { fulfillmentPolicyUnder20Id: "F-ESE", fulfillmentPolicy20PlusId: "F-MIX" })).toEqual({ ok: true });
    expect(await settingsRow(s)).toMatchObject({ fulfillmentPolicyUnder20Id: "F-ESE", fulfillmentPolicy20PlusId: "F-MIX" });
    expect(await s.me.action(api.ebayConnect.savePolicies, { fulfillmentPolicy20PlusId: "F-GA", paymentPolicyId: "P1", returnPolicyId: "R1" })).toEqual({ ok: true });
    expect(await settingsRow(s)).toMatchObject({ fulfillmentPolicy20PlusId: "F-GA", paymentPolicyId: "P1", returnPolicyId: "R1" });
  });

  test("a policy the account no longer has is refused, and nothing in the same save lands", async () => {
    const s = await accountWithPolicies();
    const r = await s.me.action(api.ebayConnect.savePolicies, { fulfillmentPolicyUnder20Id: "F-ESE", paymentPolicyId: "GONE" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("anymore") });
    expect((await settingsRow(s))?.fulfillmentPolicyUnder20Id).toBeUndefined();
  });

  test("empty and oversized ids are refused without asking eBay", async () => {
    const s = await accountWithPolicies();
    expect((await s.me.action(api.ebayConnect.savePolicies, { paymentPolicyId: "" })).ok).toBe(false);
    expect((await s.me.action(api.ebayConnect.savePolicies, { paymentPolicyId: "x".repeat(65) })).ok).toBe(false);
    expect(world.calls).toEqual([]);
  });

  test("not connected: told to connect first, nothing sent", async () => {
    const s = await setup({ connected: false, settings: {} });
    creds.token = null;
    const r = await s.me.action(api.ebayConnect.savePolicies, { paymentPolicyId: "P1" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Connect") });
    expect(world.calls).toEqual([]);
  });

  test("an account not in business policies reads as empty lists", async () => {
    world.optedIn = false;
    const s = await setup({ settings: {} });
    expect(await s.me.action(api.ebayConnect.readPolicies, {})).toEqual({ ok: true, fulfillment: [], payment: [], returns: [] });
  });

  test("a policy's summary names each service by eBay's own name from its metadata, never the code", async () => {
    world.shippingServices = [
      { shippingService: "USPSParcel", description: "USPS Ground Advantage", validForSellingFlow: true },
      { shippingService: ESE, description: "eBay Standard Envelope", validForSellingFlow: true },
    ];
    world.fulfillment = [
      { id: "F-1", name: "Tracked", services: [{ code: "USPSParcel", cost: null }] },
      { id: "F-2", name: "Mixed", services: [{ code: ESE, cost: "1.00" }, { code: "USPSParcel", cost: "4.99" }] },
      { id: "F-3", name: "Odd", services: [{ code: "SomeOtherCode", cost: "3.00" }] },
    ];
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.readPolicies, {});
    expect(r.ok && r.fulfillment.map((p) => p.summary)).toEqual([
      "USPS Ground Advantage, eBay's rate by weight",
      "Standard Envelope, $1.00; USPS Ground Advantage, $4.99",
      "eBay shipping, $3.00",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/USPSParcel|SomeOtherCode/);
  });

  test("the policies still load when eBay's shipping metadata does not answer (services read as eBay shipping)", async () => {
    world.fulfillment = [{ id: "F-1", name: "Tracked", services: [{ code: "USPSParcel", cost: null }] }];
    const s = await setup({ settings: {} });
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/get_shipping_services")) return Response.json({ errors: [{ errorId: 1 }] }, { status: 500 });
      return real(url, init);
    }) as typeof fetch);
    const r = await s.me.action(api.ebayConnect.readPolicies, {});
    expect(r.ok && r.fulfillment.map((p) => p.summary)).toEqual(["eBay shipping, eBay's rate by weight"]);
  });

  test("a refused or failed policy read says so in NB's words, never eBay's status or the call", async () => {
    const s = await setup({ settings: {} });
    const real = world.fetch;
    let status = 400;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/payment_policy")) return Response.json({ errors: [{ errorId: 20001 }] }, { status });
      return real(url, init);
    }) as typeof fetch);
    expect(await s.me.action(api.ebayConnect.readPolicies, {})).toEqual({
      ok: false,
      error: "eBay wouldn't hand over your policies just now. Try again in a bit.",
    });
    status = 503;
    expect(await s.me.action(api.ebayConnect.readPolicies, {})).toEqual({ ok: false, error: "eBay's not answering right now. Try again in a bit." });
  });

  test("a policy read logs one ebay_fulfillment_policies_read line with what each fulfillment policy carries", async () => {
    const s = await accountWithPolicies();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await s.me.action(api.ebayConnect.readPolicies, {});
    const lines = log.mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((l) => l.msg === "ebay_fulfillment_policies_read");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ platform: "ebay", operation: "readPolicies", count: 3, ms: expect.any(Number) });
    expect((lines[0].policies as Array<{ id: string }>).map((p) => p.id)).toEqual(["F-ESE", "F-MIX", "F-GA"]);
  });

  test("the policy-read line: body fields only, ids kept, strings redacted and capped, at most 10 policies", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const policy = (i: number) => ({
      fulfillmentPolicyId: `6219${i}000000`,
      name: i === 0 ? "NB Tracked seller@example.com" : `Policy ${i}`,
      marketplaceId: "EBAY_US",
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
      handlingTime: { value: 1, unit: "DAY" },
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "CALCULATED",
          shippingServices: [{ shippingServiceCode: "USPSGroundAdvantage", shippingCarrierCode: "USPS", freeShipping: false }],
        },
        { optionType: "INTERNATIONAL", costType: "FLAT_RATE", shippingServices: [{ shippingServiceCode: "X" }, { shippingServiceCode: "Y" }] },
      ],
      shipToLocations: { regionIncluded: [{ regionName: "US" }] },
    });
    logFulfillmentPoliciesRead("createStandardPolicies", { fulfillmentPolicies: Array.from({ length: 12 }, (_, i) => policy(i)) }, 42);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0][0])) as { policies: unknown[] } & Record<string, unknown>;
    expect(line).toMatchObject({ msg: "ebay_fulfillment_policies_read", platform: "ebay", operation: "createStandardPolicies", ms: 42, count: 12 });
    expect(line.policies).toHaveLength(10);
    expect(line.policies[0]).toEqual({
      id: "62190000000",
      name: "NB Tracked [redacted]",
      marketplaceId: "EBAY_US",
      categoryTypes: ["ALL_EXCLUDING_MOTORS_VEHICLES"],
      handlingTime: { value: 1, unit: "DAY" },
      domestic: [{ code: "USPSGroundAdvantage", carrier: "USPS", costType: "CALCULATED", free: false, cost: null }],
      international: 2,
    });
    expect(String(log.mock.calls[0][0])).not.toContain("example.com");
  });

  test("readPolicies tells the picker which fulfillment policies fit", async () => {
    const s = await accountWithPolicies();
    const r = await s.me.action(api.ebayConnect.readPolicies, {});
    expect(r.ok && r.fulfillment.map((p) => [p.id, p.eseFit, p.eseOnly])).toEqual([
      ["F-ESE", true, true],
      ["F-MIX", true, false],
      ["F-GA", false, false],
    ]);
  });
});

/** A saved ship-from location: Set me up makes calculated policies, which price from it. */
const SHIPS_FROM = {
  location: { postalCode: "53703", city: "Madison", stateOrProvince: "WI" },
  merchantLocationKey: "neonbinder-main",
};

describe("createStandardPolicies (Set me up)", () => {
  test("on a fresh account makes the three shipping policies, payment and returns, and fills the empty slots", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({
      ok: true,
      // The envelope last: eBay turning it down leaves the rest made.
      created: [NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free, NB_POLICY_NAMES.payment, NB_POLICY_NAMES.returns, NB_POLICY_NAMES.ese],
      policies: expect.any(Object),
    });
    expect(r).not.toHaveProperty("envelopeRefused");
    const row = await settingsRow(s);
    const idOf = (name: string) => world.fulfillment.find((f) => f.name === name)?.id;
    expect(row?.fulfillmentPolicyUnder20Id).toBe(idOf(NB_POLICY_NAMES.ese));
    expect(row?.fulfillmentPolicy20PlusId).toBe(idOf(NB_POLICY_NAMES.tracked));
    expect(row?.paymentPolicyId).toBe(world.payment[0].id);
    expect(row?.returnPolicyId).toBe(world.returns[0].id);
    // The under-$20 policy offers the envelope, then tracked; the $20+ ones use the Ground Advantage code eBay's metadata listed, alone.
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.ese)?.services.map((x) => x.code)).toEqual([ESE, "USPSGroundAdvantage"]);
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.tracked)?.services.map((x) => x.code)).toEqual(["USPSGroundAdvantage"]);
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.free)?.services[0]).toMatchObject({ cost: "0.00", free: true });
  });

  test("hands back the account's policies, what it had and what it made, as a read would: the page reads eBay no more", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", description: "USPS Ground Advantage", validForSellingFlow: true },
      { shippingService: ESE, description: "eBay Standard Envelope", validForSellingFlow: true },
    ];
    world.fulfillment = [{ id: "F-MINE", name: "My parcel", services: [{ code: "USPSGroundAdvantage", cost: "4.99" }] }];
    world.payment = [{ id: "P-MINE", name: "My pay" }];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    if (!r.ok) throw new Error(r.error);
    const idOf = (name: string) => world.fulfillment.find((f) => f.name === name)!.id;
    expect(r.policies).toEqual({
      fulfillment: [
        { id: "F-MINE", name: "My parcel", eseFit: false, eseOnly: false, freeShipping: false, summary: "USPS Ground Advantage, $4.99" },
        {
          id: idOf(NB_POLICY_NAMES.tracked),
          name: NB_POLICY_NAMES.tracked,
          eseFit: false,
          eseOnly: false,
          freeShipping: false,
          summary: "USPS Ground Advantage, eBay's rate by weight",
        },
        {
          id: idOf(NB_POLICY_NAMES.free),
          name: NB_POLICY_NAMES.free,
          eseFit: false,
          eseOnly: false,
          freeShipping: true,
          summary: "USPS Ground Advantage, free",
        },
        {
          id: idOf(NB_POLICY_NAMES.ese),
          name: NB_POLICY_NAMES.ese,
          eseFit: true,
          // Envelope beside tracked: a fit for under $20, and not envelope-only.
          eseOnly: false,
          freeShipping: false,
          summary: "Standard Envelope, eBay's rate by weight; USPS Ground Advantage, eBay's rate by weight",
        },
      ],
      payment: [{ id: "P-MINE", name: "My pay" }],
      returns: [{ id: world.returns[0].id, name: NB_POLICY_NAMES.returns, summary: "30 days, buyer pays return shipping" }],
    });
    // The shipping and payment lists are what reading the account now says, entry for entry.
    const read = await s.me.action(api.ebayConnect.readPolicies, {});
    expect(read.ok && { fulfillment: read.fulfillment, payment: read.payment }).toEqual({
      fulfillment: r.policies.fulfillment,
      payment: r.policies.payment,
    });
    await drainScheduled(s.t);
  });

  test("the envelope-or-tracked and tracked policies are calculated by weight (no NB amount); Free Shipping stays a $0 flat rate", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const sent = (name: string) => world.ebayPosts("/sell/account/v1/fulfillment_policy/").find((c) => c.json.name === name)?.json;
    const ground = { shippingCarrierCode: "USPS", shippingServiceCode: "USPSGroundAdvantage", freeShipping: false };
    const expected: Record<string, unknown[]> = {
      // Under $20: the buyer picks the envelope (carrier USPS, as eBay documents it) or tracked.
      [NB_POLICY_NAMES.ese]: [
        { shippingCarrierCode: "USPS", shippingServiceCode: ESE, freeShipping: false, sortOrder: 1 },
        { ...ground, sortOrder: 2 },
      ],
      // $20 and up: tracked alone, so a $20+ card never ships at the envelope's rate.
      [NB_POLICY_NAMES.tracked]: [{ ...ground, sortOrder: 1 }],
    };
    for (const [name, services] of Object.entries(expected)) {
      const body = sent(name);
      expect(body.shippingOptions).toHaveLength(1);
      expect(body.shippingOptions[0]).toMatchObject({ optionType: "DOMESTIC", costType: "CALCULATED" });
      expect(body.shippingOptions[0].shippingServices).toEqual(services);
      expect(body.shippingOptions[0].packageHandlingCost).toBeUndefined();
      expect(body.handlingTime).toEqual({ value: 1, unit: "DAY" });
    }
    const free = sent(NB_POLICY_NAMES.free);
    expect(free.shippingOptions[0]).toMatchObject({ optionType: "DOMESTIC", costType: "FLAT_RATE" });
    expect(free.shippingOptions[0].shippingServices[0]).toEqual({
      shippingCarrierCode: "USPS",
      shippingServiceCode: "USPSGroundAdvantage",
      shippingCost: { value: "0.00", currency: "USD" },
      freeShipping: true,
      sortOrder: 1,
    });
    // Read back, the calculated policies show as calculated.
    const read = await s.me.action(api.ebayConnect.readPolicies, {});
    const summary = (name: string) => (read.ok ? read.fulfillment.find((p) => p.name === name)?.summary : undefined);
    expect(summary(NB_POLICY_NAMES.ese)).toBe("Standard Envelope, eBay's rate by weight; eBay shipping, eBay's rate by weight");
    // The fake metadata gives Ground Advantage no name: the picker says "eBay shipping", never the code.
    expect(summary(NB_POLICY_NAMES.tracked)).toBe("eBay shipping, eBay's rate by weight");
  });

  test("without a saved ship-from location it makes nothing and says to save one first", async () => {
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Save where you ship from first") });
    expect(world.ebayWrites()).toEqual([]);
    expect(world.calls.filter((c) => c.host === "ebay")).toEqual([]);
    const row = await settingsRow(s);
    expect(row?.fulfillmentPolicyUnder20Id).toBeUndefined();
  });

  test.each([
    ["Standard Envelope", [{ shippingService: ESE, validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE"] }]],
    ["USPS Ground Advantage", [{ shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE"] }]],
  ])("when eBay's metadata says %s has no calculated rate, it makes nothing (NB never invents a rate)", async (service, extra) => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE", "CALCULATED"] },
      { shippingService: ESE, validForSellingFlow: true, shippingCostTypes: ["CALCULATED", "FLAT"] },
    ].map((x) => extra.find((e) => e.shippingService === x.shippingService) ?? x);
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining(service) });
    expect(world.ebayWrites()).toEqual([]);
  });

  test("eBay's metadata listing CALCULATED (any case, beside FLAT) is enough to make the calculated policies", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE", "CALCULATED"] },
      { shippingService: ESE, validForSellingFlow: true, shippingCostTypes: ["calculated", "FLAT"] },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok).toBe(true);
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.ese)?.costType).toBe("CALCULATED");
  });

  test("a Standard Envelope eBay's metadata does not list is never asked for: it makes nothing and says so", async () => {
    world.shippingServices = [{ shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["CALCULATED"] }];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Standard Envelope") });
    expect(world.ebayWrites()).toEqual([]);
  });

  test("each tracked service's carrier code is the one eBay's metadata lists for that exact code; the envelope's is always USPS", async () => {
    world.shippingServices = [
      { shippingService: "USPSParcel", description: "USPS Ground Advantage", validForSellingFlow: true, shippingCarrier: "USPS-FROM-METADATA" },
      { shippingService: ESE, description: "eBay Standard Envelope", validForSellingFlow: true, shippingCarrier: "ESE-CARRIER-FROM-METADATA" },
      // A service sharing a name with nothing NB sends: its carrier is never borrowed.
      { shippingService: "USPSPriority", description: "USPS Ground Advantage Priority", validForSellingFlow: true, shippingCarrier: "WRONG" },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(true);
    const carrierOf = (name: string) =>
      world.ebayPosts("/sell/account/v1/fulfillment_policy/").find((c) => c.json.name === name)?.json.shippingOptions[0].shippingServices[0]
        .shippingCarrierCode;
    // eBay documents the envelope under carrier USPS; a metadata carrier beside it was refused (20403).
    expect(carrierOf(NB_POLICY_NAMES.ese)).toBe("USPS");
    const envelopeServices = world
      .ebayPosts("/sell/account/v1/fulfillment_policy/")
      .find((c) => c.json.name === NB_POLICY_NAMES.ese)?.json.shippingOptions[0].shippingServices;
    expect(envelopeServices.map((x: any) => x.shippingCarrierCode)).toEqual(["USPS", "USPS-FROM-METADATA"]);
    expect(carrierOf(NB_POLICY_NAMES.tracked)).toBe("USPS-FROM-METADATA");
    expect(carrierOf(NB_POLICY_NAMES.free)).toBe("USPS-FROM-METADATA");
    await drainScheduled(s.t);
  });

  test("a service eBay lists without a carrier gets USPS: the envelope always, Ground Advantage as the fallback", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true },
      { shippingService: ESE, validForSellingFlow: true, shippingCarrier: "  " },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(true);
    const carrierOf = (name: string) =>
      world.ebayPosts("/sell/account/v1/fulfillment_policy/").find((c) => c.json.name === name)?.json.shippingOptions[0].shippingServices[0]
        .shippingCarrierCode;
    expect(carrierOf(NB_POLICY_NAMES.ese)).toBe("USPS");
    expect(carrierOf(NB_POLICY_NAMES.tracked)).toBe("USPS");
    expect(carrierOf(NB_POLICY_NAMES.free)).toBe("USPS");
    await drainScheduled(s.t);
  });

  test("a policy NB already made is reused by name, so a missing calculated rate does not block a second press", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE"] },
      { shippingService: ESE, validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE"] },
    ];
    const again = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(again).toEqual({ ok: true, created: [], policies: expect.any(Object) });
  });

  test("with tracked already made, a Ground Advantage without a calculated rate still blocks the envelope policy (it holds tracked too)", async () => {
    world.fulfillment = [{ id: "F-NB", name: NB_POLICY_NAMES.tracked, services: [{ code: "USPSGroundAdvantage", cost: null }] }];
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE"] },
      { shippingService: ESE, validForSellingFlow: true, shippingCostTypes: ["CALCULATED"] },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining("USPS Ground Advantage") });
    expect(world.ebayWrites()).toEqual([]);
  });

  test("the Ground Advantage code comes from eBay's metadata, not from NB", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage2", validForSellingFlow: true },
      { shippingService: ESE, validForSellingFlow: true },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.tracked)?.services[0].code).toBe("USPSGroundAdvantage2");
  });

  test("Ground Advantage behind an older code is found by eBay's name for it, and that code is what the policies send", async () => {
    // CI run 41545461855: the sandbox's metadata named no code "…GroundAdvantage…".
    world.shippingServices = [
      { shippingService: "USPSPriority", description: "USPS Priority Mail", validForSellingFlow: true },
      { shippingService: "USPSParcel", description: "USPS Ground Advantage", validForSellingFlow: true, shippingCostTypes: ["CALCULATED", "FLAT"] },
      { shippingService: ESE, description: "eBay Standard Envelope", validForSellingFlow: true, shippingCostTypes: ["CALCULATED", "FLAT"] },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok).toBe(true);
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.tracked)?.services[0].code).toBe("USPSParcel");
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.free)?.services[0].code).toBe("USPSParcel");
    expect(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.ese)?.services.map((x) => x.code)).toEqual([ESE, "USPSParcel"]);
    await drainScheduled(s.t);
  });

  test("without Ground Advantage in eBay's list it makes nothing and says why", async () => {
    world.shippingServices = [{ shippingService: "USPSPriorityMail", validForSellingFlow: true }];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Ground Advantage") });
    expect(world.ebayWrites()).toEqual([]);
  });

  test("opts the account into business policies first when it is not in", async () => {
    world.optedIn = false;
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok).toBe(true);
    expect(world.ebayPosts("/sell/account/v1/program/opt_in")).toHaveLength(1);
    expect(world.ebayPosts("/sell/account/v1/program/opt_in")[0].json).toEqual({ programType: "SELLING_POLICY_MANAGEMENT" });
  });

  test("a second press makes nothing new (idempotent by name)", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const before = world.fulfillment.length;
    const again = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(again).toEqual({ ok: true, created: [], policies: expect.any(Object) });
    expect(world.fulfillment).toHaveLength(before);
  });

  test("never replaces a slot the collector already chose", async () => {
    const s = await setup({ settings: { ...SHIPS_FROM, fulfillmentPolicyUnder20Id: "MINE-U20", paymentPolicyId: "MINE-PAY" } });
    world.payment = [{ id: "MINE-PAY", name: "My pay" }];
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const row = await settingsRow(s);
    expect(row?.fulfillmentPolicyUnder20Id).toBe("MINE-U20");
    expect(row?.paymentPolicyId).toBe("MINE-PAY");
    expect(row?.fulfillmentPolicy20PlusId).toBe(world.fulfillment.find((f) => f.name === NB_POLICY_NAMES.tracked)?.id);
  });

  test("keeps the seller's own payment and return policies: makes none, picks the only one, leaves several to the collector", async () => {
    world.payment = [{ id: "P-ONLY", name: "Mine" }];
    world.returns = [{ id: "R-A", name: "A" }, { id: "R-B", name: "B" }];
    const s = await setup({ settings: SHIPS_FROM });
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok && r.created).not.toContain(NB_POLICY_NAMES.payment);
    expect(r.ok && r.created).not.toContain(NB_POLICY_NAMES.returns);
    expect(world.ebayPosts("/sell/account/v1/payment_policy")).toEqual([]);
    expect(world.ebayPosts("/sell/account/v1/return_policy")).toEqual([]);
    const row = await settingsRow(s);
    expect(row?.paymentPolicyId).toBe("P-ONLY");
    expect(row?.returnPolicyId).toBeUndefined();
  });

  test.each([
    ["tracked", "the tracked USPS Ground Advantage policy", "for cards $20 and up"],
    ["free", "the free shipping policy", "Pick one of your own shipping policies"],
    ["payment", "the payment policy", "Make a payment policy on eBay"],
    ["returns", "the returns policy", "Make a return policy on eBay"],
  ] as const)("eBay refusing NB's %s policy says which one and what to do instead, never eBay's status or call", async (slot, which, todo) => {
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (init?.method === "POST" && body?.name === NB_POLICY_NAMES[slot]) {
        return Response.json({ errors: [{ errorId: 20403, message: "RAW-EBAY-TEXT" }] }, { status: 400 });
      }
      return real(url, init);
    }) as typeof fetch);
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(r.ok).toBe(false);
    const error = r.ok ? "" : r.error;
    expect(error).toContain(`eBay turned down ${which}, so Set me up stopped there.`);
    expect(error).toContain(todo);
    expect(error).not.toMatch(/answered|400|create_|RAW-EBAY-TEXT/);
    // The status, the call and eBay's error id are in the structured log instead.
    const logged = lines.filter((l) => l.includes('"ebay_seller_error"')).map((l) => JSON.parse(l));
    expect(logged).toContainEqual(expect.objectContaining({ httpStatus: 400, errorIds: [20403], operation: expect.stringMatching(/^create_/) }));
    // Set me up stopped at the refusal: the envelope, always last, was never asked for.
    expect(world.calls.some((c) => c.method === "POST" && c.json?.name === NB_POLICY_NAMES.ese)).toBe(false);
    await drainScheduled(s.t);
  });

  test("eBay busy while Set me up makes a policy: press again, nothing is made twice", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/fulfillment_policy/")) return Response.json({}, { status: 503 });
      return real(url, init);
    }) as typeof fetch);
    expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
      ok: false,
      error: "eBay's not answering right now. Press Set me up again in a bit; it never makes anything twice.",
    });
  });

  test("eBay refusing the business-policies opt-in, or its shipping services, says so in NB's words", async () => {
    world.optedIn = false;
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    let failing = "/program/opt_in";
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(failing)) return Response.json({ errors: [{ errorId: 1 }] }, { status: 400 });
      return real(url, init);
    }) as typeof fetch);
    expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
      ok: false,
      error: "eBay wouldn't switch on business policies for your account. Try Set me up again in a bit, or switch them on in eBay's Seller Hub.",
    });
    world.optedIn = true;
    failing = "/get_shipping_services";
    expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
      ok: false,
      error: "eBay wouldn't list its shipping services just now. Try Set me up again in a bit.",
    });
    expect(world.ebayPosts("/sell/account/v1/fulfillment_policy/")).toEqual([]);
  });

  test("eBay refusing the envelope policy logs what its own metadata said about each service it named, and nothing of the seller", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true, shippingCarrier: "USPS", shippingCostTypes: ["CALCULATED"] },
      {
        shippingService: ESE,
        description: "eBay Standard Envelope for eligible items up to $20",
        validForSellingFlow: true,
        shippingCarrier: "EBAY_SEND",
        shippingCategory: "STANDARD",
        minShippingTime: 3,
        maxShippingTime: 6,
        shippingCostTypes: ["CALCULATED", "FLAT"],
        packageLimits: { maxWeight: 3, weightUnit: "OUNCE" },
      },
      { shippingService: "US_eBayOtherSend", validForSellingFlow: true, shippingCarrier: "EBAY_SEND" },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    let refused = 0;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (init?.method === "POST" && body?.name === NB_POLICY_NAMES.ese) {
        refused++;
        return Response.json(
          {
            errors: [
              {
                errorId: 20403,
                message: "Invalid .",
                longMessage: "Please select a valid shipping service.",
                inputRefIds: ["service"],
                parameters: [{ name: "XPATH", value: "DomesticItemShippingService[0].shippingService" }],
              },
            ],
          },
          { status: 400 },
        );
      }
      return real(url, init);
    }) as typeof fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
        ok: true,
        created: [NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free, NB_POLICY_NAMES.payment, NB_POLICY_NAMES.returns],
        envelopeRefused: true,
        policies: expect.any(Object),
      });
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"ebay_policy_service_refused"'));
      // One line per service the policy named (eBay's answer does not say which it refused): envelope, then tracked.
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toMatchObject({
        policy: "ese",
        sent: { code: "USPSGroundAdvantage", carrier: "USPS", costType: "CALCULATED" },
        listed: true,
      });
      expect(JSON.parse(lines[0])).toEqual({
        msg: "ebay_policy_service_refused",
        platform: "ebay",
        operation: "createStandardPolicies",
        policy: "ese",
        httpStatus: 400,
        errorIds: [20403],
        // USPS beside the envelope whatever the metadata lists, as eBay documents it.
        sent: { code: ESE, carrier: "USPS", costType: "CALCULATED" },
        servicesListed: 3,
        listed: true,
        metadata: {
          description: "eBay Standard Envelope for eligible items up to $20",
          carrier: "EBAY_SEND",
          validForSellingFlow: true,
          costTypes: ["CALCULATED", "FLAT"],
          category: "STANDARD",
          international: false,
          minDays: 3,
          maxDays: 6,
          packageLimits: { maxWeight: 3, weightUnit: "OUNCE" },
        },
        sameCarrier: ["US_eBayOtherSend"],
      });
      // eBay's catalogue and what NB sent: never the token, the seller or a policy id.
      const everything = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0])).join("\n");
      expect(everything).not.toContain("tok-1");
      for (const line of lines) {
        expect(line).not.toContain("slabking");
        expect(line).not.toContain("EB-1");
      }
      // The envelope was asked for once, last.
      expect(refused).toBe(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test("a validForSellingFlow eBay left out is logged as absent, not as false", async () => {
    world.shippingServices = [
      { shippingService: "USPSGroundAdvantage", validForSellingFlow: true },
      { shippingService: ESE },
    ];
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (init?.method === "POST" && body?.name === NB_POLICY_NAMES.ese) {
        return Response.json({ errors: [{ errorId: 20403 }] }, { status: 400 });
      }
      return real(url, init);
    }) as typeof fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await s.me.action(api.ebayConnect.createStandardPolicies, {});
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"ebay_policy_service_refused"'));
      expect(JSON.parse(line ?? "{}")).toMatchObject({
        policy: "ese",
        listed: true,
        // No carrier in the metadata: NB sent USPS, and there is no carrier to list siblings under.
        sent: { code: ESE, carrier: "USPS", costType: "CALCULATED" },
        metadata: { validForSellingFlow: "absent", carrier: null, costTypes: [], packageLimits: null },
        sameCarrier: [],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a create that goes through logs no refusal line", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("ebay_policy_service_refused"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("if a policy fails mid-way, what was made is kept and found by name next time", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    let posts = 0;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/fulfillment_policy/") && ++posts === 2) return Response.json({ errors: [{ errorId: 1, message: "RAW" }] }, { status: 500 });
      return real(url, init);
    }) as typeof fetch);
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("RAW");
    // Tracked first, then free (refused here): tracked stays made and fills its slot.
    expect(fulfillmentNames()).toEqual([NB_POLICY_NAMES.tracked]);
    expect((await settingsRow(s))?.fulfillmentPolicy20PlusId).toBe(world.fulfillment[0].id);
  });

  test("eBay turning down the envelope keeps everything made before it, fills those slots, leaves cards under $20 empty, deletes nothing", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (init?.method === "POST" && body?.name === NB_POLICY_NAMES.ese) {
        return Response.json({ errors: [{ errorId: 20403, longMessage: "RAW-EBAY-TEXT" }] }, { status: 400 });
      }
      return real(url, init);
    }) as typeof fetch);
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r).toEqual({
      ok: true,
      created: [NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free, NB_POLICY_NAMES.payment, NB_POLICY_NAMES.returns],
      envelopeRefused: true,
      policies: expect.any(Object),
    });
    expect(JSON.stringify(r)).not.toContain("RAW-EBAY-TEXT");
    // The refused envelope is in no list: only what eBay made is.
    expect(r.ok && r.policies.fulfillment.map((p) => p.name)).toEqual([NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free]);
    expect(fulfillmentNames()).toEqual([NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free]);
    const row = await settingsRow(s);
    expect(row?.fulfillmentPolicy20PlusId).toBe(world.fulfillment[0].id);
    expect(row?.paymentPolicyId).toBe(world.payment[0].id);
    expect(row?.returnPolicyId).toBe(world.returns[0].id);
    // Cards under $20 stay the collector's pick: never a parcel policy put there for them.
    expect(row?.fulfillmentPolicyUnder20Id).toBeUndefined();
    // Nothing was taken down on eBay.
    expect(world.calls.filter((c) => c.host === "ebay" && c.method === "DELETE")).toEqual([]);

    // Pressing again: the rest is found by name, only the envelope is asked for again.
    const again = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(again).toEqual({ ok: true, created: [], envelopeRefused: true, policies: expect.any(Object) });
    expect(fulfillmentNames()).toEqual([NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free]);
  });

  test("eBay busy on the envelope is not a refusal: it stops and says press again, keeping what was made", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (init?.method === "POST" && body?.name === NB_POLICY_NAMES.ese) return Response.json({}, { status: 503 });
      return real(url, init);
    }) as typeof fetch);
    expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
      ok: false,
      error: "eBay's not answering right now. Press Set me up again in a bit; it never makes anything twice.",
    });
    expect(fulfillmentNames()).toEqual([NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free]);
    expect((await settingsRow(s))?.fulfillmentPolicy20PlusId).toBe(world.fulfillment[0].id);
  });
});

// ── Set me up's progress ledger ──────────────────────────────────────────────

/** A ledger as "step:status" strings, in order. */
type Step = { step: string; label: string; status: string };
const lineOf = (steps: readonly Step[] | undefined) => (steps ?? []).map((x) => `${x.step}:${x.status}`);
const progressOf = async (s: S) => (await settingsRow(s))?.setupProgress;

/**
 * Wraps the fake eBay so every policy create first records the ledger as it
 * stands at that moment (the step being made should read `working`), then
 * answers as `answer` says (default: the fake's own create).
 */
function recordLedgerAtEachCreate(s: S, answer?: (name: string) => Response | null | Promise<Response | null>) {
  const seen: Array<{ name: string; steps: string[] }> = [];
  const real = world.fetch;
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (init?.method === "POST" && typeof body?.name === "string" && /_policy\/?$/.test(new URL(String(url)).pathname)) {
      seen.push({ name: body.name, steps: lineOf((await progressOf(s))?.steps) });
      const r = await answer?.(body.name);
      if (r) return r;
    }
    return real(url, init);
  }) as typeof fetch);
  return seen;
}

describe("Set me up's progress (the page's step ledger)", () => {
  test("plans every step up front, writes each one working as it starts, and ticks it done as it lands", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const seen = recordLedgerAtEachCreate(s);
    const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(r.ok).toBe(true);
    // One snapshot per eBay create, in run order: everything before it done, it working, the rest waiting.
    expect(seen).toEqual([
      { name: NB_POLICY_NAMES.tracked, steps: ["check:done", "tracked:working", "free:waiting", "payment:waiting", "returns:waiting", "ese:waiting"] },
      { name: NB_POLICY_NAMES.free, steps: ["check:done", "tracked:done", "free:working", "payment:waiting", "returns:waiting", "ese:waiting"] },
      { name: NB_POLICY_NAMES.payment, steps: ["check:done", "tracked:done", "free:done", "payment:working", "returns:waiting", "ese:waiting"] },
      { name: NB_POLICY_NAMES.returns, steps: ["check:done", "tracked:done", "free:done", "payment:done", "returns:working", "ese:waiting"] },
      { name: NB_POLICY_NAMES.ese, steps: ["check:done", "tracked:done", "free:done", "payment:done", "returns:done", "ese:working"] },
    ]);
    const progress = await progressOf(s);
    expect(progress?.steps).toEqual([
      { step: "check", label: SETUP_CHECK_LABEL, status: "done" },
      { step: "tracked", label: NB_POLICY_NAMES.tracked, status: "done" },
      { step: "free", label: NB_POLICY_NAMES.free, status: "done" },
      { step: "payment", label: NB_POLICY_NAMES.payment, status: "done" },
      { step: "returns", label: NB_POLICY_NAMES.returns, status: "done" },
      { step: "ese", label: NB_POLICY_NAMES.ese, status: "done" },
    ]);
    await drainScheduled(s.t);
  });

  test("the page reads it from connectionState: when the run started and its steps, never the writer's run id", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).setupProgress).toBeNull();
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const st = await s.me.query(api.ebayConnect.connectionState, {});
    const stored = await progressOf(s);
    expect(st.setupProgress).toEqual({ startedAt: stored?.startedAt, steps: stored?.steps });
    expect(st.setupProgress).not.toHaveProperty("runId");
    await drainScheduled(s.t);
  });

  test("a policy already on the account is listed as had and never made; payment and returns the seller has are not listed", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    const settled = (await settingsRow(s))?.lastUpdated;
    const seen = recordLedgerAtEachCreate(s);
    expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({ ok: true, created: [], policies: expect.any(Object) });
    expect(seen).toEqual([]);
    expect(lineOf((await progressOf(s))?.steps)).toEqual(["check:done", "tracked:had", "free:had", "ese:had"]);
    // Progress is not a settings change: nothing new filled, so lastUpdated stays.
    expect((await settingsRow(s))?.lastUpdated).toBe(settled);
    await drainScheduled(s.t);
  });

  test("eBay turning the envelope down shows it failed, everything before it done, and the run is still the partial success", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    recordLedgerAtEachCreate(s, (name) =>
      name === NB_POLICY_NAMES.ese ? Response.json({ errors: [{ errorId: 20403 }] }, { status: 400 }) : null,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = await s.me.action(api.ebayConnect.createStandardPolicies, {});
      expect(r).toMatchObject({ ok: true, envelopeRefused: true });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(lineOf((await progressOf(s))?.steps)).toEqual([
      "check:done",
      "tracked:done",
      "free:done",
      "payment:done",
      "returns:done",
      "ese:failed",
    ]);
    await drainScheduled(s.t);
  });

  test("an earlier refusal marks that step failed, and the steps after it are stopped, never asked for", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    const seen = recordLedgerAtEachCreate(s, (name) =>
      name === NB_POLICY_NAMES.free ? Response.json({ errors: [{ errorId: 20403 }] }, { status: 400 }) : null,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(false);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    expect(seen.map((x) => x.name)).toEqual([NB_POLICY_NAMES.tracked, NB_POLICY_NAMES.free]);
    expect(lineOf((await progressOf(s))?.steps)).toEqual([
      "check:done",
      "tracked:done",
      "free:failed",
      "payment:stopped",
      "returns:stopped",
      "ese:stopped",
    ]);
    await drainScheduled(s.t);
  });

  test("eBay busy on a step fails that step the same way (the run stops, nothing after it runs)", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    recordLedgerAtEachCreate(s, (name) => (name === NB_POLICY_NAMES.payment ? Response.json({}, { status: 503 }) : null));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await s.me.action(api.ebayConnect.createStandardPolicies, {})).toEqual({
        ok: false,
        error: "eBay's not answering right now. Press Set me up again in a bit; it never makes anything twice.",
      });
    } finally {
      log.mockRestore();
    }
    expect(lineOf((await progressOf(s))?.steps)).toEqual([
      "check:done",
      "tracked:done",
      "free:done",
      "payment:failed",
      "returns:stopped",
      "ese:stopped",
    ]);
    await drainScheduled(s.t);
  });

  test("a refusal while checking the account fails the check, with nothing planned after it", async () => {
    world.shippingServices = [{ shippingService: "USPSPriorityMail", validForSellingFlow: true }];
    const s = await setup({ settings: SHIPS_FROM });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect((await progressOf(s))?.steps).toEqual([{ step: "check", label: SETUP_CHECK_LABEL, status: "failed" }]);
  });

  test("no ship-from saved: refused before any eBay call, so no ledger is started", async () => {
    const s = await setup({ settings: {} });
    expect((await s.me.action(api.ebayConnect.createStandardPolicies, {})).ok).toBe(false);
    expect(await progressOf(s)).toBeUndefined();
  });

  test("a disconnect mid-run: the fill makes no settings row back, with the old account's policy ids or any other", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    let gone = false;
    recordLedgerAtEachCreate(s, async (name) => {
      if (name === NB_POLICY_NAMES.free && !gone) {
        gone = true;
        // Disconnect's bookkeeping lands while eBay is making the next policy.
        await s.t.mutation(internal.ebayConnect.forgetEbayConnection, { ownerId: OWNER });
      }
      return null;
    });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(gone).toBe(true);
    expect(await settingsRow(s)).toBeNull();
    await drainScheduled(s.t);
  });

  test("a reconnect mid-run (a fresh row, no run on it): the fill writes nothing to it", async () => {
    const s = await setup({ settings: SHIPS_FROM });
    let swapped = false;
    recordLedgerAtEachCreate(s, async (name) => {
      if (name === NB_POLICY_NAMES.free && !swapped) {
        swapped = true;
        await s.t.run(async (ctx) => {
          const old = await ctx.db.query("ebaySellerSettings").first();
          if (old) await ctx.db.delete(old._id);
          await ctx.db.insert("ebaySellerSettings", { ownerId: OWNER, ebayUsername: "newseller", connectedAt: NOW, lastUpdated: NOW });
        });
      }
      return null;
    });
    await s.me.action(api.ebayConnect.createStandardPolicies, {});
    expect(swapped).toBe(true);
    const row = await settingsRow(s);
    expect(row).toMatchObject({ ebayUsername: "newseller", lastUpdated: NOW });
    expect(row?.fulfillmentPolicyUnder20Id).toBeUndefined();
    expect(row?.fulfillmentPolicy20PlusId).toBeUndefined();
    expect(row?.paymentPolicyId).toBeUndefined();
    expect(row?.returnPolicyId).toBeUndefined();
    // And no ledger of the old run was written onto it.
    expect(row?.setupProgress).toBeUndefined();
    await drainScheduled(s.t);
  });

  describe("the stale-run guard (writeSetupProgress)", () => {
    const steps = (status: "working" | "done") => [{ step: "check" as const, label: SETUP_CHECK_LABEL, status }];
    const write = (s: S, runId: string, startedAt: number, status: "working" | "done", begin?: true) =>
      s.t.mutation(internal.ebayConnect.writeSetupProgress, {
        ownerId: OWNER,
        runId,
        startedAt,
        steps: steps(status),
        ...(begin ? { begin } : {}),
      });

    test("a newer run takes the row over; the older run's later writes are refused and change nothing", async () => {
      const s = await setup({ settings: SHIPS_FROM });
      expect(await write(s, "old", NOW, "working", true)).toBe(true);
      expect(await write(s, "new", NOW + 1, "working", true)).toBe(true);
      expect(await write(s, "old", NOW, "done")).toBe(false);
      expect(await progressOf(s)).toEqual({ runId: "new", startedAt: NOW + 1, steps: steps("working") });
      expect(await write(s, "new", NOW + 1, "done")).toBe(true);
      expect((await progressOf(s))?.steps).toEqual(steps("done"));
    });

    test("a run that begins after a newer one already has is refused", async () => {
      const s = await setup({ settings: SHIPS_FROM });
      expect(await write(s, "new", NOW + 5, "working", true)).toBe(true);
      expect(await write(s, "late", NOW, "working", true)).toBe(false);
      expect((await progressOf(s))?.runId).toBe("new");
    });

    test("a write with no run begun is refused", async () => {
      const s = await setup({ settings: SHIPS_FROM });
      expect(await write(s, "never-begun", NOW, "done")).toBe(false);
      expect(await progressOf(s)).toBeUndefined();
    });

    test("never makes a settings row (a disconnect mid-run deleted it; progress must not bring it back)", async () => {
      const s = await setup({ settings: null });
      expect(await write(s, "run", NOW, "working", true)).toBe(false);
      expect(await settingsRow(s)).toBeNull();
    });
  });
});

// ── Location and Best Offer ──────────────────────────────────────────────────

describe("saveLocation", () => {
  test("normalises, pushes the inventory location, and stores it with its key", async () => {
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.saveLocation, { postalCode: " 53703 ", city: "  Madison  ", stateOrProvince: "wi" });
    expect(r).toEqual({ ok: true });
    expect(await settingsRow(s)).toMatchObject({
      location: { postalCode: "53703", city: "Madison", stateOrProvince: "WI" },
      merchantLocationKey: "neonbinder-main",
    });
    expect(world.ebayPosts("/sell/inventory/v1/location/neonbinder-main")[0].json.location.address).toMatchObject({ country: "US", stateOrProvince: "WI" });
  });

  test.each([
    [{ postalCode: "5370", city: "Madison", stateOrProvince: "WI" }, "ZIP"],
    [{ postalCode: "53703", city: "   ", stateOrProvince: "WI" }, "city"],
    [{ postalCode: "53703", city: "Madison", stateOrProvince: "Wisconsin" }, "two-letter"],
  ])("a bad location %j is refused (%s) before eBay is asked", async (args, word) => {
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.saveLocation, args);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(word) });
    expect(world.calls).toEqual([]);
    expect((await settingsRow(s))?.location).toBeUndefined();
  });

  test("when eBay won't take the location nothing is stored, and the collector is told in NB's words", async () => {
    world.locationStatus = 400;
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.saveLocation, { postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    expect(r).toEqual({ ok: false, error: "eBay wouldn't take that address. Check the ZIP, city and state, then save again." });
    expect((await settingsRow(s))?.location).toBeUndefined();
  });

  test("the location already on eBay (it outlives a Disconnect) is updated, not created again", async () => {
    // CI run 41545461855: the desktop pass made the location; the mobile pass's
    // save then created it again, and the sandbox answered 400.
    world.locations.set("neonbinder-main", { address: { postalCode: "10001", city: "New York", stateOrProvince: "NY", country: "US" }, status: "ENABLED" });
    const s = await setup({ settings: {} });
    const r = await s.me.action(api.ebayConnect.saveLocation, { postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    expect(r).toEqual({ ok: true });
    expect(world.ebayPosts("/sell/inventory/v1/location/neonbinder-main")).toEqual([]);
    expect(world.locations.get("neonbinder-main")?.address).toMatchObject({ postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    expect((await settingsRow(s))?.location).toEqual({ postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    await drainScheduled(s.t);
  });

  test("saving twice works: the second save updates the location the first one made", async () => {
    const s = await setup({ settings: {} });
    expect(await s.me.action(api.ebayConnect.saveLocation, { postalCode: "53703", city: "Madison", stateOrProvince: "WI" })).toEqual({ ok: true });
    expect(await s.me.action(api.ebayConnect.saveLocation, { postalCode: "53711", city: "Madison", stateOrProvince: "WI" })).toEqual({ ok: true });
    expect(world.ebayPosts("/sell/inventory/v1/location/neonbinder-main")).toHaveLength(1);
    expect(world.locations.get("neonbinder-main")?.address.postalCode).toBe("53711");
    await drainScheduled(s.t);
  });
});

describe("setCardWeight", () => {
  const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  };

  test("a whole 1, 2 or 3 oz is stored and read back; repeating the same weight writes nothing", async () => {
    const s = await setup({ settings: {} });
    await s.me.mutation(api.ebayConnect.setCardWeight, { ounces: 1 });
    // 1 is the default: nothing to write.
    expect((await settingsRow(s))?.cardWeightOz).toBeUndefined();
    for (const ounces of [3, 2]) {
      await s.me.mutation(api.ebayConnect.setCardWeight, { ounces });
      expect((await settingsRow(s))?.cardWeightOz).toBe(ounces);
      expect((await s.me.query(api.ebayConnect.connectionState, {})).cardWeightOz).toBe(ounces);
    }
    const stamp = (await settingsRow(s))?.lastUpdated;
    await s.me.mutation(api.ebayConnect.setCardWeight, { ounces: 2 });
    expect((await settingsRow(s))?.lastUpdated).toBe(stamp);
    await drainScheduled(s.t);
  });

  test("makes the settings row when the collector has none yet", async () => {
    const s = await setup({ settings: undefined, connected: false });
    expect(await settingsRow(s)).toBeNull();
    await s.me.mutation(api.ebayConnect.setCardWeight, { ounces: 3 });
    expect((await settingsRow(s))?.cardWeightOz).toBe(3);
    await drainScheduled(s.t);
  });

  test.each([0, 4, 16, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s oz with NB's sentence and writes nothing (Standard Envelope tops out at 3 oz)",
    async (ounces) => {
      const s = await setup({ settings: {} });
      const before = await settingsRow(s);
      const refusal = await refusalOf(() => s.me.mutation(api.ebayConnect.setCardWeight, { ounces }));
      expect(refusal).toBeInstanceOf(ConvexError);
      expect((refusal as ConvexError<string>).data).toBe(CARD_WEIGHT_REFUSED);
      expect(CARD_WEIGHT_REFUSED).toContain("3 oz");
      expect(await settingsRow(s)).toEqual(before);
    },
  );

  test("a change re-queues the owner's listed cards when they list on eBay, so live listings get the new weight", async () => {
    const s = await setup({ settings: {} });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    });
    await s.me.mutation(api.ebayConnect.setCardWeight, { ounces: 3 });
    const scheduled = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name));
    expect(scheduled.some((n) => n.includes("startListingWalk"))).toBe(true);
    await drainScheduled(s.t);
  });
});

describe("setBestOffer", () => {
  test("turning it off and on writes the setting; repeating the same value writes nothing", async () => {
    const s = await setup({ settings: {} });
    await s.me.mutation(api.ebayConnect.setBestOffer, { on: true });
    expect((await settingsRow(s))?.bestOffer).toBeUndefined();
    await s.me.mutation(api.ebayConnect.setBestOffer, { on: false });
    expect((await settingsRow(s))?.bestOffer).toBe(false);
    const stamp = (await settingsRow(s))?.lastUpdated;
    await s.me.mutation(api.ebayConnect.setBestOffer, { on: false });
    expect((await settingsRow(s))?.lastUpdated).toBe(stamp);
    await s.me.mutation(api.ebayConnect.setBestOffer, { on: true });
    expect((await s.me.query(api.ebayConnect.connectionState, {})).settings.bestOffer).toBe(true);
    await drainScheduled(s.t);
  });

  test("a change re-queues the owner's listed cards when they list on eBay", async () => {
    const s = await setup({ settings: {} });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, lastUpdated: NOW });
    });
    await s.me.mutation(api.ebayConnect.setBestOffer, { on: false });
    const scheduled = await s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name));
    expect(scheduled.some((n) => n.includes("startListingWalk"))).toBe(true);
    await drainScheduled(s.t);
  });
});

// ── Disconnect ───────────────────────────────────────────────────────────────

describe("disconnect", () => {
  async function connectedWithListings() {
    const s = await setup({ settings: { connectedAt: NOW } });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, platformAccountId: "EB-1", lastUpdated: NOW });
      const sel = await ctx.db.insert("selectorOptions", { level: "sport", value: "x", platformData: {}, isCustom: false, children: [], lastUpdated: NOW } as never);
      const card = await ctx.db.insert("cardChecklist", {
        selectorOptionId: sel,
        cardNumber: "1",
        cardName: "P",
        listingTitle: "t",
        sportId: sel,
        platformData: {},
        isCustom: false,
        sortOrder: 0,
        lastUpdated: NOW,
      } as never);
      const link = (conditionCode: "NM" | "EX" | "VG" | "PR", status: "live" | "ended" | "draft", offerId: string) =>
        ctx.db.insert("marketplaceListingLinks", {
          ownerId: OWNER,
          platform: "ebay",
          cardId: card,
          conditionCode,
          sku: `NB2-${card}-${conditionCode}`,
          offerId,
          ...(status === "live" ? { listingId: `L-${offerId}` } : {}),
          status,
          lastUpdated: NOW,
        });
      await link("NM", "live", "O-LIVE-1");
      await link("EX", "live", "O-LIVE-2");
      await link("VG", "ended", "O-ENDED");
      await ctx.db.insert("marketplaceSales", {
        ownerId: OWNER,
        platform: "ebay",
        orderId: "ORD1",
        orderNo: "ORD1",
        orderDate: NOW,
        status: "PAID",
        totals: {},
        items: [],
        firstSeenAt: NOW,
        lastUpdated: NOW,
      } as never);
    });
    return s;
  }
  const links = (s: S) => s.t.run(async (ctx) => await ctx.db.query("marketplaceListingLinks").collect());

  test("takes every live listing down before the session is forgotten, then clears links, settings and the account id but keeps sales", async () => {
    const s = await connectedWithListings();
    const r = await s.me.action(api.ebayConnect.disconnect, {});
    expect(r).toEqual({ ok: true, notEnded: 0 });
    expect([...world.events].slice(0, 2).sort()).toEqual(["withdraw:O-LIVE-1", "withdraw:O-LIVE-2"]);
    expect(world.events.at(-1)).toBe("forget-session");
    expect(world.events).not.toContain("withdraw:O-ENDED");
    expect(await links(s)).toEqual([]);
    expect(await settingsRow(s)).toBeNull();
    expect(await s.t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId ?? null)).toBeNull();
    expect(await s.t.run(async (ctx) => ctx.db.query("marketplaceSales").collect())).toHaveLength(1);
    expect((await s.me.query(api.ebayConnect.connectionState, {})).status).toBe("notConnected");
  });

  test("listing stops before the first withdraw, so no drain can put a listing back", async () => {
    const s = await connectedWithListings();
    let startedWhenWithdrawn: number | undefined | "unset" = "unset";
    const real = world.fetch;
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/withdraw") && startedWhenWithdrawn === "unset") {
        const st = await s.t.run(async (ctx) => ctx.db.query("marketplaceListingStates").first());
        startedWhenWithdrawn = st?.listingStartedAt;
      }
      return real(url, init);
    }) as typeof fetch);
    await s.me.action(api.ebayConnect.disconnect, {});
    expect(startedWhenWithdrawn).toBeUndefined();
  });

  test("a listing eBay will not end is counted and its link kept live; the session still goes", async () => {
    world.failWithdraw = true;
    const s = await connectedWithListings();
    expect(await s.me.action(api.ebayConnect.disconnect, {})).toEqual({ ok: true, notEnded: 2 });
    expect(world.events.at(-1)).toBe("forget-session");
    expect(await settingsRow(s)).toBeNull();
    // Only the two rows still live survive; the ended one is gone.
    expect((await links(s)).map((l) => [l.conditionCode, l.status]).sort()).toEqual([["EX", "live"], ["NM", "live"]]);
  });

  test("with no eBay token at all nothing is withdrawn: every live listing counts as not ended, and the session still goes", async () => {
    creds.token = null;
    const s = await connectedWithListings();
    expect(await s.me.action(api.ebayConnect.disconnect, {})).toEqual({ ok: true, notEnded: 2 });
    expect(world.events).toEqual(["forget-session"]);
  });

  test("a paused eBay sends no withdraw", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    const s = await connectedWithListings();
    expect(await s.me.action(api.ebayConnect.disconnect, {})).toEqual({ ok: true, notEnded: 2 });
    expect(world.events).toEqual(["forget-session"]);
  });

  test("if the stored session cannot be deleted, links and settings are kept so a retry is possible", async () => {
    world.failBrowserDelete = true;
    const s = await connectedWithListings();
    expect(await s.me.action(api.ebayConnect.disconnect, {})).toEqual({ ok: false, notEnded: 0 });
    expect(await links(s)).toHaveLength(3);
    expect(await settingsRow(s)).not.toBeNull();
  });

  test("a drain that does not stand down within the wait refuses the disconnect and deletes nothing", async () => {
    const s = await connectedWithListings();
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { drainLeaseToken: "held-by-a-run", drainLeaseExpiresAt: Date.now() + 60 * 60 * 1000 });
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = s.me.action(api.ebayConnect.disconnect, {});
      for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(2_000);
      // The wait is measured on the wall clock: step it past the minute.
      const realNow = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60_000);
      for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toEqual({ ok: false, notEnded: 2 });
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
    expect(world.events).toEqual([]);
    expect(await links(s)).toHaveLength(3);
    expect(await settingsRow(s)).not.toBeNull();
    expect(await s.t.run(async (ctx) => (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId)).toBe("EB-1");
  });

  test("a reconnect to the same account after listings eBay would not end keeps those links; a different account clears them", async () => {
    world.failWithdraw = true;
    const s = await connectedWithListings();
    await s.me.action(api.ebayConnect.disconnect, {});
    world.failWithdraw = false;
    const state = stateOfBegun(await s.me.mutation(api.ebayConnect.beginConnect, {}));
    world.connectResponse = Response.json({ username: "someone-else", ebayUserId: "EB-OTHER", environment: "sandbox", expiresAt: 1 });
    const r = await s.me.action(api.ebayConnect.completeConnect, { code: "c", state });
    expect(r).toMatchObject({ ok: true });
    expect(await links(s)).toEqual([]);
    await drainScheduled(s.t);
  });
});

function stateOfBegun(r: { authorizeUrl: string } | { ok: false; error: string }): string {
  return new URL((r as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") as string;
}

// ── Marketplace Account Deletion ─────────────────────────────────────────────

describe("eBay Marketplace Account Deletion endpoint", () => {
  const PATH = "/webhooks/ebay/account-deletion";
  const ENDPOINT = "https://nb-test.convex.site/webhooks/ebay/account-deletion";
  const post = (t: T, body: unknown) => t.fetch(PATH, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const notice = (userId: string, username: string, topic = "MARKETPLACE_ACCOUNT_DELETION") => ({
    metadata: { topic, schemaVersion: "1.0" },
    notification: { notificationId: "n1", data: { username, userId, eiasToken: "e" } },
  });

  beforeEach(() => {
    vi.stubEnv("EBAY_DELETION_VERIFICATION_TOKEN", "verify-token-0123456789-0123456789-0123456789");
    vi.stubEnv("EBAY_DELETION_ENDPOINT_URL", ENDPOINT);
  });

  test("GET answers the challenge with sha256(code + token + endpoint) as hex", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(`${PATH}?challenge_code=abc123`, { method: "GET" });
    expect(res.status).toBe(200);
    const expected = createHash("sha256").update("abc123" + "verify-token-0123456789-0123456789-0123456789" + ENDPOINT).digest("hex");
    expect(await res.json()).toEqual({ challengeResponse: expected });
  });

  test("GET without the token or endpoint configured answers 503; without a challenge code, 400", async () => {
    const t = convexTest(schema, modules);
    expect((await t.fetch(`${PATH}`, { method: "GET" })).status).toBe(400);
    expect((await t.fetch(`${PATH}?challenge_code=${"x".repeat(600)}`, { method: "GET" })).status).toBe(400);
    vi.stubEnv("EBAY_DELETION_VERIFICATION_TOKEN", "");
    expect((await t.fetch(`${PATH}?challenge_code=a`, { method: "GET" })).status).toBe(503);
  });

  test("GET falls back to the deployment's site URL plus the route", async () => {
    vi.stubEnv("EBAY_DELETION_ENDPOINT_URL", "");
    vi.stubEnv("CONVEX_SITE_URL", "https://site.example/");
    const t = convexTest(schema, modules);
    const res = await t.fetch(`${PATH}?challenge_code=zz`, { method: "GET" });
    const expected = createHash("sha256").update("zz" + "verify-token-0123456789-0123456789-0123456789" + "https://site.example/webhooks/ebay/account-deletion").digest("hex");
    expect(await res.json()).toEqual({ challengeResponse: expected });
  });

  async function sellerWithData() {
    const s = await setup({ settings: { ebayUsername: "SlabKing" } });
    const cardAndCopy = await s.t.run(async (ctx) => {
      const sel = await ctx.db.insert("selectorOptions", { level: "sport", value: "x", platformData: {}, isCustom: false, children: [], lastUpdated: NOW } as never);
      const card = await ctx.db.insert("cardChecklist", {
        selectorOptionId: sel, cardNumber: "1", cardName: "P", listingTitle: "t", sportId: sel, platformData: {}, isCustom: false, sortOrder: 0, lastUpdated: NOW,
      } as never);
      await ctx.db.insert("marketplaceListingLinks", { ownerId: OWNER, platform: "ebay", cardId: card, conditionCode: "NM", sku: "S", status: "live", offerId: "O", listingId: "L", lastUpdated: NOW });
      await ctx.db.insert("marketplaceSales", { ownerId: OWNER, platform: "ebay", orderId: "O1", orderNo: "O1", orderDate: NOW, status: "PAID", totals: {}, items: [], firstSeenAt: NOW, lastUpdated: NOW } as never);
      await ctx.db.insert("marketplaceSales", { ownerId: OWNER, platform: "bsc", orderId: "B1", orderNo: "B1", orderDate: NOW, status: "SHIPPED", totals: {}, items: [], firstSeenAt: NOW, lastUpdated: NOW } as never);
      await ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "ebay", listingStartedAt: NOW, platformAccountId: "EB-1", lastUpdated: NOW });
      return card;
    });
    return { s, card: cardAndCopy };
  }
  const counts = (s: S) =>
    s.t.run(async (ctx) => ({
      links: (await ctx.db.query("marketplaceListingLinks").collect()).length,
      ebaySales: (await ctx.db.query("marketplaceSales").collect()).filter((x) => x.platform === "ebay").length,
      bscSales: (await ctx.db.query("marketplaceSales").collect()).filter((x) => x.platform === "bsc").length,
      settings: (await ctx.db.query("ebaySellerSettings").collect()).length,
      cards: (await ctx.db.query("cardChecklist").collect()).length,
      ebayUserId: (await ctx.db.query("userProfiles").first())?.marketplaceAccountIds?.ebayUserId ?? null,
    }));

  const signed = { "x-ebay-signature": "eyJhbGciOiJFQ0RTQSJ9.sig" };
  const postSigned = (t: T, body: unknown, headers: Record<string, string> = signed) =>
    t.fetch(PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const verifyCalls = () => world.calls.filter((c) => c.path === "/webhooks/ebay/verify");

  test("a verified notice for a connected seller deletes their NB-side eBay data and keeps NB's own", async () => {
    const { s } = await sellerWithData();
    const raw = JSON.stringify(notice("EB-1", "slabking"));
    const res = await postSigned(s.t, raw);
    expect(res.status).toBe(200);
    await drainScheduled(s.t);
    // The verifier got the header and the raw body exactly as received.
    expect(verifyCalls()).toHaveLength(1);
    expect(verifyCalls()[0].json).toEqual({ signatureHeader: signed["x-ebay-signature"], body: raw });
    expect(await counts(s)).toEqual({ links: 0, ebaySales: 0, bscSales: 1, settings: 0, cards: 1, ebayUserId: null });
    expect(world.events).toContain("forget-session");
    const st = await s.t.run(async (ctx) => ctx.db.query("marketplaceListingStates").first());
    expect(st?.platformAccountId).toBeUndefined();
  });

  test("the seller is matched on eBay's immutable user id alone: a renamed account still matches, another id does not", async () => {
    const { s } = await sellerWithData();
    await postSigned(s.t, notice("EB-OTHER", "slabking"));
    await drainScheduled(s.t);
    expect((await counts(s)).links).toBe(1);
    expect(verifyCalls()).toHaveLength(0);
    await postSigned(s.t, notice("EB-1", "a-new-username"));
    await drainScheduled(s.t);
    expect((await counts(s)).links).toBe(0);
  });

  test("a seller who disconnected but still has link rows (listings eBay would not end) is found through the listing state", async () => {
    const { s } = await sellerWithData();
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { marketplaceAccountIds: {} });
    });
    expect(await s.t.query(internal.ebayConnect.ownersForEbayAccount, { ebayUserId: "EB-1" })).toEqual([OWNER]);
    await postSigned(s.t, notice("EB-1", "slabking"));
    await drainScheduled(s.t);
    expect((await counts(s)).links).toBe(0);
  });

  test("an owner matched only by an old listing-state stamp, now on another account, loses only that account's links and the stamp", async () => {
    const { s } = await sellerWithData();
    await s.t.run(async (ctx) => {
      const p = await ctx.db.query("userProfiles").first();
      await ctx.db.patch(p!._id, { marketplaceAccountIds: { ebayUserId: "EB-NEW" } });
    });
    expect((await postSigned(s.t, notice("EB-1", "slabking"))).status).toBe(200);
    await drainScheduled(s.t);
    expect(await counts(s)).toEqual({ links: 0, ebaySales: 1, bscSales: 1, settings: 1, cards: 1, ebayUserId: "EB-NEW" });
    expect(world.events).not.toContain("forget-session");
    const st = await s.t.run(async (ctx) => ctx.db.query("marketplaceListingStates").first());
    expect(st?.platformAccountId).toBeUndefined();
  });

  test("an old-stamp purge deletes nothing once the state is bound to another account", async () => {
    const { s } = await sellerWithData();
    await s.t.run(async (ctx) => {
      const st = await ctx.db.query("marketplaceListingStates").first();
      await ctx.db.patch(st!._id, { platformAccountId: "EB-NEW" });
    });
    const page = await s.t.mutation(internal.ebayConnect.purgeEbayLinksPage, {
      ownerId: OWNER,
      keepLive: false,
      cursor: null,
      whileStamped: "EB-1",
    });
    expect(page.isDone).toBe(true);
    expect((await counts(s)).links).toBe(1);
  });

  test("a notice whose signature does not verify is refused 412 and nothing is scheduled or deleted", async () => {
    world.verifyAnswer = Response.json({ valid: false });
    const { s } = await sellerWithData();
    const res = await postSigned(s.t, notice("EB-1", "slabking"));
    expect(res.status).toBe(412);
    await drainScheduled(s.t);
    expect(await counts(s)).toEqual({ links: 1, ebaySales: 1, bscSales: 1, settings: 1, cards: 1, ebayUserId: "EB-1" });
    expect(world.events).toEqual([]);
  });

  test.each([
    ["the verifier unreachable", () => Response.json({ error_class: "ebay_unavailable" }, { status: 502 }), 500],
    ["verification not configured on the service", () => Response.json({ error_class: "ebay_not_configured" }, { status: 503 }), 503],
  ])("%s answers %i so eBay retries, and deletes nothing", async (_label, make, status) => {
    world.verifyAnswer = make();
    const { s } = await sellerWithData();
    const res = await postSigned(s.t, notice("EB-1", "slabking"));
    expect(res.status).toBe(status);
    await drainScheduled(s.t);
    expect((await counts(s)).links).toBe(1);
  });

  test("a notice with no signature header is refused 412 without asking the verifier", async () => {
    const { s } = await sellerWithData();
    expect((await postSigned(s.t, notice("EB-1", "slabking"), {})).status).toBe(412);
    expect((await postSigned(s.t, notice("EB-1", "slabking"), { "x-ebay-signature": "s".repeat(5000) })).status).toBe(412);
    expect(verifyCalls()).toHaveLength(0);
    expect((await counts(s)).links).toBe(1);
  });

  test("with the verification token unset a notice for a known seller answers 503", async () => {
    vi.stubEnv("EBAY_DELETION_VERIFICATION_TOKEN", "");
    const { s } = await sellerWithData();
    expect((await postSigned(s.t, notice("EB-1", "slabking"))).status).toBe(503);
    expect(verifyCalls()).toHaveLength(0);
  });

  test("a notice for a seller NB never saw is acknowledged 200 without spending a verification", async () => {
    const t = convexTest(schema, modules);
    expect((await postSigned(t, notice("EB-NOBODY", "nobody"))).status).toBe(200);
    expect((await post(t, notice("EB-NOBODY", "nobody"))).status).toBe(200);
    expect(verifyCalls()).toHaveLength(0);
  });

  test.each([
    ["a different topic", notice("EB-1", "slabking", "SOMETHING_ELSE")],
    ["an id with illegal characters", notice("EB 1; drop", "slabking")],
    ["a body that is not JSON", "not json{"],
    ["an empty object", {}],
  ])("%s is acknowledged and does nothing", async (_label, body) => {
    const { s } = await sellerWithData();
    const res = await postSigned(s.t, body);
    expect(res.status).toBe(200);
    await drainScheduled(s.t);
    expect(verifyCalls()).toHaveLength(0);
    expect((await counts(s)).links).toBe(1);
    expect((await counts(s)).settings).toBe(1);
  });

  test("an oversized POST is refused 413, by declared length or by body", async () => {
    const t = convexTest(schema, modules);
    expect((await postSigned(t, JSON.stringify({ pad: "x".repeat(70 * 1024) }))).status).toBe(413);
    expect((await t.fetch(PATH, { method: "POST", headers: { "content-length": String(70 * 1024) }, body: "{}" })).status).toBe(413);
  });

  test("a notice too long for the verifier is refused 412 rather than sent", async () => {
    const { s } = await sellerWithData();
    const long = { ...notice("EB-1", "slabking"), pad: "x".repeat(4100) };
    expect((await postSigned(s.t, long)).status).toBe(412);
    expect(verifyCalls()).toHaveLength(0);
  });

  test("a retry once the data is gone is a harmless no-op", async () => {
    const { s } = await sellerWithData();
    await postSigned(s.t, notice("EB-1", "slabking"));
    await drainScheduled(s.t);
    const again = await postSigned(s.t, notice("EB-1", "slabking"));
    expect(again.status).toBe(200);
    await drainScheduled(s.t);
    expect((await counts(s)).bscSales).toBe(1);
  });

  describe("the scheduled delete", () => {
    const retries = (s: S) =>
      s.t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect())
          .filter((f) => f.name.includes("processAccountDeletion") && f.state.kind === "pending")
          .map((f) => f.args[0] as { ebayUserId: string; ownerIds?: string[]; attempt: number }),
      );

    test("an owner it could not finish is retried alone, with a counted attempt, and nothing else is touched", async () => {
      world.failBrowserDelete = true;
      const { s } = await sellerWithData();
      await s.t.action(internal.ebayConnect.processAccountDeletion, { ebayUserId: "EB-1", attempt: 0 });
      expect(await retries(s)).toEqual([{ ebayUserId: "EB-1", ownerIds: [OWNER], attempt: 1 }]);
      expect((await counts(s)).links).toBe(1);
    });

    test("it gives up after the last attempt instead of scheduling forever", async () => {
      world.failBrowserDelete = true;
      const { s } = await sellerWithData();
      await s.t.action(internal.ebayConnect.processAccountDeletion, { ebayUserId: "EB-1", ownerIds: [OWNER], attempt: 9 });
      expect(await retries(s)).toEqual([]);
    });

    test("the retry delay doubles from a minute and stops at an hour", () => {
      expect([1, 2, 3, 4].map(deletionRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
      expect(deletionRetryDelayMs(8)).toBe(3_600_000);
      expect(deletionRetryDelayMs(50)).toBe(3_600_000);
      expect(deletionRetryDelayMs(0)).toBe(60_000);
    });
  });
});

describe("fulfillmentBody (Set me up's shipping policies)", () => {
  const envelope = { code: ESE, carrier: "USPS" };
  const ground = { code: "USPSParcel", carrier: "USPS" };
  const common = {
    marketplaceId: "EBAY_US",
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
    handlingTime: { value: 1, unit: "DAY" },
  };

  test("the envelope-or-tracked policy is calculated by weight: the envelope (carrier USPS) first, Ground Advantage second", () => {
    expect(fulfillmentBody(NB_POLICY_NAMES.ese, [envelope, ground], "calculated")).toEqual({
      name: "NB Envelope or Tracked (under $20)",
      ...common,
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "CALCULATED",
          shippingServices: [
            { shippingCarrierCode: "USPS", shippingServiceCode: ESE, freeShipping: false, sortOrder: 1 },
            { shippingCarrierCode: "USPS", shippingServiceCode: "USPSParcel", freeShipping: false, sortOrder: 2 },
          ],
        },
      ],
    });
  });

  test("the tracked policy is calculated by weight on Ground Advantage with its carrier", () => {
    expect(fulfillmentBody(NB_POLICY_NAMES.tracked, [ground], "calculated")).toEqual({
      name: NB_POLICY_NAMES.tracked,
      ...common,
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "CALCULATED",
          shippingServices: [{ shippingCarrierCode: "USPS", shippingServiceCode: "USPSParcel", freeShipping: false, sortOrder: 1 }],
        },
      ],
    });
  });

  test("the free policy is a $0.00 flat rate with free shipping and its carrier", () => {
    expect(fulfillmentBody(NB_POLICY_NAMES.free, [ground], "free")).toEqual({
      name: NB_POLICY_NAMES.free,
      ...common,
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "FLAT_RATE",
          shippingServices: [
            {
              shippingCarrierCode: "USPS",
              shippingServiceCode: "USPSParcel",
              shippingCost: { value: "0.00", currency: "USD" },
              freeShipping: true,
              sortOrder: 1,
            },
          ],
        },
      ],
    });
  });
});
