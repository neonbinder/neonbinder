/**
 * NEO-415 — the eBay seller client: request shapes and headers per call,
 * bulk results, error handling that never echoes eBay's text, and the
 * once-per-session 401 refresh. `fetch` is stubbed; nothing reaches eBay.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bulkCreateOffers,
  bulkCreateOrReplaceInventoryItems,
  bulkUpdatePriceQuantity,
  createPolicy,
  deleteInventoryItem,
  ebayErrorDetailsOf,
  errorIdsOf,
  getCardCategoryAspects,
  getOfferBySku,
  getOptedInPrograms,
  getOrdersPage,
  getPolicies,
  getShippingServices,
  openEbaySellerSession,
  optInToProgram,
  EBAY_PUBLISH_RETRY_PAUSE_MS,
  publishOffer,
  redactEbayText,
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

/** The wait before a busy publish's retry, returning at once; records each wait asked for. */
const pauses: number[] = [];
const noPause = async (ms: number): Promise<void> => {
  pauses.push(ms);
};
beforeEach(() => {
  pauses.length = 0;
});

/** The JSON log lines `log` captured for one operation. */
function linesFor(log: { mock: { calls: unknown[][] } }, operation: string): Array<Record<string, unknown>> {
  return log.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.operation === operation);
}

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
          {
            shippingService: "USPSParcel",
            description: "USPS Ground Advantage",
            shippingCarrier: "USPS",
            internationalService: false,
            validForSellingFlow: true,
            shippingCostTypes: ["FLAT_RATE", 7],
          },
          { shippingService: "USPSFirstClass", description: 12, validForSellingFlow: true },
          { shippingService: "x".repeat(81) },
          "junk",
        ],
      }),
    );
    const r = await getShippingServices(noCredentialCalls, session());
    expect(r).toEqual({
      ok: true,
      value: [
        {
          code: "USPSParcel",
          description: "USPS Ground Advantage",
          carrier: "USPS",
          international: false,
          validForSelling: true,
          validForSellingStated: true,
          costTypes: ["FLAT_RATE"],
          category: null,
          minDays: null,
          maxDays: null,
          packageLimits: null,
        },
        {
          code: "USPSFirstClass",
          description: null,
          carrier: null,
          international: false,
          validForSelling: true,
          validForSellingStated: true,
          costTypes: [],
          category: null,
          minDays: null,
          maxDays: null,
          packageLimits: null,
        },
      ],
    });
    expect(seen[0].url.pathname).toBe("/sell/metadata/v1/shipping/marketplace/EBAY_US/get_shipping_services");
  });

  test("getShippingServices keeps what eBay states about a service for the refusal log: category, days, package limits, and whether validForSellingFlow was sent", async () => {
    answers.push(
      json({
        shippingServices: [
          {
            shippingService: "US_eBayStandardEnvelope",
            description: "eBay Standard Envelope",
            shippingCarrier: "EBAY_SEND",
            shippingCategory: "STANDARD",
            minShippingTime: 3,
            maxShippingTime: 6,
            validForSellingFlow: true,
            shippingCostTypes: ["CALCULATED", "FLAT"],
            packageLimits: { maxWeight: 3, weightUnit: "OUNCE", maxLength: "9", dimensionUnit: "" },
          },
          { shippingService: "NoFlag", minShippingTime: -1, maxShippingTime: 1.5, packageLimits: {} },
        ],
      }),
    );
    const r = await getShippingServices(noCredentialCalls, session());
    expect(r.ok && r.value[0]).toMatchObject({
      code: "US_eBayStandardEnvelope",
      carrier: "EBAY_SEND",
      category: "STANDARD",
      minDays: 3,
      maxDays: 6,
      validForSelling: true,
      validForSellingStated: true,
      costTypes: ["CALCULATED", "FLAT"],
      // Only finite numbers and non-empty unit words: the string "9" and the empty unit are dropped.
      packageLimits: { maxWeight: 3, weightUnit: "OUNCE" },
    });
    // A flag eBay left out reads false for selling, and says it was left out.
    expect(r.ok && r.value[1]).toMatchObject({
      validForSelling: false,
      validForSellingStated: false,
      minDays: null,
      maxDays: null,
      packageLimits: null,
      category: null,
    });
  });

  test("upsertInventoryLocation: a location eBay does not have yet is created, enabled, as a US warehouse", async () => {
    answers.push(json({ errors: [{ errorId: 25805 }] }, 404), new Response(null, { status: 204 }));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "neonbinder-main", {
      postalCode: "53703",
      city: "Madison",
      stateOrProvince: "WI",
    });
    expect(r).toEqual({ ok: true, value: null });
    expect(seen.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["GET", "/sell/inventory/v1/location/neonbinder-main"],
      ["POST", "/sell/inventory/v1/location/neonbinder-main"],
    ]);
    expect(seen[1].json).toEqual({
      location: { address: { city: "Madison", stateOrProvince: "WI", postalCode: "53703", country: "US" } },
      locationTypes: ["WAREHOUSE"],
      name: "NeonBinder",
      merchantLocationStatus: "ENABLED",
    });
  });

  test("upsertInventoryLocation: a location eBay already has gets its address updated, never created again", async () => {
    // The sandbox answers a create of an existing key with 400 (the contract says 409).
    answers.push(json({ merchantLocationKey: "neonbinder-main", merchantLocationStatus: "ENABLED" }), new Response(null, { status: 204 }));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "neonbinder-main", {
      postalCode: "53703",
      city: "Madison",
      stateOrProvince: "WI",
    });
    expect(r).toEqual({ ok: true, value: null });
    expect(seen.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["GET", "/sell/inventory/v1/location/neonbinder-main"],
      ["POST", "/sell/inventory/v1/location/neonbinder-main/update_location_details"],
    ]);
    expect(seen[1].json).toEqual({
      location: { address: { city: "Madison", stateOrProvince: "WI", postalCode: "53703", country: "US" } },
      locationTypes: ["WAREHOUSE"],
      name: "NeonBinder",
    });
  });

  test("upsertInventoryLocation: a location the seller disabled is updated, then enabled", async () => {
    answers.push(json({ merchantLocationStatus: "DISABLED" }), new Response(null, { status: 204 }), json({}));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "k", { postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    expect(r).toEqual({ ok: true, value: null });
    expect(seen.map((c) => c.url.pathname)).toEqual([
      "/sell/inventory/v1/location/k",
      "/sell/inventory/v1/location/k/update_location_details",
      "/sell/inventory/v1/location/k/enable",
    ]);
    expect(seen[2].init.body).toBeUndefined();
  });

  test("upsertInventoryLocation: a create that loses a race to another save reads again and updates", async () => {
    answers.push(json({}, 404), json({ errors: [{ errorId: 25803 }] }, 400), json({ merchantLocationStatus: "ENABLED" }), new Response(null, { status: 204 }));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "k", { postalCode: "53703", city: "Madison", stateOrProvince: "WI" });
    expect(r).toEqual({ ok: true, value: null });
    expect(seen.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["GET", "/sell/inventory/v1/location/k"],
      ["POST", "/sell/inventory/v1/location/k"],
      ["GET", "/sell/inventory/v1/location/k"],
      ["POST", "/sell/inventory/v1/location/k/update_location_details"],
    ]);
  });

  test("upsertInventoryLocation: a refused create of a location still not there is the create's own failure", async () => {
    answers.push(json({}, 404), json({ errors: [{ errorId: 25801 }] }, 400), json({}, 404));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "k", { postalCode: "1", city: "c", stateOrProvince: "WI" });
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 400, errorIds: [25801] } });
    expect(seen).toHaveLength(3);
  });

  test("upsertInventoryLocation: a failed read (not a 404) stops before any write", async () => {
    answers.push(json({}, 500));
    const r = await upsertInventoryLocation(noCredentialCalls, session(), "k", { postalCode: "1", city: "c", stateOrProvince: "WI" });
    expect(r).toMatchObject({ ok: false, failure: { httpStatus: 500 } });
    expect(seen).toHaveLength(1);
  });

  test("a failure says it in NB's words: never eBay's status, the call, or eBay's text", async () => {
    answers.push(
      json({ errors: [{ errorId: 1, message: "RAW" }] }, 400),
      json({}, 503),
      json({}, 429),
      new Response("<html>nope</html>", { status: 200 }),
    );
    const said: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await getPolicies(noCredentialCalls, session(), "payment_policy");
      said.push(r.ok ? "" : r.failure.message);
    }
    expect(said).toEqual([
      "eBay turned that one down. Try again in a bit.",
      "eBay's not answering right now. Try again in a bit.",
      "eBay's not answering right now. Try again in a bit.",
      "eBay sent back something NeonBinder couldn't read. Try again in a bit.",
    ]);
    expect(said.join(" ")).not.toMatch(/answered|get_payment_policy|RAW|\d{3}/);
  });

  test("a bulk call refused outright says it in NB's words and logs the ids", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(json({ errors: [{ errorId: 25001 }] }, 400));
    const r = await bulkCreateOffers(noCredentialCalls, session(), [{ sku: "A" }]);
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    log.mockRestore();
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 400, errorIds: [25001], message: "eBay turned that one down. Try again in a bit." } });
    expect(lines).toContainEqual({ msg: "ebay_seller_error", platform: "ebay", operation: "bulkCreateOffer", httpStatus: 400, errorIds: [25001] });
  });

  test("an answer that is not JSON is logged with its reason, not its body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(new Response("SECRET-BODY", { status: 200 }));
    await getPolicies(noCredentialCalls, session(), "return_policy");
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({
      msg: "ebay_seller_error",
      platform: "ebay",
      operation: "get_return_policy",
      httpStatus: 200,
      reason: "body_not_json",
    });
    expect(lines.join("\n")).not.toContain("SECRET-BODY");
  });

  test("a refusal logs eBay's ids, its text and the field it names; the failure itself still says only NB's words", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The shape of the sandbox's answer to an eSE fulfillment policy (20403).
    answers.push(
      json(
        {
          errors: [
            {
              errorId: 20403,
              domain: "API_ACCOUNT",
              category: "REQUEST",
              message: "Invalid .",
              longMessage: "Please select a valid shipping service.",
              inputRefIds: ["service"],
              parameters: [{ name: "XPATH", value: "DomesticItemShippingService[0].shippingService" }],
            },
          ],
        },
        400,
      ),
    );
    const r = await createPolicy(noCredentialCalls, session(), "fulfillment_policy", { name: "NB Standard Envelope (under $20)" });
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "ebay_seller_error");
    expect(errorLine).toEqual({
      msg: "ebay_seller_error",
      platform: "ebay",
      operation: "create_fulfillment_policy",
      httpStatus: 400,
      errorIds: [20403],
      errors: [
        {
          errorId: 20403,
          message: "Invalid .",
          longMessage: "Please select a valid shipping service.",
          parameters: [{ name: "XPATH", value: "DomesticItemShippingService[0].shippingService" }],
          inputRefIds: ["service"],
        },
      ],
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", errorIds: [20403], message: "eBay turned that one down. Try again in a bit." } });
    expect(JSON.stringify(r)).not.toMatch(/shipping service|XPATH/);
  });

  test("the logged eBay text never carries the token, the request body or what looks like the seller's data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const token = "v^1.1#i^1#r^1#p^3#I^3#f^0#t^Ul4xMF8yOjNBQjE2RkE4QkQ0RjE2QzI3NjhGNTlBRTg0NkM4MkQzXzNfMSNFXjI2MA==";
    answers.push(
      json(
        {
          errors: [
            {
              errorId: 25002,
              message: `Bearer ${token} rejected for jane.doe@example.com at 53703, order 12-34567-89012`,
              longMessage: `See https://api.sandbox.ebay.com/sell/inventory/v1/offer?sku=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ${"x ".repeat(400)}`,
              parameters: [
                { name: "postalCode", value: "53703" },
                { name: "token", value: token },
                { name: "   " },
                "junk",
              ],
              inputRefIds: [7, "eyJhbGciOiJSUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123.eyJzdWIiOiJ4In0"],
            },
          ],
        },
        400,
      ),
    );
    await createPolicy(noCredentialCalls, session({ token }), "fulfillment_policy", { name: "SECRET-BODY-NAME" });
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    const all = lines.join("\n");
    for (const leak of [token, "Ul4xMF8y", "jane.doe", "example.com", "53703", "34567", "89012", "sku=", "SECRET-BODY-NAME", "eyJhbGci", "tok-1"]) {
      expect(all).not.toContain(leak);
    }
    const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "ebay_seller_error");
    const [detail] = errorLine.errors;
    expect(detail.message).toBe("Bearer [redacted] rejected for [redacted] at [redacted], order 12-[redacted]-[redacted]");
    expect(detail.longMessage.length).toBeLessThanOrEqual(300);
    expect(detail.parameters).toEqual([
      { name: "postalCode", value: "[redacted]" },
      { name: "token", value: "[redacted]" },
    ]);
    expect(detail.inputRefIds).toEqual(["[redacted]"]);
  });

  test("an error body with ids only logs the ids and no errors list", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(json({ errors: [{ errorId: 25803 }, { errorId: 25804, message: "" }] }, 400));
    await getPolicies(noCredentialCalls, session(), "payment_policy");
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    log.mockRestore();
    expect(lines.find((l) => l.msg === "ebay_seller_error")).toEqual({
      msg: "ebay_seller_error",
      platform: "ebay",
      operation: "get_payment_policy",
      httpStatus: 400,
      errorIds: [25803, 25804],
    });
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

  test("uploadImage's body is the Media contract's multipart: one part named image, carrying the file name, its type and the bytes", async () => {
    answers.push(json({ imageUrl: "https://i.ebayimg.com/x.jpg" }, 201));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await uploadImage(noCredentialCalls, session(), { bytes: bytes.buffer, contentType: "image/jpeg", fileName: "front.jpg" });
    const encoded = new Response(seen[0].init.body as FormData);
    const contentType = encoded.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const raw = new Uint8Array(await encoded.arrayBuffer());
    const text = new TextDecoder("latin1").decode(raw);
    expect(text.match(/Content-Disposition: form-data;/g)).toHaveLength(1);
    expect(text).toContain('Content-Disposition: form-data; name="image"; filename="front.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    expect(text).toContain(new TextDecoder("latin1").decode(bytes));
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].headers.Authorization).toMatch(/^Bearer /);
  });

  test("uploadImage: a 201 with no URL in its body reads the image named by the Location header, on the media host", async () => {
    answers.push(
      new Response(null, { status: 201, headers: { location: "https://apim.sandbox.ebay.com/commerce/media/v1_beta/image/v1%7C1234%7C0" } }),
      json({ imageUrl: "https://i.ebayimg.com/images/g/abc/s-l1600.jpg", expirationDate: "2027-01-01T00:00:00.000Z" }),
    );
    const r = await uploadImage(noCredentialCalls, session(), { bytes: new ArrayBuffer(1), contentType: "image/jpeg", fileName: "a.jpg" });
    expect(r).toEqual({ ok: true, value: { url: "https://i.ebayimg.com/images/g/abc/s-l1600.jpg", expiresAt: Date.UTC(2027, 0, 1) } });
    expect(seen).toHaveLength(2);
    expect(seen[1].init.method).toBe("GET");
    expect(seen[1].url.origin).toBe("https://apim.sandbox.ebay.com");
    expect(seen[1].url.pathname).toBe("/commerce/media/v1_beta/image/v1%7C1234%7C0");
  });

  test("uploadImage: a Location on another host is still read from the configured media host only", async () => {
    answers.push(
      new Response(null, { status: 201, headers: { location: "https://evil.example/commerce/media/v1_beta/image/IMG1" } }),
      json({ imageUrl: "https://i.ebayimg.com/x.jpg" }),
    );
    const r = await uploadImage(noCredentialCalls, session(), { bytes: new ArrayBuffer(1), contentType: "image/jpeg", fileName: "a.jpg" });
    expect(r.ok).toBe(true);
    expect(seen[1].url.href).toBe("https://apim.sandbox.ebay.com/commerce/media/v1_beta/image/IMG1");
  });

  test("uploadImage: no URL in the body and no image id in a Location is a bad_response, with no second call", async () => {
    answers.push(new Response(null, { status: 201, headers: { location: "https://apim.sandbox.ebay.com/somewhere/else" } }));
    const r = await uploadImage(noCredentialCalls, session(), { bytes: new ArrayBuffer(1), contentType: "image/jpeg", fileName: "a.jpg" });
    expect(r).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
    expect(seen).toHaveLength(1);
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

  test("deleteInventoryItem DELETEs the URL-encoded SKU with no body; 204 is success", async () => {
    answers.push(new Response(null, { status: 204 }));
    expect(await deleteInventoryItem(noCredentialCalls, session(), "NB2/a b-NM")).toEqual({ ok: true, value: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].init.method).toBe("DELETE");
    expect(seen[0].url.pathname).toBe("/sell/inventory/v1/inventory_item/NB2%2Fa%20b-NM");
    expect(seen[0].init.body).toBeUndefined();
  });

  test("deleteInventoryItem: a 404 means already gone, so success", async () => {
    answers.push(json({ errors: [{ errorId: 25710 }] }, 404));
    expect(await deleteInventoryItem(noCredentialCalls, session(), "S")).toEqual({ ok: true, value: null });
  });

  test.each([
    [400, 25702],
    [400, 25709],
    [500, 25001],
  ])("deleteInventoryItem: a %i with error %i is a failure", async (status, errorId) => {
    answers.push(json({ errors: [{ errorId }] }, status));
    expect(await deleteInventoryItem(noCredentialCalls, session(), "S")).toMatchObject({
      ok: false,
      failure: { kind: "http", httpStatus: status, errorIds: [errorId] },
    });
  });

  test("deleteInventoryItem logs its operation and outcome, never the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(new Response(null, { status: 204 }));
    await deleteInventoryItem(noCredentialCalls, session(), "S");
    const lines = linesFor(log, "deleteInventoryItem");
    const text = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: "ebay_seller_call", outcome: "ok", httpStatus: 204 });
    expect(text).not.toContain("tok-1");
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
        { statusCode: 200, sku: "A", offerId: null, listingId: null, errorIds: [], errors: [] },
        { statusCode: 400, sku: "B", offerId: null, listingId: null, errorIds: [25001], errors: [] },
      ],
    });
  });

  test("a 400 whose body carries per-entry responses is still an answer", async () => {
    answers.push(json({ responses: [{ sku: "A", statusCode: 400, errors: [{ errorId: 25002 }] }] }, 400));
    const r = await bulkCreateOffers(noCredentialCalls, session(), [{ sku: "A" }]);
    expect(r.ok && r.value[0].errorIds).toEqual([25002]);
  });

  test("a 400 bulk entry carries eBay's message and parameters, redacted and capped, for the log line", async () => {
    const token = "v^1.1#i^1#r^0#I^3#p^3#f^0#t^H4sIAAAAAAAAAOVYa2wUVRTe";
    answers.push(
      json(
        {
          responses: [
            {
              sku: "NB2-abc-NM",
              statusCode: 400,
              errors: [
                {
                  errorId: 25717,
                  message: "Invalid value. contact seller@example.com",
                  longMessage: `The value is too long. ${token}`,
                  parameters: [
                    { name: "sku", value: "NB2-abc-NM" },
                    ...Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, value: "x".repeat(500) })),
                  ],
                },
              ],
            },
          ],
        },
        400,
      ),
    );
    const r = await bulkCreateOrReplaceInventoryItems(noCredentialCalls, session(), [{ sku: "NB2-abc-NM" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [detail] = r.value[0].errors;
    expect(r.value[0].errorIds).toEqual([25717]);
    expect(detail.errorId).toBe(25717);
    expect(detail.message).toBe("Invalid value. contact [redacted]");
    expect(detail.longMessage).toBe("The value is too long. [redacted]");
    expect(detail.parameters?.[0]).toEqual({ name: "sku", value: "NB2-abc-NM" });
    expect(detail.parameters).toHaveLength(8);
    expect(JSON.stringify(r.value)).not.toContain("seller@example.com");
    expect(JSON.stringify(r.value)).not.toContain("H4sIAAAAAAAAAOVYa2wUVRTe");
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

  test("price/quantity sends the nested update shape", async () => {
    answers.push(json({ responses: [] }));
    await bulkUpdatePriceQuantity(noCredentialCalls, session(), [{ sku: "S", offerId: "O1", quantity: 3, price: { value: "4.50", currency: "USD" } }]);
    expect(seen[0].json).toEqual({
      requests: [
        {
          sku: "S",
          shipToLocationAvailability: { quantity: 3 },
          offers: [{ offerId: "O1", availableQuantity: 3, price: { value: "4.50", currency: "USD" } }],
        },
      ],
    });
  });

  test("publishOffer posts to the one offer's publish path, no body, and reads the listing id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(json({ listingId: "110012345", warnings: [] }));
    const r = await publishOffer(noCredentialCalls, session(), "O 1/x");
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    log.mockRestore();
    expect(r).toEqual({ ok: true, value: { statusCode: 200, listingId: "110012345", errorIds: [], errors: [] } });
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/sell/inventory/v1/offer/O%201%2Fx/publish");
    expect(seen[0].init.body).toBeUndefined();
    expect(seen[0].init.redirect).toBe("error");
    expect(lines).toContainEqual(expect.objectContaining({ msg: "ebay_seller_call", operation: "publishOffer", outcome: "ok", httpStatus: 200 }));
  });

  test.each([400, 404, 409, 422])("publishOffer: eBay refusing the offer (%i) is an answer with its ids and redacted details", async (status) => {
    answers.push(json({ errors: [{ errorId: 25007, message: "Add a valid shipping service seller@example.com" }] }, status));
    const r = await publishOffer(noCredentialCalls, session(), "O1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ statusCode: status, listingId: null, errorIds: [25007] });
    expect(r.value.errors[0].message).toBe("Add a valid shipping service [redacted]");
  });

  test.each([503, 500, 429])("publishOffer: a %i twice fails the call (eBay busy, not this offer)", async (status) => {
    answers.push(json({ errors: [{ errorId: 1 }] }, status), json({ errors: [{ errorId: 1 }] }, status));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: status } });
    expect(seen).toHaveLength(2);
  });

  test("publishOffer: a 403 fails the call (eBay refusing the seller, not this offer)", async () => {
    answers.push(json({ errors: [{ errorId: 1 }] }, 403));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 403 } });
  });

  test("publishOffer: a 400 that is not JSON fails the call", async () => {
    answers.push(new Response("<html>bad</html>", { status: 400 }));
    expect(await publishOffer(noCredentialCalls, session(), "O1")).toMatchObject({ ok: false, failure: { httpStatus: 400 } });
  });

  test("entries beyond fifty are ignored and unreadable ones skipped", async () => {
    answers.push(json({ responses: [...Array.from({ length: 60 }, (_, i) => ({ sku: `S${i}`, statusCode: 200 })), "junk"] }));
    const r = await bulkCreateOffers(noCredentialCalls, session(), []);
    expect(r.ok && r.value).toHaveLength(50);
  });
});

