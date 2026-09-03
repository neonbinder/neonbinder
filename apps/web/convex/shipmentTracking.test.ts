// NEO-121 — scan visibility: the ingest path, the snapshot rules, and webhook
// registration.
//
// Three things here are worth more than the rest, because each one fails
// silently in production if it regresses:
//
//  1. **The HMAC gate.** A body that does not verify must change NOTHING. The
//     tests assert the absence of a write, not just the status code — a 401
//     returned after a patch would look identical from the outside.
//  2. **The integer-`weight` rewrite.** EasyPost signs the float-rendered body,
//     so a real event whose weight is a whole number (which is most of them —
//     a PWE is quoted in whole ounces) only verifies if we rewrite it first.
//     A test suite that only ever sends decimal weights passes while every real
//     event is rejected as a forgery.
//  3. **Reconcile-before-create.** A lost response from a previous attempt
//     leaves a hook nobody recorded; creating a second one means EasyPost
//     delivers every event twice, forever, with no way to tell which to remove.
//
// The registration tests drive the browser service through a stubbed `fetch`,
// the way credentials.test.ts does — including the `/health` contract probe,
// which every authenticated browser call pre-flights (NEO-143).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import {
  computeEasypostSignature,
  rewriteWeightForSignature,
} from "./lib/easypostWebhookSignature";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const USER = "user_track_aaaa1111";
const OTHER_USER = "user_track_bbbb2222";
const SHIPMENT = "shp_neo121";
const SECRET = "webhook-secret-at-least-32-chars-long";
/** Exactly 43 base64url chars — the shape the handler requires. */
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROD_SITE = "https://first-starfish-800.convex.site";
const PREVIEW_SITE = "https://amiable-antelope-42.convex.site";
const KEY = `easypost-credentials-${USER}`;

const ADDRESS = {
  name: "Buyer",
  line1: "1 Card Way",
  city: "Olympia",
  state: "WA",
  postalCode: "98501",
  country: "US",
};

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An Express "no such route" 404 — HTML, not JSON. The old-revision signal. */
function expressNotFound(): Response {
  return new Response("<!DOCTYPE html><body>Cannot GET /easypost/x/webhooks</body>", {
    status: 404,
    headers: { "Content-Type": "text/html" },
  });
}

/** The easypost router's own JSON 404 — "no key saved for this user". */
function noKeyResponse(): Response {
  return jsonResponse({ error: "No EasyPost key saved for this user" }, 404);
}

/** Serves the NEO-143 contract probe centrally, like credentials.test.ts. */
function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
    }
    return handler(url, init);
  }) as FetchStub);
}

/** Records every non-probe browser call, in order. */
function recordingStub(handler: FetchStub) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  stubFetch(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return handler(url, init);
  });
  return calls;
}

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];

async function seedPurchase(
  t: ReturnType<typeof convexTest>,
  fields: Partial<{
    userId: string;
    easypostShipmentId: string;
    trackerUpdatedAt: number;
    lastScanAt: number;
    trackingStatus: string;
    lastRefreshAt: number;
  }> = {},
) {
  return await t.run(async (ctx: Ctx) =>
    ctx.db.insert("labelPurchases", {
      userId: fields.userId ?? USER,
      easypostShipmentId: fields.easypostShipmentId ?? SHIPMENT,
      trackingCode: "0004012345678901234567890123456",
      costCents: 78,
      weightOz: 1,
      toAddress: ADDRESS,
      labelUrl: "https://easypost-files.example/label.png",
      purchasedAt: 1_700_000_000_000,
      ...(fields.trackerUpdatedAt !== undefined
        ? { trackerUpdatedAt: fields.trackerUpdatedAt }
        : {}),
      ...(fields.lastScanAt !== undefined ? { lastScanAt: fields.lastScanAt } : {}),
      ...(fields.trackingStatus !== undefined
        ? { trackingStatus: fields.trackingStatus }
        : {}),
      ...(fields.lastRefreshAt !== undefined
        ? { lastRefreshAt: fields.lastRefreshAt }
        : {}),
    }),
  );
}

