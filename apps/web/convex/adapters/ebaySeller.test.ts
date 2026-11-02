/**
 * NEO-415 — the eBay seller client: request shapes and headers per call,
 * bulk results, error handling that never echoes eBay's text, and the
 * once-per-session 401 refresh. `fetch` is stubbed; nothing reaches eBay.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bulkCreateOffers,
  bulkCreateOrReplaceInventoryItems,
  bulkPublishOffers,
  bulkUpdatePriceQuantity,
  createPolicy,
  errorIdsOf,
  getCardCategoryAspects,
  getOfferBySku,
  getOptedInPrograms,
  getOrdersPage,
  getPolicies,
  getShippingServices,
  openEbaySellerSession,
  optInToProgram,
  updateOffer,
  upsertInventoryLocation,
  uploadImage,
  withdrawOffer,
  type EbaySellerSession,
} from "./ebaySeller";

interface Seen {
  url: URL;
  init: RequestInit;
  headers: Record<string, string>;
  json: unknown;
}

let seen: Seen[] = [];
let answers: Array<Response | Error>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  seen = [];
  answers = [];
  vi.stubEnv("EBAY_CLIENT_ID", "cid");
  vi.stubEnv("EBAY_RU_NAME", "ru");
  vi.stubEnv("EBAY_ENVIRONMENT", "sandbox");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: new URL(String(url)),
      init: init ?? {},
      headers,
      json: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function session(over: Partial<EbaySellerSession> = {}): EbaySellerSession {
  return {
    ownerId: "owner",
    token: "tok-1",
    config: {
      clientId: "cid",
      ruName: "ru",
      environment: "sandbox",
      apiBase: "https://api.sandbox.ebay.com",
      mediaBase: "https://apim.sandbox.ebay.com",
      authBase: "https://auth.sandbox.ebay.com",
      webBase: "https://www.sandbox.ebay.com",
    },
    reauthAttempted: false,
    dead: false,
    ...over,
  };
}

const noCredentialCalls = { runAction: vi.fn() } as never;

describe("openEbaySellerSession", () => {
  test("refuses with notConfigured when the env is unset, without reading a token", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "");
    const runAction = vi.fn();
    const r = await openEbaySellerSession({ runAction } as never, "owner");
    expect(r).toMatchObject({ ok: false, failure: { kind: "notConfigured" } });
    expect(runAction).not.toHaveBeenCalled();
  });

  test("refuses with paused when ebay is paused", async () => {
    vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "ebay");
    const runAction = vi.fn();
    const r = await openEbaySellerSession({ runAction } as never, "owner");
    expect(r).toMatchObject({ ok: false, failure: { kind: "paused" } });
    expect(runAction).not.toHaveBeenCalled();
  });

  test("no token (null, or a throw) is no_token", async () => {
    for (const runAction of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(new Error("boom"))]) {
      const r = await openEbaySellerSession({ runAction } as never, "owner");
      expect(r).toMatchObject({ ok: false, failure: { kind: "no_token" } });
    }
  });

  test("a token opens a session on the configured hosts", async () => {
    const runAction = vi.fn().mockResolvedValue({ token: "abc" });
    const r = await openEbaySellerSession({ runAction } as never, "owner-1");
    expect(r.ok && r.value).toMatchObject({ ownerId: "owner-1", token: "abc", reauthAttempted: false, dead: false });
    expect(runAction.mock.calls[0][1]).toEqual({ site: "ebay", userId: "owner-1" });
  });
});

describe("request shapes and headers", () => {
  test("every call sends the bearer token, marketplace and language headers and refuses redirects", async () => {
    answers.push(json({ programs: [{ programType: "SELLING_POLICY_MANAGEMENT" }, { nope: 1 }] }));
    const r = await getOptedInPrograms(noCredentialCalls, session());
    expect(r).toEqual({ ok: true, value: ["SELLING_POLICY_MANAGEMENT"] });
    expect(seen[0].url.href).toBe("https://api.sandbox.ebay.com/sell/account/v1/program/get_opted_in_programs");
    expect(seen[0].headers).toMatchObject({
      Authorization: "Bearer tok-1",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Language": "en-US",
      Accept: "application/json",
    });
    expect(seen[0].init.redirect).toBe("error");
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].headers["Content-Type"]).toBeUndefined();
  });

  test("optIn posts the program type and treats 409 as done", async () => {
    answers.push(json({ errors: [{ errorId: 20403 }] }, 409));
    const r = await optInToProgram(noCredentialCalls, session(), "SELLING_POLICY_MANAGEMENT");
    expect(r).toEqual({ ok: true, value: null });
    expect(seen[0].json).toEqual({ programType: "SELLING_POLICY_MANAGEMENT" });
    expect(seen[0].headers["Content-Type"]).toBe("application/json");
  });

  test("optIn surfaces other failures", async () => {
    answers.push(json({}, 500));
    expect(await optInToProgram(noCredentialCalls, session(), "X")).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 500 } });
  });

  test("getPolicies asks for the EBAY_US marketplace on the kind's path", async () => {
    answers.push(json({ fulfillmentPolicies: [] }));
    await getPolicies(noCredentialCalls, session(), "fulfillment_policy");
    expect(seen[0].url.pathname).toBe("/sell/account/v1/fulfillment_policy");
    expect(seen[0].url.searchParams.get("marketplace_id")).toBe("EBAY_US");
  });

  test("createPolicy returns the new id; fulfillment's path keeps its trailing slash", async () => {
    answers.push(json({ fulfillmentPolicyId: "FP1" }, 201), json({ paymentPolicyId: "PP1" }, 201));
    const f = await createPolicy(noCredentialCalls, session(), "fulfillment_policy", { name: "x" });
    const p = await createPolicy(noCredentialCalls, session(), "payment_policy", { name: "y" });
    expect(f).toEqual({ ok: true, value: "FP1" });
    expect(p).toEqual({ ok: true, value: "PP1" });
    expect(seen[0].url.pathname).toBe("/sell/account/v1/fulfillment_policy/");
    expect(seen[1].url.pathname).toBe("/sell/account/v1/payment_policy");
    expect(seen[0].init.method).toBe("POST");
  });

  test("createPolicy with no id in the answer is a bad_response", async () => {
    answers.push(json({}, 201));
    expect(await createPolicy(noCredentialCalls, session(), "return_policy", {})).toMatchObject({
      ok: false,
      failure: { kind: "bad_response" },
    });
  });

  test("getShippingServices narrows the metadata list", async () => {
    answers.push(
      json({
        shippingServices: [
          { shippingService: "USPSGroundAdvantage", shippingCarrier: "USPS", internationalService: false, validForSellingFlow: true, shippingCostTypes: ["FLAT_RATE", 7] },
          { shippingService: "x".repeat(81) },
          "junk",
        ],
      }),
    );
    const r = await getShippingServices(noCredentialCalls, session());
    expect(r).toEqual({
      ok: true,
      value: [{ code: "USPSGroundAdvantage", carrier: "USPS", international: false, validForSelling: true, costTypes: ["FLAT_RATE"] }],
    });
    expect(seen[0].url.pathname).toBe("/sell/metadata/v1/shipping/marketplace/EBAY_US/get_shipping_services");
  });

  test("upsertInventoryLocation creates, then on 409 updates the address", async () => {
    answers.push(json({}, 409), new Response(null, { status: 204 }));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "neonbinder-main", {
      postalCode: "53703",
      city: "Madison",
      stateOrProvince: "WI",
    });
    expect(r).toEqual({ ok: true, value: null });
    expect(seen[0].url.pathname).toBe("/sell/inventory/v1/location/neonbinder-main");
    expect(seen[0].json).toMatchObject({
      location: { address: { city: "Madison", stateOrProvince: "WI", postalCode: "53703", country: "US" } },
      locationTypes: ["WAREHOUSE"],
    });
    expect(seen[1].url.pathname).toBe("/sell/inventory/v1/location/neonbinder-main/update_location_details");
  });

  test("upsertInventoryLocation does not retry on a non-409 failure", async () => {
    answers.push(json({}, 400));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "k", { postalCode: "1", city: "c", stateOrProvince: "WI" });
    expect(r).toMatchObject({ ok: false, failure: { httpStatus: 400 } });
    expect(seen).toHaveLength(1);
  });

  test("getCardCategoryAspects reads category 261328 in tree 0", async () => {
    answers.push(json({ aspects: [] }));
    await getCardCategoryAspects(noCredentialCalls, session());
    expect(seen[0].url.pathname).toBe("/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category");
    expect(seen[0].url.searchParams.get("category_id")).toBe("261328");
  });

  test("uploadImage posts multipart to the media host with no JSON content type, and returns the https URL", async () => {
    answers.push(json({ imageUrl: "https://i.ebayimg.com/x.jpg", expirationDate: "2027-01-01T00:00:00.000Z" }, 201));
    const r = await uploadImage(noCredentialCalls, session(), { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "image/jpeg", fileName: "a.jpg" });
    expect(r).toEqual({ ok: true, value: { url: "https://i.ebayimg.com/x.jpg", expiresAt: Date.UTC(2027, 0, 1) } });
    expect(seen[0].url.origin).toBe("https://apim.sandbox.ebay.com");
    expect(seen[0].url.pathname).toBe("/commerce/media/v1_beta/image/create_image_from_file");
    expect(seen[0].init.body).toBeInstanceOf(FormData);
    expect((seen[0].init.body as FormData).get("image")).toBeInstanceOf(Blob);
    expect(seen[0].headers["Content-Type"]).toBeUndefined();
  });

  test("uploadImage refuses a non-https image URL", async () => {
    answers.push(json({ imageUrl: "http://insecure/x.jpg" }, 201));
    const r = await uploadImage(noCredentialCalls, session(), { bytes: new ArrayBuffer(1), contentType: "image/jpeg", fileName: "a.jpg" });
    expect(r).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
  });

  test("getOfferBySku asks for the SKU's fixed-price offer and returns only the exact SKU", async () => {
    answers.push(
      json({
        offers: [
          { offerId: "other", sku: "OTHER", status: "PUBLISHED" },
          { offerId: "O1", sku: "S", status: "PUBLISHED", listing: { listingId: "L1" } },
        ],
      }),
    );
    const r = await getOfferBySku(noCredentialCalls, session(), "S");
    expect(r).toEqual({ ok: true, value: { offerId: "O1", listingId: "L1", published: true } });
    expect(seen[0].url.searchParams.get("sku")).toBe("S");
    expect(seen[0].url.searchParams.get("format")).toBe("FIXED_PRICE");
  });

  test("getOfferBySku: a 404 and an empty list both mean no offer", async () => {
    answers.push(json({ errors: [{ errorId: 25713 }] }, 404), json({ offers: [] }));
    expect(await getOfferBySku(noCredentialCalls, session(), "S")).toEqual({ ok: true, value: null });
    expect(await getOfferBySku(noCredentialCalls, session(), "S")).toEqual({ ok: true, value: null });
  });

  test("updateOffer PUTs the full offer; withdraw POSTs the offer's withdraw path; ids are URL-encoded", async () => {
    answers.push(new Response(null, { status: 204 }), json({ listingId: "L" }));
    expect(await updateOffer(noCredentialCalls, session(), "O/1", { a: 1 })).toEqual({ ok: true, value: null });
    expect(await withdrawOffer(noCredentialCalls, session(), "O1")).toEqual({ ok: true, value: null });
    expect(seen[0].init.method).toBe("PUT");
    expect(seen[0].url.pathname).toBe("/sell/inventory/v1/offer/O%2F1");
    expect(seen[0].json).toEqual({ a: 1 });
    expect(seen[1].url.pathname).toBe("/sell/inventory/v1/offer/O1/withdraw");
    expect(seen[1].init.method).toBe("POST");
  });

  test("getOrdersPage passes the filter, page size and offset and reports whether more follow", async () => {
    answers.push(json({ orders: [{ orderId: "1" }], next: "https://x", total: 120 }), json({ orders: [] }));
    const first = await getOrdersPage(noCredentialCalls, session(), { filter: "lastmodifieddate:[2026..]", offset: 200 });
    expect(first).toEqual({ ok: true, value: { orders: [{ orderId: "1" }], more: true, total: 120 } });
    expect(seen[0].url.searchParams.get("filter")).toBe("lastmodifieddate:[2026..]");
    expect(seen[0].url.searchParams.get("limit")).toBe("100");
    expect(seen[0].url.searchParams.get("offset")).toBe("200");
    const last = await getOrdersPage(noCredentialCalls, session(), { filter: "f", offset: 0 });
    expect(last).toEqual({ ok: true, value: { orders: [], more: false, total: null } });
  });
});

describe("bulk calls", () => {
  test("create-or-replace posts {requests}, and reads per-entry results", async () => {
    answers.push(json({ responses: [{ sku: "A", statusCode: 200 }, { sku: "B", statusCode: 400, errors: [{ errorId: 25001 }] }] }));
    const r = await bulkCreateOrReplaceInventoryItems(noCredentialCalls, session(), [{ sku: "A" }, { sku: "B" }]);
    expect(seen[0].url.pathname).toBe("/sell/inventory/v1/bulk_create_or_replace_inventory_item");
    expect(seen[0].json).toEqual({ requests: [{ sku: "A" }, { sku: "B" }] });
    expect(r).toEqual({
      ok: true,
      value: [
        { statusCode: 200, sku: "A", offerId: null, listingId: null, errorIds: [] },
        { statusCode: 400, sku: "B", offerId: null, listingId: null, errorIds: [25001] },
      ],
    });
  });

  test("a 400 whose body carries per-entry responses is still an answer", async () => {
    answers.push(json({ responses: [{ sku: "A", statusCode: 400, errors: [{ errorId: 25002 }] }] }, 400));
    const r = await bulkCreateOffers(noCredentialCalls, session(), [{ sku: "A" }]);
    expect(r.ok && r.value[0].errorIds).toEqual([25002]);
  });

  test("a 400 with no per-entry responses fails, with ids and no eBay text", async () => {
    answers.push(json({ errors: [{ errorId: 25000, message: "SECRET-DETAIL echo" }] }, 400));
    const r = await bulkCreateOffers(noCredentialCalls, session(), [{ sku: "A" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.errorIds).toEqual([25000]);
      expect(r.failure.message).not.toContain("SECRET-DETAIL");
    }
  });

  test("publish sends offer ids; price/quantity sends the nested update shape", async () => {
    answers.push(json({ responses: [{ offerId: "O1", statusCode: 200, listingId: "L1" }] }), json({ responses: [] }));
    const pub = await bulkPublishOffers(noCredentialCalls, session(), ["O1"]);
    expect(pub.ok && pub.value[0]).toMatchObject({ offerId: "O1", listingId: "L1" });
    expect(seen[0].json).toEqual({ requests: [{ offerId: "O1" }] });
    await bulkUpdatePriceQuantity(noCredentialCalls, session(), [{ sku: "S", offerId: "O1", quantity: 3, price: { value: "4.50", currency: "USD" } }]);
    expect(seen[1].json).toEqual({
      requests: [
        {
          sku: "S",
          shipToLocationAvailability: { quantity: 3 },
          offers: [{ offerId: "O1", availableQuantity: 3, price: { value: "4.50", currency: "USD" } }],
        },
      ],
    });
  });

  test("entries beyond fifty are ignored and unreadable ones skipped", async () => {
    answers.push(json({ responses: [...Array.from({ length: 60 }, (_, i) => ({ sku: `S${i}`, statusCode: 200 })), "junk"] }));
    const r = await bulkCreateOffers(noCredentialCalls, session(), []);
    expect(r.ok && r.value).toHaveLength(50);
  });
});

describe("error handling", () => {
  test("a non-2xx fails http with the ids and a message that does not echo eBay's body", async () => {
    answers.push(json({ errors: [{ errorId: 2004, message: "buyer name Jane Doe leaked", longMessage: "more" }] }, 500));
    const r = await getPolicies(noCredentialCalls, session(), "payment_policy");
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 500, errorIds: [2004] } });
    if (!r.ok) expect(r.failure.message).not.toContain("Jane");
  });

  test("a non-JSON 200 is a bad_response", async () => {
    answers.push(new Response("<html>nope</html>", { status: 200 }));
    expect(await getPolicies(noCredentialCalls, session(), "payment_policy")).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
  });

  test("a network error and a timeout are told apart", async () => {
    answers.push(new TypeError("fetch failed"), Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await getPolicies(noCredentialCalls, session(), "payment_policy")).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(await getPolicies(noCredentialCalls, session(), "payment_policy")).toMatchObject({ ok: false, failure: { kind: "timeout" } });
  });

  test("errorIdsOf reads integer ids only, capped at 20", () => {
    expect(errorIdsOf({ errors: [{ errorId: 1 }, { errorId: "2" }, {}, { errorId: 3.5 }] })).toEqual([1]);
    expect(errorIdsOf({ errors: Array.from({ length: 30 }, (_, i) => ({ errorId: i })) })).toHaveLength(20);
    expect(errorIdsOf(null)).toEqual([]);
    expect(errorIdsOf({ warnings: [{ errorId: 1 }] })).toEqual([]);
  });
});

describe("the 401 refresh path", () => {
  test("a 401 refreshes the token once, retries with the new token and succeeds", async () => {
    answers.push(json({}, 401), json({ programs: [] }));
    const runAction = vi
      .fn()
      .mockResolvedValueOnce({ refreshed: true })
      .mockResolvedValueOnce({ token: "tok-2" });
    const s = session();
    const r = await getOptedInPrograms({ runAction } as never, s);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0].headers.Authorization).toBe("Bearer tok-1");
    expect(seen[1].headers.Authorization).toBe("Bearer tok-2");
    expect(s.reauthAttempted).toBe(true);
    expect(s.dead).toBe(false);
  });

  test("a second 401 after a refresh kills the session; later calls do not touch eBay", async () => {
    answers.push(json({}, 401), json({}, 401));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: true }).mockResolvedValueOnce({ token: "tok-2" });
    const s = session();
    const r = await getOptedInPrograms({ runAction } as never, s);
    expect(r).toMatchObject({ ok: false, failure: { kind: "signed_out", httpStatus: 401 } });
    expect(s.dead).toBe(true);
    const again = await getOptedInPrograms({ runAction } as never, s);
    expect(again).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(seen).toHaveLength(2);
  });

  test("a refresh that does not renew (needs reauth) kills the session without retrying", async () => {
    answers.push(json({}, 401));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: false });
    const s = session();
    const r = await getOptedInPrograms({ runAction } as never, s);
    expect(r).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(seen).toHaveLength(1);
    expect(s.dead).toBe(true);
  });

  test("a refresh that throws kills the session", async () => {
    answers.push(json({}, 401));
    const runAction = vi.fn().mockRejectedValue(new Error("service down"));
    const s = session();
    expect(await getOptedInPrograms({ runAction } as never, s)).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(s.dead).toBe(true);
  });

  test("a second 401 later in the same session does not refresh again", async () => {
    answers.push(json({}, 401), json({ programs: [] }), json({}, 401));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: true }).mockResolvedValueOnce({ token: "tok-2" });
    const s = session();
    await getOptedInPrograms({ runAction } as never, s);
    const r = await getOptedInPrograms({ runAction } as never, s);
    expect(r).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(runAction).toHaveBeenCalledTimes(2);
  });
});