describe("publishOffer: one retry when eBay is busy", () => {
  test("500 then 200: published, after one retry and one pause; each try logs its own line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(json({ errors: [{ errorId: 25001, message: "System error" }] }, 500), json({ listingId: "L7" }));
    const r = await publishOffer(noCredentialCalls, session(), "O1", noPause);
    const lines = linesFor(log, "publishOffer");
    log.mockRestore();
    expect(r).toEqual({ ok: true, value: { statusCode: 200, listingId: "L7", errorIds: [], errors: [] } });
    expect(seen).toHaveLength(2);
    expect(seen.map((x) => x.url.pathname)).toEqual(["/sell/inventory/v1/offer/O1/publish", "/sell/inventory/v1/offer/O1/publish"]);
    expect(pauses).toEqual([EBAY_PUBLISH_RETRY_PAUSE_MS]);
    expect(lines.map((l) => l.msg)).toEqual(["ebay_seller_call", "ebay_seller_error", "ebay_seller_call"]);
    expect(lines[0]).toMatchObject({ outcome: "http_error", httpStatus: 500 });
    expect(lines[0]).not.toHaveProperty("attempt");
    expect(lines[1]).toMatchObject({ httpStatus: 500, errorIds: [25001] });
    expect(lines[1]).not.toHaveProperty("attempt");
    expect(lines[2]).toMatchObject({ outcome: "ok", httpStatus: 200, attempt: 2 });
    // No token in any line.
    expect(JSON.stringify(lines)).not.toContain("tok-1");
  });

  test("429 then 200: published", async () => {
    answers.push(json({ errors: [{ errorId: 2001 }] }, 429), json({ listingId: "L8" }));
    const r = await publishOffer(noCredentialCalls, session(), "O1", noPause);
    expect(r).toMatchObject({ ok: true, value: { statusCode: 200, listingId: "L8" } });
    expect(seen).toHaveLength(2);
    expect(pauses).toEqual([EBAY_PUBLISH_RETRY_PAUSE_MS]);
  });

  test("500 then 500: the second answer is the failure, as before; never a third try", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    answers.push(json({ errors: [{ errorId: 25001 }] }, 500), json({ errors: [{ errorId: 25001 }] }, 500));
    const r = await publishOffer(noCredentialCalls, session(), "O1", noPause);
    const errors = linesFor(log, "publishOffer").filter((l) => l.msg === "ebay_seller_error");
    log.mockRestore();
    expect(r).toMatchObject({ ok: false, failure: { kind: "http", httpStatus: 500, errorIds: [25001] } });
    expect(seen).toHaveLength(2);
    expect(pauses).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).not.toHaveProperty("attempt");
    expect(errors[1]).toMatchObject({ httpStatus: 500, attempt: 2 });
  });

  test("500 then a refusal: the retry's answer is the result", async () => {
    answers.push(json({}, 500), json({ errors: [{ errorId: 25007 }] }, 400));
    const r = await publishOffer(noCredentialCalls, session(), "O1", noPause);
    expect(r).toMatchObject({ ok: true, value: { statusCode: 400, listingId: null, errorIds: [25007] } });
    expect(seen).toHaveLength(2);
  });

  test.each([400, 404, 409, 422])("a %i refusal of the offer is not retried", async (status) => {
    answers.push(json({ errors: [{ errorId: 25007 }] }, status));
    const r = await publishOffer(noCredentialCalls, session(), "O1", noPause);
    expect(r).toMatchObject({ ok: true, value: { statusCode: status } });
    expect(seen).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  test.each([403, 400])("a %i that fails the call is not retried", async (status) => {
    // A 400 that is not JSON is no answer: it fails the call, still without a retry.
    answers.push(status === 400 ? new Response("<html>bad</html>", { status }) : json({ errors: [{ errorId: 1 }] }, status));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { httpStatus: status } });
    expect(seen).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  test("a timeout, a network failure and an unreadable answer are not retried", async () => {
    answers.push(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "timeout" } });
    answers.push(new TypeError("fetch failed"));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "network" } });
    answers.push(new Response("<html>ok?</html>", { status: 200 }));
    expect(await publishOffer(noCredentialCalls, session(), "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
    expect(seen).toHaveLength(3);
    expect(pauses).toEqual([]);
  });

  test("a 401 the refresh cannot fix is signed out, not retried as busy", async () => {
    answers.push(json({}, 401));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: false });
    const s = session();
    expect(await publishOffer({ runAction } as never, s, "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(seen).toHaveLength(1);
    expect(pauses).toEqual([]);
    expect(s.dead).toBe(true);
  });

  test("a 401 refreshed, then busy, then fine: one refresh, one busy retry, both with the new token", async () => {
    answers.push(json({}, 401), json({}, 503), json({ listingId: "L9" }));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: true }).mockResolvedValueOnce({ token: "tok-2" });
    const s = session();
    const r = await publishOffer({ runAction } as never, s, "O1", noPause);
    expect(r).toMatchObject({ ok: true, value: { listingId: "L9" } });
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(seen.map((x) => x.headers.Authorization)).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-2"]);
    expect(pauses).toHaveLength(1);
  });

  test("busy, then a 401 on the retry after the session's one refresh: signed out, no further call", async () => {
    answers.push(json({}, 503), json({}, 401));
    const runAction = vi.fn();
    const s = session({ reauthAttempted: true });
    expect(await publishOffer({ runAction } as never, s, "O1", noPause)).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(seen).toHaveLength(2);
    expect(runAction).not.toHaveBeenCalled();
    expect(s.dead).toBe(true);
  });

  test("a session another call killed during the pause is not called again", async () => {
    answers.push(json({}, 503));
    const s = session();
    const r = await publishOffer(noCredentialCalls, s, "O1", async () => {
      s.dead = true;
    });
    expect(r).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(seen).toHaveLength(1);
  });

  test("without an injected pause the retry waits EBAY_PUBLISH_RETRY_PAUSE_MS of real time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      answers.push(json({}, 500), json({ listingId: "L1" }));
      const pending = publishOffer(noCredentialCalls, session(), "O1");
      await vi.advanceTimersByTimeAsync(EBAY_PUBLISH_RETRY_PAUSE_MS - 1);
      expect(seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true, value: { listingId: "L1" } });
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  test("ebayErrorDetailsOf caps errors and parameters, keeps field paths, and drops a longMessage that repeats the message", () => {
    const many = { errors: Array.from({ length: 9 }, (_, i) => ({ errorId: i, message: `m${i}`, longMessage: `m${i}` })) };
    const details = ebayErrorDetailsOf(many);
    expect(details).toHaveLength(5);
    expect(details[0]).toEqual({ errorId: 0, message: "m0" });
    const params = ebayErrorDetailsOf({
      errors: [{ parameters: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, value: "Fulfillment.shippingOptions[0].costType" })) }],
    });
    expect(params[0].parameters).toHaveLength(8);
    expect(params[0].parameters?.[0]).toEqual({ name: "f0", value: "Fulfillment.shippingOptions[0].costType" });
    expect(ebayErrorDetailsOf(null)).toEqual([]);
    expect(ebayErrorDetailsOf({ warnings: [{ message: "w" }] })).toEqual([]);
  });

  test("redactEbayText keeps eBay's words and field paths, and takes out long runs, emails and long digit runs", () => {
    expect(redactEbayText("Invalid  shippingServiceCode.\n Please check.")).toBe("Invalid shippingServiceCode. Please check.");
    expect(redactEbayText("DomesticItemShippingService[0].shippingService")).toBe("DomesticItemShippingService[0].shippingService");
    expect(redactEbayText("a.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh.b")).toBe("[redacted]");
    expect(redactEbayText("mail a@b.co now")).toBe("mail [redacted] now");
    expect(redactEbayText("zip 1234 and 12345")).toBe("zip 1234 and [redacted]");
    expect(redactEbayText("   ")).toBeNull();
    expect(redactEbayText(42)).toBeNull();
    expect(redactEbayText("word ".repeat(100), 20)).toHaveLength(20);
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
    // The replaced token is kept so a raw log written after the refresh can still mask it.
    expect(s.pastTokens).toEqual(["tok-1"]);
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

  test("calls hit by a 401 at once share one refresh and all retry with the new token", async () => {
    answers.push(json({}, 401), json({}, 401), json({}, 401), json({ listingId: "L1" }), json({ listingId: "L2" }), json({ listingId: "L3" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runAction = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return { refreshed: true };
      })
      .mockResolvedValueOnce({ token: "tok-2" });
    const s = session();
    const all = Promise.all(["O1", "O2", "O3"].map((id) => publishOffer({ runAction } as never, s, id)));
    // Let all three 401s land while the one refresh is still running.
    await new Promise((r) => setTimeout(r, 0));
    release();
    const rs = await all;
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(seen.slice(0, 3).map((x) => x.headers.Authorization)).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-1"]);
    expect(seen.slice(3).map((x) => x.headers.Authorization)).toEqual(["Bearer tok-2", "Bearer tok-2", "Bearer tok-2"]);
    expect(s.dead).toBe(false);
  });

  test("calls hit by a 401 at once all fail signed out when the one refresh does not renew", async () => {
    answers.push(json({}, 401), json({}, 401));
    const runAction = vi.fn().mockResolvedValueOnce({ refreshed: false });
    const s = session();
    const rs = await Promise.all(["O1", "O2"].map((id) => publishOffer({ runAction } as never, s, id)));
    expect(rs).toEqual([
      expect.objectContaining({ ok: false, failure: expect.objectContaining({ kind: "signed_out" }) }),
      expect.objectContaining({ ok: false, failure: expect.objectContaining({ kind: "signed_out" }) }),
    ]);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(s.dead).toBe(true);
  });

  test("a session opened under the credential lock (reauthAttempted) never refreshes", async () => {
    answers.push(json({}, 401));
    const runAction = vi.fn();
    const s = session({ reauthAttempted: true });
    expect(await getOptedInPrograms({ runAction } as never, s)).toMatchObject({ ok: false, failure: { kind: "signed_out" } });
    expect(runAction).not.toHaveBeenCalled();
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