async function seedWebhookRow(
  t: ReturnType<typeof convexTest>,
  fields: Partial<{
    userId: string;
    urlToken: string;
    webhookId: string;
    url: string;
    lastAttemptAt: number;
    lastEventAt: number;
    lastError: "rejected" | "unauthorized" | "unavailable" | "no_key";
    disabledAt: number;
  }> = {},
) {
  return await t.run(async (ctx: Ctx) =>
    ctx.db.insert("easypostWebhooks", {
      userId: fields.userId ?? USER,
      urlToken: fields.urlToken ?? TOKEN,
      secret: SECRET,
      url: fields.url ?? "",
      lastAttemptAt: fields.lastAttemptAt ?? 0,
      ...(fields.webhookId !== undefined ? { webhookId: fields.webhookId } : {}),
      ...(fields.lastEventAt !== undefined ? { lastEventAt: fields.lastEventAt } : {}),
      ...(fields.lastError !== undefined ? { lastError: fields.lastError } : {}),
      ...(fields.disabledAt !== undefined ? { disabledAt: fields.disabledAt } : {}),
    }),
  );
}

async function readPurchase(t: ReturnType<typeof convexTest>, id: string) {
  return await t.run(async (ctx: Ctx) => ctx.db.get(id as never));
}

async function readWebhook(t: ReturnType<typeof convexTest>, userId = USER) {
  return await t.run(async (ctx: Ctx) =>
    ctx.db
      .query("easypostWebhooks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

/** A `tracker.updated` body plus the signature header EasyPost would send. */
async function signedEvent(
  body: string,
  secret = SECRET,
): Promise<{ body: string; headers: Record<string, string> }> {
  const signature = await computeEasypostSignature(secret, rewriteWeightForSignature(body));
  return {
    body,
    headers: { "Content-Type": "application/json", "X-Hmac-Signature": signature },
  };
}

/** The four real USPS messages from the plan's verify-first #1. */
function trackerPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "trk_neo121",
    status: "out_for_delivery",
    status_detail: "out_for_delivery",
    updated_at: "2026-08-28T22:06:00Z",
    est_delivery_date: "2026-08-28T00:00:00Z",
    shipment_id: SHIPMENT,
    public_url: "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
    tracking_details: [
      {
        message: "Origin Processing Cancellation of Postage",
        status: "in_transit",
        datetime: "2026-08-25T17:52:00Z",
        tracking_location: { city: "MADISON", state: "WI", zip: "53714", country: "US" },
      },
      {
        message: "Origin Primary Processing",
        status: "in_transit",
        datetime: "2026-08-26T04:53:00Z",
        tracking_location: { city: "MILWAUKEE", state: "WI", zip: null, country: "US" },
      },
      {
        message: "Destination MMP Processing",
        status: "in_transit",
        datetime: "2026-08-27T22:22:00Z",
        // No tracking_location at all — EasyPost omits it on some scans.
      },
      {
        message: "Delivery",
        status: "out_for_delivery",
        datetime: "2026-08-28T22:06:00Z",
        tracking_location: { city: "OLYMPIA", state: "WA", zip: "98501", country: "US" },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  // Loopback → the OIDC handshake short-circuits (no GCP credentials needed).
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  process.env.CONVEX_SITE_URL = PROD_SITE;
  __resetContractCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEONBINDER_BROWSER_URL;
  delete process.env.CONVEX_SITE_URL;
});

// ─── applyTrackerSnapshot ────────────────────────────────────────────────────

describe("applyTrackerSnapshot", () => {
  const snapshot = {
    trackerId: "trk_1",
    status: "in_transit",
    updatedAt: 2_000,
    scans: [
      { at: 1_000, status: "in_transit", message: "Origin Primary Processing" },
      { at: 1_500, status: "in_transit", message: "Destination MMP Processing" },
    ],
  };

  test("applies a newer snapshot and counts the scans that are new", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, { trackerUpdatedAt: 1_000, lastScanAt: 1_000 });

    const result = await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
      purchaseId,
      userId: USER,
      snapshot,
    });

    expect(result).toEqual({ applied: true, newScans: 1 });
    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBe("in_transit");
    expect(row?.trackerUpdatedAt).toBe(2_000);
    expect(row?.lastScanAt).toBe(1_500);
    expect(row?.scans).toHaveLength(2);
  });

  test("an older or equal snapshot is a no-op — redelivery and reordering", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, {
      trackerUpdatedAt: 5_000,
      trackingStatus: "delivered",
    });

    for (const updatedAt of [5_000, 4_999, 0]) {
      const result = await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
        purchaseId,
        userId: USER,
        snapshot: { ...snapshot, updatedAt },
      });
      expect(result).toEqual({ applied: false, newScans: 0 });
    }

    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBe("delivered");
    expect(row?.trackerUpdatedAt).toBe(5_000);
  });

  test("keeps the NEWEST 50 scans", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    const scans = Array.from({ length: 60 }, (_, i) => ({
      at: 1_000 + i,
      status: "in_transit",
      message: `scan ${i}`,
    }));

    await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
      purchaseId,
      userId: USER,
      snapshot: { ...snapshot, scans },
    });

    const row = await readPurchase(t, purchaseId);
    expect(row?.scans).toHaveLength(50);
    expect(row?.scans?.[0].message).toBe("scan 10");
    expect(row?.scans?.[49].message).toBe("scan 59");
  });

  test("truncates every stored string to 200 characters", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    const long = "x".repeat(5_000);

    await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
      purchaseId,
      userId: USER,
      snapshot: {
        ...snapshot,
        trackerId: long,
        status: long,
        statusDetail: long,
        scans: [{ at: 1, status: long, message: long, city: long, state: long }],
      },
    });

    const row = await readPurchase(t, purchaseId);
    expect(row?.trackerId).toHaveLength(200);
    expect(row?.trackingStatus).toHaveLength(200);
    expect(row?.trackingStatusDetail).toHaveLength(200);
    expect(row?.scans?.[0].message).toHaveLength(200);
    expect(row?.scans?.[0].city).toHaveLength(200);
  });

  test("stores a public tracking URL only when it is https", async () => {
    const t = convexTest(schema, modules);

    for (const [url, kept] of [
      ["https://track.easypost.com/abc", true],
      ["http://track.easypost.com/abc", false],
      ["javascript:alert(1)", false],
      ["not a url", false],
      [`https://track.easypost.com/${"x".repeat(300)}`, false],
    ] as const) {
      const purchaseId = await seedPurchase(t);
      await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
        purchaseId,
        userId: USER,
        snapshot: { ...snapshot, publicTrackingUrl: url },
      });
      const row = await readPurchase(t, purchaseId);
      expect(row?.publicTrackingUrl).toBe(kept ? url : undefined);
    }
  });

  test("refuses to write a row belonging to another user", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, { userId: OTHER_USER });

    await expect(
      t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
        purchaseId,
        userId: USER,
        snapshot,
      }),
    ).rejects.toThrow(/another user/);

    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBeUndefined();
  });

  test("stamps the refresh cooldown even when the snapshot is a no-op", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, { trackerUpdatedAt: 9_000 });

    const result = await t.mutation(internal.shipmentTracking.applyTrackerSnapshot, {
      purchaseId,
      userId: USER,
      snapshot,
      refreshedAt: 1_234,
    });

    expect(result.applied).toBe(false);
    const row = await readPurchase(t, purchaseId);
    expect(row?.lastRefreshAt).toBe(1_234);
  });
});

// ─── findPurchaseForWebhook ──────────────────────────────────────────────────

describe("findPurchaseForWebhook", () => {
  test("never returns another seller's row with the same shipment id", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedPurchase(t);
    await seedPurchase(t, { userId: OTHER_USER });

    expect(
      await t.query(internal.shipmentTracking.findPurchaseForWebhook, {
        userId: USER,
        easypostShipmentId: SHIPMENT,
      }),
    ).toBe(mine);

    expect(
      await t.query(internal.shipmentTracking.findPurchaseForWebhook, {
        userId: "user_track_cccc3333",
        easypostShipmentId: SHIPMENT,
      }),
    ).toBeNull();
  });

  test("a duplicate row for one shipment resolves instead of throwing", async () => {
    // `.unique()` here would throw inside the webhook handler, which EasyPost
    // reads as a failed delivery and retries until it disables the hook.
    const t = convexTest(schema, modules);
    await seedPurchase(t);
    await seedPurchase(t);

    expect(
      await t.query(internal.shipmentTracking.findPurchaseForWebhook, {
        userId: USER,
        easypostShipmentId: SHIPMENT,
      }),
    ).not.toBeNull();
  });
});

// ─── the HTTP endpoint ───────────────────────────────────────────────────────

describe("POST /webhooks/easypost/<token>", () => {
  async function post(
    t: ReturnType<typeof convexTest>,
    token: string,
    payload: { body: string; headers: Record<string, string> },
  ) {
    return await t.fetch(`/webhooks/easypost/${token}`, {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
    });
  }

  test("a correctly signed tracker event applies and records the delivery", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    await seedWebhookRow(t);

    const body = JSON.stringify({
      description: "tracker.updated",
      mode: "production",
      result: trackerPayload(),
    });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true, newScans: 4 });

    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBe("out_for_delivery");
    expect(row?.scans).toHaveLength(4);
    expect(row?.scans?.[0].message).toBe("Origin Processing Cancellation of Postage");
    expect(row?.scans?.[3].city).toBe("OLYMPIA");
    // Nulls and missing locations are tolerated, not stored as "null".
    expect(row?.scans?.[1].zip).toBeUndefined();
    expect(row?.scans?.[2].city).toBeUndefined();
    expect(row?.publicTrackingUrl).toBe("https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx");

    expect((await readWebhook(t))?.lastEventAt).toBeGreaterThan(0);
  });

  test("a body with an INTEGER weight verifies — the float rewrite", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    await seedWebhookRow(t);

    // Signed the way EasyPost signs it: over the float-rendered body.
    const body = JSON.stringify({
      description: "tracker.created",
      result: { ...trackerPayload(), weight: 17 },
    });
    expect(body).toContain('"weight":17');

    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect((await readPurchase(t, purchaseId))?.trackingStatus).toBe("out_for_delivery");
  });

  test("a wrong signature is 401 and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    await seedWebhookRow(t);

    const body = JSON.stringify({ description: "tracker.updated", result: trackerPayload() });
    const response = await post(t, TOKEN, await signedEvent(body, "a-different-secret-entirely"));

    expect(response.status).toBe(401);
    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBeUndefined();
    expect(row?.scans).toBeUndefined();
    expect((await readWebhook(t))?.lastEventAt).toBeUndefined();
  });

  test("a missing signature header is 401 and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    await seedWebhookRow(t);

    const response = await post(t, TOKEN, {
      body: JSON.stringify({ description: "tracker.updated", result: trackerPayload() }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(401);
    expect((await readPurchase(t, purchaseId))?.trackingStatus).toBeUndefined();
  });

  test("the raw body is what is verified — a re-serialised body must fail", async () => {
    const t = convexTest(schema, modules);
    await seedPurchase(t);
    await seedWebhookRow(t);

    const signedFor = JSON.stringify({ description: "tracker.updated", result: trackerPayload() });
    const sent = signedFor.replace('"status":"out_for_delivery"', '"status":"delivered"');
    const { headers } = await signedEvent(signedFor);

    const response = await t.fetch(`/webhooks/easypost/${TOKEN}`, {
      method: "POST",
      headers,
      body: sent,
    });
    expect(response.status).toBe(401);
  });

  test("an unknown token is a fixed 404, and so is a malformed one", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t);
    const body = JSON.stringify({ description: "tracker.updated", result: trackerPayload() });
    const signed = await signedEvent(body);

    // Right shape, no such row.
    const unknown = await post(t, "B".repeat(43), signed);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });

    // Wrong shapes — rejected before any database read.
    for (const bad of ["", "short", `${TOKEN}X`, "not/a/token"]) {
      const response = await post(t, bad, signed);
      expect(response.status).toBe(404);
    }
  });

  test("a non-tracker event is ignored with 200", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    await seedWebhookRow(t);

    const body = JSON.stringify({
      description: "batch.updated",
      result: trackerPayload(),
    });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
    expect((await readPurchase(t, purchaseId))?.trackingStatus).toBeUndefined();
  });

  test("a null shipment_id is ignored with 200", async () => {
    const t = convexTest(schema, modules);
    await seedPurchase(t);
    await seedWebhookRow(t);

    const body = JSON.stringify({
      description: "tracker.updated",
      result: trackerPayload({ shipment_id: null }),
    });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
  });

  test("a shipment we never sold is ignored with 200, not retried", async () => {
    // A shipment bought outside NeonBinder on the same EasyPost account is a
    // normal, permanent condition. Anything but a 2xx makes EasyPost retry it
    // until it disables the hook.
    const t = convexTest(schema, modules);
    await seedWebhookRow(t);

    const body = JSON.stringify({
      description: "tracker.updated",
      result: trackerPayload({ shipment_id: "shp_someone_elses" }),
    });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
    expect((await readWebhook(t))?.lastEventAt).toBeUndefined();
  });

  test("a body over 256 KB is 413", async () => {
    const t = convexTest(schema, modules);
    await seedPurchase(t);
    await seedWebhookRow(t);

    const body = JSON.stringify({
      description: "tracker.updated",
      result: trackerPayload({ status_detail: "x".repeat(300_000) }),
    });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(413);
  });

  test("one seller's token cannot reach another seller's row", async () => {
    const t = convexTest(schema, modules);
    const theirs = await seedPurchase(t, { userId: OTHER_USER });
    // My webhook row, their shipment id in the event.
    await seedWebhookRow(t);

    const body = JSON.stringify({ description: "tracker.updated", result: trackerPayload() });
    const response = await post(t, TOKEN, await signedEvent(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
    expect((await readPurchase(t, theirs))?.trackingStatus).toBeUndefined();
  });
});

// ─── getMyTrackingSetup ──────────────────────────────────────────────────────

describe("getMyTrackingSetup", () => {
  test("never returns the url token or the secret", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { webhookId: "hook_1", url: `${PROD_SITE}/webhooks/easypost/${TOKEN}` });

    const setup = await t
      .withIdentity({ subject: USER })
      .query(api.shipmentTracking.getMyTrackingSetup, {});

    expect(setup.connected).toBe(true);
    expect(Object.keys(setup).sort()).toEqual(["connected", "pending"]);
    expect(JSON.stringify(setup)).not.toContain(TOKEN);
    expect(JSON.stringify(setup)).not.toContain(SECRET);
  });

  test("reports pending, failed, and disabled states apart", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: USER });

    // No row at all.
    expect(await asUser.query(api.shipmentTracking.getMyTrackingSetup, {})).toEqual({
      connected: false,
      pending: false,
    });

    // Row, no hook, no recorded reason → an attempt is in flight.
    const rowId = await seedWebhookRow(t);
    expect(await asUser.query(api.shipmentTracking.getMyTrackingSetup, {})).toEqual({
      connected: false,
      pending: true,
    });

    // A recorded reason is actionable, not "connecting…".
    await t.run(async (ctx: Ctx) => ctx.db.patch(rowId, { lastError: "no_key" }));
    expect(await asUser.query(api.shipmentTracking.getMyTrackingSetup, {})).toEqual({
      connected: false,
      pending: false,
      lastError: "no_key",
    });

    // A hook EasyPost disabled is not connected.
    await t.run(async (ctx: Ctx) =>
      ctx.db.patch(rowId, { webhookId: "hook_1", disabledAt: 1, lastError: undefined }),
    );
    const disabled = await asUser.query(api.shipmentTracking.getMyTrackingSetup, {});
    expect(disabled.connected).toBe(false);
  });

  test("is empty for a signed-out caller", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { webhookId: "hook_1" });
    expect(await t.query(api.shipmentTracking.getMyTrackingSetup, {})).toEqual({
      connected: false,
      pending: false,
    });
  });
});

// ─── ensureWebhook ───────────────────────────────────────────────────────────

describe("ensureWebhook", () => {
  test("registers with a 43-char token in the URL and never reuses the token as the secret", async () => {
    const t = convexTest(schema, modules);
    const calls = recordingStub(async (url, init) => {
      if (String(url).endsWith("/webhooks") && init?.method === "GET") {
        return jsonResponse([]);
      }
      if (String(url).endsWith("/webhooks") && init?.method === "POST") {
        return jsonResponse({ webhookId: "hook_new", mode: "production" });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });

    const result = await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER });
    expect(result).toEqual({ status: "registered" });

    const created = calls.find((c) => c.method === "POST");
    const posted = created?.body as { url: string; secret: string };
    expect(created?.url).toContain(`/easypost/${KEY}/webhooks`);
    expect(posted.url).toMatch(
      new RegExp(`^${PROD_SITE}/webhooks/easypost/[A-Za-z0-9_-]{43}$`),
    );
    expect(posted.secret.length).toBeGreaterThanOrEqual(32);

    const row = await readWebhook(t);
    expect(row?.webhookId).toBe("hook_new");
    expect(row?.mode).toBe("production");
    expect(row?.url).toBe(posted.url);
    expect(row?.lastError).toBeUndefined();
    // The token in the URL is the row's token, and the secret is NOT the token.
    expect(posted.url.endsWith(row?.urlToken ?? "nope")).toBe(true);
    expect(posted.secret).not.toBe(row?.urlToken);
    expect(posted.secret).toBe(row?.secret);
  });

  test("is idempotent — an already-registered seller makes no browser call", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, {
      webhookId: "hook_1",
      url: `${PROD_SITE}/webhooks/easypost/${TOKEN}`,
      lastAttemptAt: 0,
    });
    const calls = recordingStub(async () => {
      throw new Error("must not call the browser service");
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "registered" });
    expect(calls).toHaveLength(0);
  });

  test("adopts a hook already registered at our URL instead of creating a second one", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { lastAttemptAt: 0 });
    const ourUrl = `${PROD_SITE}/webhooks/easypost/${TOKEN}`;
    const calls = recordingStub(async (url, init) => {
      if (init?.method === "GET") {
        return jsonResponse([{ webhookId: "hook_orphan", url: ourUrl, mode: "test" }]);
      }
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "adopted" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const row = await readWebhook(t);
    expect(row?.webhookId).toBe("hook_orphan");
    expect(row?.url).toBe(ourUrl);
  });

  test("deletes a stale hook under our prefix, then registers", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { lastAttemptAt: 0 });
    const calls = recordingStub(async (url, init) => {
      if (init?.method === "GET") {
        return jsonResponse([
          { webhookId: "hook_stale", url: `${PROD_SITE}/webhooks/easypost/${"C".repeat(43)}` },
          // Someone else's hook on the same account — must NOT be touched.
          { webhookId: "hook_theirs", url: "https://example.com/their-hook" },
        ]);
      }
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
      return jsonResponse({ webhookId: "hook_new" });
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "registered" });

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("hook_stale");
    expect(calls.some((c) => c.url.includes("hook_theirs"))).toBe(false);
  });

  test("does not retry within the hour", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { lastAttemptAt: Date.now() - 60_000, lastError: "unavailable" });
    const calls = recordingStub(async () => {
      throw new Error("must not call the browser service");
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "deferred" });
    expect(calls).toHaveLength(0);
  });

  test("never registers from a preview deployment", async () => {
    // preview-cleanup.yml deletes the preview, so a hook registered here would
    // be orphaned on the shared test account with nothing left to remove it.
    process.env.CONVEX_SITE_URL = PREVIEW_SITE;
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { lastAttemptAt: 0 });
    const calls = recordingStub(async () => {
      throw new Error("must not call the browser service");
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "skipped" });
    expect(calls).toHaveLength(0);
    expect((await readWebhook(t))?.lastError).toBe("unavailable");
  });

  test("records `unavailable` for an old browser revision, and `no_key` for a missing key", async () => {
    for (const [respond, expected] of [
      [expressNotFound, "unavailable"],
      [noKeyResponse, "no_key"],
      [() => jsonResponse({ error: "nope" }, 401), "unauthorized"],
      [() => jsonResponse({ error: "nope" }, 422), "rejected"],
      [() => jsonResponse({ error: "nope" }, 502), "unavailable"],
    ] as const) {
      const t = convexTest(schema, modules);
      await seedWebhookRow(t, { lastAttemptAt: 0 });
      stubFetch(async () => respond());

      expect(
        await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
      ).toEqual({ status: "failed" });
      expect((await readWebhook(t))?.lastError).toBe(expected);
      expect((await readWebhook(t))?.webhookId).toBeUndefined();
      vi.unstubAllGlobals();
      __resetContractCache();
    }
  });

  test("a failed create records the reason and leaves no hook id", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { lastAttemptAt: 0 });
    stubFetch(async (url, init) => {
      if (init?.method === "GET") return jsonResponse([]);
      return jsonResponse({ error: "bad url" }, 400);
    });

    expect(
      await t.action(internal.shipmentTracking.ensureWebhook, { userId: USER }),
    ).toEqual({ status: "failed" });
    const row = await readWebhook(t);
    expect(row?.lastError).toBe("rejected");
    expect(row?.webhookId).toBeUndefined();
    // The reason is our enum, never EasyPost's text (which echoes the URL, and
    // the URL carries the token).
    expect(JSON.stringify(row)).not.toContain("bad url");
  });
});

// ─── removeWebhook ───────────────────────────────────────────────────────────

describe("removeWebhook", () => {
  test("keeps the row when the delete is not confirmed", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { webhookId: "hook_1" });
    stubFetch(async () => jsonResponse({ error: "upstream down" }, 502));

    expect(
      await t.action(internal.shipmentTracking.removeWebhook, { userId: USER }),
    ).toEqual({ removed: false });
    expect((await readWebhook(t))?.webhookId).toBe("hook_1");
  });

  test("deletes the row once EasyPost confirms", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { webhookId: "hook_1" });
    const calls = recordingStub(async () => jsonResponse({ ok: true }));

    expect(
      await t.action(internal.shipmentTracking.removeWebhook, { userId: USER }),
    ).toEqual({ removed: true });
    expect(await readWebhook(t)).toBeNull();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain(`/easypost/${KEY}/webhooks/hook_1`);
  });

  test("a seller with no registration is already in the desired state", async () => {
    const t = convexTest(schema, modules);
    const calls = recordingStub(async () => {
      throw new Error("must not call the browser service");
    });
    expect(
      await t.action(internal.shipmentTracking.removeWebhook, { userId: USER }),
    ).toEqual({ removed: true });
    expect(calls).toHaveLength(0);
  });
});

// ─── the postage.ts call sites ───────────────────────────────────────────────

describe("postage.saveEasypostKey", () => {
  // Fake timers + `finishAllScheduledFunctions` is this repo's pattern for
  // draining a scheduled function (backfillCardFeatures.test.ts). Draining
  // matters beyond the assertion: a job left pending in convex-test runs during
  // a LATER test and lands its browser calls in that test's recorder.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("stores the key and then schedules registration", async () => {
    const t = convexTest(schema, modules);
    const calls = recordingStub(async (url, init) => {
      if (init?.method === "PUT") return jsonResponse({ success: true });
      if (init?.method === "GET") return jsonResponse([]);
      return jsonResponse({ webhookId: "hook_new", mode: "test" });
    });

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.saveEasypostKey, { apiKey: "EZTK_test" });
    expect(result.success).toBe(true);

    // The save answers before registration runs — it is scheduled, not awaited.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain(`/easypost/${KEY}`);
    expect((await readWebhook(t))?.webhookId).toBe("hook_new");
  });
});

describe("postage.clearEasypostKey", () => {
  test("unregisters the webhook BEFORE deleting the key", async () => {
    const t = convexTest(schema, modules);
    await seedWebhookRow(t, { webhookId: "hook_1" });
    const calls = recordingStub(async () => jsonResponse({ ok: true }));

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.clearEasypostKey, {});
    expect(result.success).toBe(true);

    // Order is the point: scheduled instead of awaited, the delete would run
    // after the key is gone and could never authenticate.
    expect(calls.map((c) => c.url)).toEqual([
      `http://localhost:9999/easypost/${KEY}/webhooks/hook_1`,
      `http://localhost:9999/easypost/${KEY}`,
    ]);
    expect(await readWebhook(t)).toBeNull();
  });

  test("falls back to the credentials route only on an Express 404", async () => {
    const t = convexTest(schema, modules);
    const calls = recordingStub(async (url) =>
      String(url).endsWith(`/easypost/${KEY}`) ? expressNotFound() : jsonResponse({ ok: true }),
    );

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.clearEasypostKey, {});
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      `http://localhost:9999/easypost/${KEY}`,
      `http://localhost:9999/credentials/${KEY}`,
    ]);
  });

  test("a JSON 'no key saved' 404 is the desired end state, not a fallback", async () => {
    const t = convexTest(schema, modules);
    const calls = recordingStub(async () => noKeyResponse());

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.clearEasypostKey, {});
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("postage.refreshTracking", () => {
  const snapshotResponse = {
    trackerId: "trk_neo121",
    status: "in_transit",
    updatedAt: 4_000,
    lastScanAt: 3_000,
    publicTrackingUrl: "https://track.easypost.com/abc",
    scans: [{ at: 3_000, status: "in_transit", message: "Origin Primary Processing" }],
  };

  test("applies the fetched snapshot and stamps the cooldown", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    const calls = recordingStub(async () => jsonResponse(snapshotResponse));

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.refreshTracking, { purchaseId });

    expect(result).toEqual({
      applied: true,
      newScans: 1,
      status: "in_transit",
      cooldown: false,
    });
    expect(calls[0].url).toContain(`/easypost/${KEY}/tracker/${SHIPMENT}`);
    const row = await readPurchase(t, purchaseId);
    expect(row?.trackingStatus).toBe("in_transit");
    expect(row?.lastRefreshAt).toBeGreaterThan(0);
  });

  test("a second refresh inside 60s is answered from the row, with no call out", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, {
      lastRefreshAt: Date.now() - 5_000,
      trackingStatus: "in_transit",
    });
    const calls = recordingStub(async () => {
      throw new Error("must not call the browser service");
    });

    const result = await t
      .withIdentity({ subject: USER })
      .action(api.postage.refreshTracking, { purchaseId });

    expect(result).toEqual({
      applied: false,
      newScans: 0,
      status: "in_transit",
      cooldown: true,
    });
    expect(calls).toHaveLength(0);
  });

  test("`no_tracker` becomes a sentence about USPS, not an error", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    stubFetch(async () =>
      jsonResponse({ error: "This shipment has no tracker yet", kind: "no_tracker" }, 409),
    );

    await expect(
      t.withIdentity({ subject: USER }).action(api.postage.refreshTracking, { purchaseId }),
    ).rejects.toThrow(/hasn't scanned/);
  });

  test("another seller's purchase row is not found", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, { userId: OTHER_USER });
    const calls = recordingStub(async () => jsonResponse(snapshotResponse));

    await expect(
      t.withIdentity({ subject: USER }).action(api.postage.refreshTracking, { purchaseId }),
    ).rejects.toThrow(/wasn't found/);
    expect(calls).toHaveLength(0);
  });

  test("a missing key sends the seller to their profile", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t);
    stubFetch(async () => noKeyResponse());

    await expect(
      t.withIdentity({ subject: USER }).action(api.postage.refreshTracking, { purchaseId }),
    ).rejects.toThrow(/EasyPost API key/);
  });
});

describe("postage.buyLetterLabel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("records the tracker the buy response carries, and schedules registration", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx: Ctx) =>
      ctx.db.insert("userProfiles", {
        userId: USER,
        returnAddress: { ...ADDRESS, name: "Seller" },
      }),
    );
    const calls = recordingStub(async (url, init) => {
      if (String(url).includes("/buy")) {
        return jsonResponse({
          shipmentId: SHIPMENT,
          trackingCode: "9400100000000000000000",
          labelUrl: "https://easypost-files.example/label.png",
          amountCents: 78,
          tracker: {
            trackerId: "trk_new",
            status: "pre_transit",
            updatedAt: 1_000,
            publicTrackingUrl: "http://insecure.example/track",
            scans: [],
          },
        });
      }
      if (init?.method === "GET") return jsonResponse([]);
      return jsonResponse({ webhookId: "hook_new" });
    });

    const bought = await t.withIdentity({ subject: USER }).action(api.postage.buyLetterLabel, {
      shipmentId: SHIPMENT,
      rateId: "rate_1",
      weightOz: 1,
      to: ADDRESS,
    });
    expect(bought.historySaved).toBe(true);
    // The buy response shape is unchanged for the caller.
    expect(Object.keys(bought).sort()).toEqual([
      "amountCents",
      "historySaved",
      "labelUrl",
      "shipmentId",
      "trackingCode",
    ]);

    const row = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("labelPurchases")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .first(),
    );
    expect(row?.trackingStatus).toBe("pre_transit");
    expect(row?.trackerId).toBe("trk_new");
    // Sanitised through the same path as a webhook: http:// is not stored.
    expect(row?.publicTrackingUrl).toBeUndefined();

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await readWebhook(t))?.webhookId).toBe("hook_new");
    expect(calls.some((c) => c.url.includes("/buy"))).toBe(true);
  });

  test("a buy response without a tracker still records the purchase", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx: Ctx) =>
      ctx.db.insert("userProfiles", {
        userId: USER,
        returnAddress: { ...ADDRESS, name: "Seller" },
      }),
    );
    await seedWebhookRow(t, { webhookId: "hook_1" });
    stubFetch(async () =>
      jsonResponse({
        shipmentId: SHIPMENT,
        trackingCode: "9400100000000000000000",
        labelUrl: "https://easypost-files.example/label.png",
        amountCents: 78,
      }),
    );

    const bought = await t.withIdentity({ subject: USER }).action(api.postage.buyLetterLabel, {
      shipmentId: SHIPMENT,
      rateId: "rate_1",
      weightOz: 1,
      to: ADDRESS,
    });

    expect(bought.historySaved).toBe(true);
    const row = await t.run(async (ctx: Ctx) =>
      ctx.db
        .query("labelPurchases")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .first(),
    );
    expect(row?.trackingStatus).toBeUndefined();
  });
});
