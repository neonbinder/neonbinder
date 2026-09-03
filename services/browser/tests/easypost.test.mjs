/**
 * NEO-120 — tests for the EasyPost letter-postage client.
 *
 * Runs with no account, no API key and no network — which is the point:
 * EasyPost gates new accounts behind manual security verification, so a key may
 * be days away. Everything except "does a real label come back" is pinned here.
 *
 * The cases that matter are the expensive ones: buying the wrong rate, charging
 * for an address USPS can't deliver to, and mis-rounding money.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createEasyPostClient,
  moneyToCents,
  pickLetterRate,
  normalizeTracker,
  redactWebhookToken,
  MAX_SCANS,
  LETTER_PACKAGE,
  LETTER_LABEL_SIZE,
} = require("../dist/services/easypost.js");

const TO = {
  name: "Dana Reyes",
  line1: "118 North Pine Rd",
  city: "East Granby",
  state: "CT",
  postalCode: "06026",
  country: "US",
};

const FROM = {
  name: "Neon Seller",
  line1: "500 Commerce St",
  city: "Dallas",
  state: "TX",
  postalCode: "75202",
  country: "US",
};

const LETTER_RATE = { id: "rate_letter", service: "First", carrier: "USPS", rate: "0.78" };
const PARCEL_RATE = { id: "rate_parcel", service: "GroundAdvantage", carrier: "USPS", rate: "4.63" };

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** fetch stub returning queued responses in order, recording each call. */
function stubFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {}, init });
    const next = responses.shift();
    if (!next) throw new Error("stubFetch: unexpected extra request");
    return next;
  };
  return { impl, calls };
}

const shipmentResponse = (over = {}) => ({
  id: "shp_1",
  rates: [PARCEL_RATE, LETTER_RATE],
  to_address: {
    name: "Dana Reyes",
    street1: "118 N PINE RD",
    city: "EAST GRANBY",
    state: "CT",
    zip: "06026-9998",
    country: "US",
    verifications: { delivery: { success: true } },
  },
  ...over,
});

describe("moneyToCents", () => {
  it("converts decimal strings to integer cents", () => {
    assert.equal(moneyToCents("0.78"), 78);
    assert.equal(moneyToCents("1.07"), 107);
    assert.equal(moneyToCents("4.63"), 463);
    assert.equal(moneyToCents("10"), 1000);
    assert.equal(moneyToCents("0"), 0);
    assert.equal(moneyToCents("0.5"), 50);
  });

  // parseFloat("0.29") * 100 is 28.999999999999996. Rounding that per label is
  // how a month's postage total drifts off by cents.
  it("does not lose a cent to float error", () => {
    assert.equal(moneyToCents("0.29"), 29);
    assert.equal(moneyToCents("1.15"), 115);
    assert.equal(moneyToCents("2.675"), 268);
  });

  it("rejects junk rather than silently returning NaN", () => {
    assert.throws(() => moneyToCents("free"), /Unparseable/);
    assert.throws(() => moneyToCents(""), /Unparseable/);
  });
});

describe("pickLetterRate", () => {
  // The expensive mistake: silently buying a $4.63 parcel rate when the whole
  // feature exists to pay $0.78.
  it("picks the First-Class letter rate, never a parcel rate", () => {
    assert.equal(pickLetterRate([PARCEL_RATE, LETTER_RATE]).id, "rate_letter");
  });

  it("returns undefined when no letter rate is offered", () => {
    assert.equal(pickLetterRate([PARCEL_RATE]), undefined);
    assert.equal(pickLetterRate([]), undefined);
    assert.equal(pickLetterRate(undefined), undefined);
  });

  it("ignores a non-USPS carrier offering a service of the same name", () => {
    assert.equal(
      pickLetterRate([{ id: "r", service: "First", carrier: "DHL", rate: "0.50" }]),
      undefined,
    );
  });
});

describe("quoteLetterRate", () => {
  it("requests the letter package, 6x4 label and address verification", async () => {
    const { impl, calls } = stubFetch(jsonResponse(shipmentResponse()));
    const client = createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl });

    await client.quoteLetterRate({ to: TO, from: FROM, weightOz: 1 });

    const { shipment } = calls[0].body;
    assert.match(calls[0].url, /\/v2\/shipments$/);
    assert.equal(shipment.parcel.predefined_package, LETTER_PACKAGE);
    assert.equal(shipment.parcel.weight, 1);
    // 6x4, not the default 4x6 — different orientation, and 6x4 is what the
    // existing 6in x 4in print page expects.
    assert.equal(shipment.options.label_size, LETTER_LABEL_SIZE);
    assert.equal(shipment.options.label_format, "PNG");
    // Without this a bad address is only discovered after money has moved.
    assert.deepEqual(shipment.to_address.verify, ["delivery"]);
  });

  it("returns the letter rate in cents with shipment and rate ids", async () => {
    const { impl } = stubFetch(jsonResponse(shipmentResponse()));
    const quote = await createEasyPostClient({
      apiKey: "ek_test",
      fetchImpl: impl,
    }).quoteLetterRate({ to: TO, from: FROM, weightOz: 1 });

    assert.equal(quote.shipmentId, "shp_1");
    assert.equal(quote.rateId, "rate_letter");
    assert.equal(quote.amountCents, 78);
  });

  it("returns the USPS-corrected address including ZIP+4", async () => {
    const { impl } = stubFetch(jsonResponse(shipmentResponse()));
    const quote = await createEasyPostClient({
      apiKey: "ek_test",
      fetchImpl: impl,
    }).quoteLetterRate({ to: TO, from: FROM, weightOz: 1 });

    // The reason we use EasyPost verification rather than a separate USPS
    // Addresses API integration.
    assert.equal(quote.verifiedTo.postalCode, "06026-9998");
    assert.equal(quote.verifiedTo.line1, "118 N PINE RD");
  });

  it("throws before any purchase when the address fails verification", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        shipmentResponse({
          to_address: {
            street1: "118 Nowhere Rd",
            city: "East Granby",
            state: "CT",
            zip: "06026",
            verifications: {
              delivery: { success: false, errors: [{ message: "Address not found" }] },
            },
          },
        }),
      ),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      (err) => err.kind === "address" && /Address not found/.test(err.message),
    );
  });

  it("explains itself when no letter rate is available (e.g. overweight)", async () => {
    const { impl } = stubFetch(jsonResponse(shipmentResponse({ rates: [PARCEL_RATE] })));

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 14,
      }),
      (err) => err.kind === "no_rate" && /13oz/.test(err.message),
    );
  });

  it("maps 401 to a key problem, not a generic failure", async () => {
    const { impl } = stubFetch(jsonResponse({ error: { message: "unauthorized" } }, 401));

    await assert.rejects(
      createEasyPostClient({ apiKey: "bad", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      (err) => err.kind === "auth" && /API key/.test(err.message),
    );
  });

  it("maps a funding failure to something the seller can act on", async () => {
    const { impl } = stubFetch(
      jsonResponse({ error: { message: "Insufficient funds in account" } }, 402),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      (err) => err.kind === "payment",
    );
  });

  it("flattens EasyPost's nested error envelope into one message", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        {
          error: {
            message: "Unable to create shipment",
            errors: [{ field: "to_address.zip", message: "is required" }],
          },
        },
        422,
      ),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      /Unable to create shipment — to_address.zip: is required/,
    );
  });

  it("sends HTTP Basic auth with the key as username", async () => {
    const { impl, calls } = stubFetch(jsonResponse(shipmentResponse()));
    await createEasyPostClient({ apiKey: "ek_secret", fetchImpl: impl }).quoteLetterRate({
      to: TO,
      from: FROM,
      weightOz: 1,
    });

    assert.equal(
      calls[0].init.headers.Authorization,
      `Basic ${Buffer.from("ek_secret:").toString("base64")}`,
    );
  });
});

describe("buyLabel", () => {
  it("buys the quoted rate and returns tracking plus the label url", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({
        id: "shp_1",
        tracking_code: "9400100000000000000000",
        selected_rate: LETTER_RATE,
        postage_label: { label_url: "https://easypost-files.example/label.png" },
      }),
    );

    const bought = await createEasyPostClient({
      apiKey: "ek_test",
      fetchImpl: impl,
    }).buyLabel({ shipmentId: "shp_1", rateId: "rate_letter" });

    assert.match(calls[0].url, /\/v2\/shipments\/shp_1\/buy$/);
    assert.deepEqual(calls[0].body, { rate: { id: "rate_letter" } });
    assert.equal(bought.trackingCode, "9400100000000000000000");
    assert.equal(bought.labelUrl, "https://easypost-files.example/label.png");
    assert.equal(bought.amountCents, 78);
  });

  // Money may already have moved, so the message must not imply it hasn't.
  it("does not pretend nothing happened when the label is missing", async () => {
    const { impl } = stubFetch(jsonResponse({ id: "shp_1", tracking_code: "94001" }));

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).buyLabel({
        shipmentId: "shp_1",
        rateId: "rate_letter",
      }),
      /Check your EasyPost dashboard before buying again/,
    );
  });

  it("url-encodes the shipment id", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({
        id: "a/b",
        tracking_code: "x",
        selected_rate: LETTER_RATE,
        postage_label: { label_url: "u" },
      }),
    );
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).buyLabel({
      shipmentId: "a/b",
      rateId: "r",
    });
    assert.match(calls[0].url, /\/shipments\/a%2Fb\/buy$/);
  });
});

/**
 * NEO-213 — re-fetching a label for reprinting.
 *
 * The case that matters is the 180-day one: EasyPost keeps label images for
 * 180 days and then returns the shipment with a null `label_url`. That is a
 * 200 OK carrying nothing printable, so it has to be caught here or the seller
 * gets a print page pointed at `undefined`.
 */
describe("retrieveLabel", () => {
  const retrievedShipment = (over = {}) => ({
    id: "shp_1",
    tracking_code: "9400100000000000000000",
    postage_label: { label_url: "https://easypost-files.example/label.png" },
    ...over,
  });

  it("GETs the shipment and returns tracking plus the label url", async () => {
    const { impl, calls } = stubFetch(jsonResponse(retrievedShipment()));

    const label = await createEasyPostClient({
      apiKey: "ek_test",
      fetchImpl: impl,
    }).retrieveLabel({ shipmentId: "shp_1" });

    assert.match(calls[0].url, /\/v2\/shipments\/shp_1$/);
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(label, {
      shipmentId: "shp_1",
      trackingCode: "9400100000000000000000",
      labelUrl: "https://easypost-files.example/label.png",
    });
  });

  // A retrieve buys nothing, so it must not look like a write on the wire.
  it("sends no request body and no Content-Type", async () => {
    const { impl, calls } = stubFetch(jsonResponse(retrievedShipment()));
    await createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).retrieveLabel({
      shipmentId: "shp_1",
    });

    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
  });

  it("sends HTTP Basic auth with the key as username", async () => {
    const { impl, calls } = stubFetch(jsonResponse(retrievedShipment()));
    await createEasyPostClient({ apiKey: "ek_secret", fetchImpl: impl }).retrieveLabel({
      shipmentId: "shp_1",
    });

    assert.equal(
      calls[0].init.headers.Authorization,
      `Basic ${Buffer.from("ek_secret:").toString("base64")}`,
    );
  });

  it("url-encodes the shipment id", async () => {
    const { impl, calls } = stubFetch(jsonResponse(retrievedShipment({ id: "a/b" })));
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).retrieveLabel({
      shipmentId: "a/b",
    });
    assert.match(calls[0].url, /\/shipments\/a%2Fb$/);
  });

  // Past 180 days EasyPost still answers 200 — with no label.
  it("explains the 180-day retention when the label url is null", async () => {
    const { impl } = stubFetch(
      jsonResponse(retrievedShipment({ postage_label: { label_url: null } })),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).retrieveLabel({
        shipmentId: "shp_1",
      }),
      (err) => err.kind === "unknown" && /180 days/.test(err.message),
    );
  });

  it("explains itself when postage_label is missing entirely", async () => {
    const { impl } = stubFetch(
      jsonResponse({ id: "shp_1", tracking_code: "94001" }),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "ek_test", fetchImpl: impl }).retrieveLabel({
        shipmentId: "shp_1",
      }),
      (err) => err.kind === "unknown" && /180 days/.test(err.message),
    );
  });

  // The shared request helper's mappings must apply to GET too, not just POST.
  it("maps 401 to a key problem, not a generic failure", async () => {
    const { impl } = stubFetch(jsonResponse({ error: { message: "unauthorized" } }, 401));

    await assert.rejects(
      createEasyPostClient({ apiKey: "bad", fetchImpl: impl }).retrieveLabel({
        shipmentId: "shp_1",
      }),
      (err) => err.kind === "auth" && /API key/.test(err.message),
    );
  });

  it("reports a timeout as a timeout", async () => {
    const impl = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).retrieveLabel({
        shipmentId: "shp_1",
      }),
      (err) => err.kind === "timeout",
    );
  });
});

describe("transport failures", () => {
  it("reports a timeout as a timeout", async () => {
    const impl = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      (err) => err.kind === "timeout",
    );
  });

  it("survives a non-JSON error body", async () => {
    const impl = async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>bad gateway</html>",
    });
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).quoteLetterRate({
        to: TO,
        from: FROM,
        weightOz: 1,
      }),
      /HTTP 502/,
    );
  });
});

// ---------------------------------------------------------------------------
// NEO-121 — scan visibility
//
// The tracker fixture below is a REAL production letter (a NEO-120 purchase,
// Madison WI -> Olympia WA), not an invention: 31-digit IMb tracking code,
// four scans over three days, terminal status `out_for_delivery` — which for a
// letter is the finish line, because no scan ever confirms the mailbox — and
// `tracking_location` fields that come back null. Every one of those is a
// property a made-up fixture would have got wrong.
// ---------------------------------------------------------------------------

const LETTER_TRACKER = {
  id: "trk_92253672884048",
  object: "Tracker",
  tracking_code: "0004012345678901234567890123456",
  status: "out_for_delivery",
  status_detail: "out_for_delivery",
  created_at: "2026-08-25T17:00:00Z",
  updated_at: "2026-08-29T00:06:00Z",
  est_delivery_date: "2026-08-28T00:00:00Z",
  shipment_id: "shp_letter",
  carrier: "USPS",
  public_url: "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
  tracking_details: [
    {
      message: "Origin Processing Cancellation of Postage",
      status: "in_transit",
      datetime: "2026-08-25T17:52:00Z",
      tracking_location: { city: "MADISON", state: "WI", zip: "53714", country: null },
    },
    {
      message: "Origin Primary Processing",
      status: "in_transit",
      datetime: "2026-08-26T04:53:00Z",
      tracking_location: { city: "MILWAUKEE", state: "WI", zip: null, country: null },
    },
    {
      message: "Destination MMP Processing",
      status: "in_transit",
      datetime: "2026-08-27T22:22:00Z",
      tracking_location: { city: "TACOMA", state: "WA", zip: null, country: null },
    },
    {
      message: "Delivery",
      status: "out_for_delivery",
      datetime: "2026-08-29T00:06:00Z",
      tracking_location: { city: null, state: null, zip: null, country: null },
    },
  ],
};

const ms = (iso) => Date.parse(iso);

describe("normalizeTracker", () => {
  it("normalises a real USPS letter tracker", () => {
    const snap = normalizeTracker(LETTER_TRACKER);

    assert.equal(snap.trackerId, "trk_92253672884048");
    assert.equal(snap.status, "out_for_delivery");
    assert.equal(snap.statusDetail, "out_for_delivery");
    assert.equal(snap.updatedAt, ms("2026-08-29T00:06:00Z"));
    assert.equal(snap.estDeliveryAt, ms("2026-08-28T00:00:00Z"));
    assert.equal(snap.scans.length, 4);
  });

  // ISO strings are parsed HERE, once, for the same reason money is converted
  // here: a timestamp that crosses the boundary as text gets re-parsed
  // differently by every consumer that touches it.
  it("parses every timestamp to ms at the boundary", () => {
    const snap = normalizeTracker(LETTER_TRACKER);
    for (const scan of snap.scans) {
      assert.equal(typeof scan.at, "number");
      assert.ok(Number.isFinite(scan.at));
    }
    assert.equal(typeof snap.updatedAt, "number");
    assert.equal(typeof snap.estDeliveryAt, "number");
  });

  it("orders scans oldest to newest and reports the newest as lastScanAt", () => {
    const snap = normalizeTracker(LETTER_TRACKER);
    assert.equal(snap.scans[0].message, "Origin Processing Cancellation of Postage");
    assert.equal(snap.scans[3].message, "Delivery");
    assert.equal(snap.lastScanAt, ms("2026-08-29T00:06:00Z"));
    assert.equal(snap.lastScanAt, snap.scans[snap.scans.length - 1].at);
  });

  it("sorts an out-of-order tracking_details list rather than trusting it", () => {
    const shuffled = {
      ...LETTER_TRACKER,
      tracking_details: [...LETTER_TRACKER.tracking_details].reverse(),
    };
    const snap = normalizeTracker(shuffled);
    assert.equal(snap.scans[0].message, "Origin Processing Cancellation of Postage");
    assert.equal(snap.lastScanAt, ms("2026-08-29T00:06:00Z"));
  });

  // Real letter trackers return null city/state/zip/country on the final scan.
  // Emitting those as the string "null" is how a UI ends up rendering
  // "Delivery · null, null".
  it("drops null tracking_location fields instead of emitting them", () => {
    const snap = normalizeTracker(LETTER_TRACKER);

    const delivery = snap.scans[3];
    assert.equal(delivery.city, undefined);
    assert.equal(delivery.state, undefined);
    assert.equal(delivery.zip, undefined);
    assert.equal(delivery.country, undefined);

    // ...while a scan that DOES carry a location keeps it.
    assert.equal(snap.scans[0].city, "MADISON");
    assert.equal(snap.scans[0].state, "WI");
    assert.equal(snap.scans[0].zip, "53714");
    assert.equal(snap.scans[1].zip, undefined);
  });

  it("survives a tracker with no tracking_details at all", () => {
    const snap = normalizeTracker({ id: "trk_new", status: "pre_transit", updated_at: "2026-08-25T17:00:00Z" });
    assert.deepEqual(snap.scans, []);
    assert.equal(snap.lastScanAt, undefined);
    assert.equal(snap.estDeliveryAt, undefined);
    assert.equal(snap.publicTrackingUrl, undefined);
    assert.equal(snap.status, "pre_transit");
  });

  it("defaults a missing status to unknown rather than undefined", () => {
    assert.equal(normalizeTracker({ id: "trk_x" }).status, "unknown");
    assert.equal(normalizeTracker({}).trackerId, "");
  });

  // `at` drives relative-time rendering. A scan kept with at: 0 renders as
  // "56 years ago", which is worse than one missing line.
  it("drops a scan whose datetime will not parse", () => {
    const snap = normalizeTracker({
      ...LETTER_TRACKER,
      tracking_details: [
        ...LETTER_TRACKER.tracking_details,
        { message: "Bogus", status: "in_transit", datetime: "not a date" },
        { message: "Also bogus", status: "in_transit", datetime: null },
      ],
    });
    assert.equal(snap.scans.length, 4);
    assert.equal(snap.scans.some((s) => s.message === "Bogus"), false);
  });

  it(`caps scans at ${MAX_SCANS}, keeping the newest`, () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      message: `scan ${i}`,
      status: "in_transit",
      datetime: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    }));
    const snap = normalizeTracker({ ...LETTER_TRACKER, tracking_details: many });

    assert.equal(snap.scans.length, MAX_SCANS);
    // Newest kept, oldest dropped.
    assert.equal(snap.scans[MAX_SCANS - 1].message, "scan 119");
    assert.equal(snap.scans[0].message, `scan ${120 - MAX_SCANS}`);
    assert.equal(snap.lastScanAt, snap.scans[MAX_SCANS - 1].at);
  });

  // Strings stay whole here: Convex owns the document-size budget and does the
  // truncating on the write. This pins that this layer is not also doing it,
  // so the two cannot disagree about the limit.
  it("does not truncate strings — Convex does that on the write", () => {
    const long = "x".repeat(1000);
    const snap = normalizeTracker({
      ...LETTER_TRACKER,
      tracking_details: [
        { message: long, status: "in_transit", datetime: "2026-08-25T17:52:00Z" },
      ],
    });
    assert.equal(snap.scans[0].message.length, 1000);
  });

  for (const [label, url] of [
    ["http", "http://track.easypost.com/x"],
    ["javascript:", "javascript:alert(1)"],
    ["a data uri", "data:text/html,<script>"],
    ["a protocol-relative url", "//track.easypost.com/x"],
    ["a non-string", 42],
    ["null", null],
  ]) {
    it(`drops a public_url that is ${label}`, () => {
      const snap = normalizeTracker({ ...LETTER_TRACKER, public_url: url });
      assert.equal(snap.publicTrackingUrl, undefined);
    });
  }

  it("keeps an https public_url", () => {
    assert.equal(
      normalizeTracker(LETTER_TRACKER).publicTrackingUrl,
      "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
    );
  });

  // Never Date.now(): Convex applies a snapshot only when updatedAt beats the
  // stored one, so an invented "now" would let an undated payload overwrite a
  // good snapshot. Falling back to the newest scan, then 0, fails closed.
  it("falls back to the newest scan, then 0, when updated_at is missing", () => {
    const noUpdatedAt = { ...LETTER_TRACKER };
    delete noUpdatedAt.updated_at;
    assert.equal(normalizeTracker(noUpdatedAt).updatedAt, ms("2026-08-29T00:06:00Z"));

    assert.equal(normalizeTracker({ id: "trk_x", status: "unknown" }).updatedAt, 0);
  });
});

describe("redactWebhookToken", () => {
  // The webhook URL carries a bearer token in its path, and EasyPost quotes
  // the URL it rejected back inside its own error text. Unredacted, that error
  // is a credential in a log line and in a JSON body.
  it("replaces the token segment of a webhook url", () => {
    assert.equal(
      redactWebhookToken(
        "Webhook URL https://acme-123.convex.site/webhooks/easypost/Ab3xTOKENxYz is invalid",
      ),
      "Webhook URL https://acme-123.convex.site/webhooks/easypost/<token> is invalid",
    );
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redactWebhookToken(
      "a https://x.convex.site/webhooks/easypost/AAA b https://y.convex.site/webhooks/easypost/BBB",
    );
    assert.equal(out.includes("AAA"), false);
    assert.equal(out.includes("BBB"), false);
    assert.equal(out.match(/<token>/g).length, 2);
  });

  it("leaves a message with no webhook url alone", () => {
    assert.equal(redactWebhookToken("Address not found"), "Address not found");
    assert.equal(redactWebhookToken(""), "");
  });
});

describe("retrieveTracker", () => {
  it("GETs the shipment and normalises shipment.tracker", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ id: "shp_letter", tracker: LETTER_TRACKER }),
    );

    const snap = await createEasyPostClient({
      apiKey: "ek_test",
      fetchImpl: impl,
    }).retrieveTracker({ shipmentId: "shp_letter" });

    assert.match(calls[0].url, /\/v2\/shipments\/shp_letter$/);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(snap.trackerId, "trk_92253672884048");
    assert.equal(snap.status, "out_for_delivery");
    assert.equal(snap.scans.length, 4);
  });

  it("url-encodes the shipment id", async () => {
    const { impl, calls } = stubFetch(jsonResponse({ tracker: LETTER_TRACKER }));
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).retrieveTracker({
      shipmentId: "a/b",
    });
    assert.match(calls[0].url, /\/shipments\/a%2Fb$/);
  });

  // "No tracker yet" is the ordinary state for the first hours of a letter's
  // life. Reporting it as `unknown` would tell a seller something is broken.
  for (const [label, shipment] of [
    ["tracker is null", { id: "shp_1", tracker: null }],
    ["tracker is absent", { id: "shp_1" }],
    ["the shipment body is empty", {}],
  ]) {
    it(`raises no_tracker when ${label}`, async () => {
      const { impl } = stubFetch(jsonResponse(shipment));
      await assert.rejects(
        createEasyPostClient({ apiKey: "k", fetchImpl: impl }).retrieveTracker({
          shipmentId: "shp_1",
        }),
        (err) =>
          err.kind === "no_tracker" &&
          // Seller-readable: says what is happening, not what failed.
          /scan/i.test(err.message) &&
          !/error|failed/i.test(err.message),
      );
    });
  }

  it("still maps 401 to a key problem", async () => {
    const { impl } = stubFetch(jsonResponse({ error: { message: "unauthorized" } }, 401));
    await assert.rejects(
      createEasyPostClient({ apiKey: "bad", fetchImpl: impl }).retrieveTracker({
        shipmentId: "shp_1",
      }),
      (err) => err.kind === "auth",
    );
  });
});

describe("buyLabel tracker passthrough", () => {
  const boughtBody = (over = {}) => ({
    id: "shp_letter",
    tracking_code: "0004012345678901234567890123456",
    selected_rate: LETTER_RATE,
    postage_label: { label_url: "https://easypost-files.example/label.png" },
    ...over,
  });

  it("returns the inline tracker when the buy response carries one", async () => {
    const { impl } = stubFetch(jsonResponse(boughtBody({ tracker: LETTER_TRACKER })));
    const bought = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).buyLabel({ shipmentId: "shp_letter", rateId: "rate_letter" });

    assert.equal(bought.tracker.trackerId, "trk_92253672884048");
    assert.equal(bought.tracker.status, "out_for_delivery");
    // The purchase fields are untouched by the addition.
    assert.equal(bought.amountCents, 78);
    assert.equal(bought.trackingCode, "0004012345678901234567890123456");
  });

  // Additive: a shipment bought before USPS produced a tracker is normal.
  it("omits tracker entirely when the buy response has none", async () => {
    const { impl } = stubFetch(jsonResponse(boughtBody()));
    const bought = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).buyLabel({ shipmentId: "shp_letter", rateId: "rate_letter" });

    assert.equal("tracker" in bought, false);
    assert.equal(bought.labelUrl, "https://easypost-files.example/label.png");
  });

  it("omits tracker when the buy response carries a null one", async () => {
    const { impl } = stubFetch(jsonResponse(boughtBody({ tracker: null })));
    const bought = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).buyLabel({ shipmentId: "shp_letter", rateId: "rate_letter" });
    assert.equal("tracker" in bought, false);
  });
});

describe("listWebhooks", () => {
  it("GETs /webhooks and normalises the envelope", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({
        webhooks: [
          {
            id: "hook_abc123",
            url: "https://acme.convex.site/webhooks/easypost/TOKENAAA",
            mode: "production",
            disabled_at: null,
          },
          {
            id: "hook_def456",
            url: "https://old.convex.site/webhooks/easypost/TOKENBBB",
            mode: "test",
            disabled_at: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    );

    const hooks = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).listWebhooks();

    assert.match(calls[0].url, /\/v2\/webhooks$/);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
    assert.deepEqual(hooks[0], {
      webhookId: "hook_abc123",
      url: "https://acme.convex.site/webhooks/easypost/TOKENAAA",
      mode: "production",
      disabledAt: null,
    });
    // disabled_at becomes ms, like every other timestamp on this boundary.
    assert.equal(hooks[1].disabledAt, ms("2026-08-01T00:00:00Z"));
  });

  it("returns an empty list for an account with no webhooks", async () => {
    const { impl } = stubFetch(jsonResponse({ webhooks: [] }));
    assert.deepEqual(
      await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).listWebhooks(),
      [],
    );
  });

  it("tolerates a bare array body", async () => {
    const { impl } = stubFetch(jsonResponse([{ id: "hook_a", url: "https://x.convex.site/y", mode: "test" }]));
    const hooks = await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).listWebhooks();
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].webhookId, "hook_a");
    assert.equal(hooks[0].disabledAt, null);
  });
});

describe("createWebhook", () => {
  const CONVEX_URL = "https://acme-123.convex.site/webhooks/easypost/Ab3xTOKENxYz";
  const SECRET = "s".repeat(43);

  it("POSTs the EasyPost v2 body shape: {webhook: {url, webhook_secret}}", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({ id: "hook_abc123", mode: "production", url: CONVEX_URL }),
    );

    const created = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).createWebhook({ url: CONVEX_URL, secret: SECRET });

    assert.match(calls[0].url, /\/v2\/webhooks$/);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].body, {
      webhook: { url: CONVEX_URL, webhook_secret: SECRET },
    });
    assert.deepEqual(created, { webhookId: "hook_abc123", mode: "production" });
  });

  // The secret is write-only: it goes out in the body and nothing derived from
  // it comes back.
  it("never returns the secret", async () => {
    const { impl } = stubFetch(jsonResponse({ id: "hook_abc123", mode: "test" }));
    const created = await createEasyPostClient({
      apiKey: "k",
      fetchImpl: impl,
    }).createWebhook({ url: CONVEX_URL, secret: SECRET });
    assert.equal(JSON.stringify(created).includes(SECRET), false);
  });

  // Registering a plaintext endpoint would put the seller's scan events AND
  // the bearer token in the URL on the wire in the clear.
  for (const badUrl of [
    "http://acme.convex.site/webhooks/easypost/TOKEN",
    "ftp://acme.convex.site/x",
    "//acme.convex.site/x",
    "acme.convex.site/x",
  ]) {
    it(`refuses ${badUrl} before calling out`, async () => {
      const { impl, calls } = stubFetch();
      await assert.rejects(
        createEasyPostClient({ apiKey: "k", fetchImpl: impl }).createWebhook({
          url: badUrl,
          secret: SECRET,
        }),
        (err) => err.kind === "invalid_input" && /https/.test(err.message),
      );
      // Nothing was sent — the seller's key was never spent on this.
      assert.equal(calls.length, 0);
    });
  }

  // The rejected URL contains the bearer token, so it is never quoted back.
  it("does not echo the rejected url into the error message", async () => {
    const { impl } = stubFetch();
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).createWebhook({
        url: "http://acme.convex.site/webhooks/easypost/Ab3xTOKENxYz",
        secret: SECRET,
      }),
      (err) => !err.message.includes("Ab3xTOKENxYz"),
    );
  });

  // EasyPost quotes the URL it rejected. That URL is a credential.
  it("redacts the token out of an EasyPost rejection message", async () => {
    const { impl } = stubFetch(
      jsonResponse(
        {
          error: {
            message: `Webhook URL ${CONVEX_URL} could not be verified`,
            errors: [{ field: "url", message: `${CONVEX_URL} did not respond` }],
          },
        },
        422,
      ),
    );

    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).createWebhook({
        url: CONVEX_URL,
        secret: SECRET,
      }),
      (err) =>
        !err.message.includes("Ab3xTOKENxYz") &&
        err.message.includes("/webhooks/easypost/<token>") &&
        // The useful half of the message survives redaction.
        /could not be verified/.test(err.message),
    );
  });

  it("raises rather than returning a webhook with no id", async () => {
    const { impl } = stubFetch(jsonResponse({ mode: "test" }));
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).createWebhook({
        url: CONVEX_URL,
        secret: SECRET,
      }),
      (err) => err.kind === "unknown" && /webhook id/.test(err.message),
    );
  });
});

describe("deleteWebhook", () => {
  it("DELETEs the webhook with no body and no Content-Type", async () => {
    const { impl, calls } = stubFetch(jsonResponse({ id: "hook_abc123" }));
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
      webhookId: "hook_abc123",
    });

    assert.match(calls[0].url, /\/v2\/webhooks\/hook_abc123$/);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
    assert.equal(
      calls[0].init.headers.Authorization,
      `Basic ${Buffer.from("k:").toString("base64")}`,
    );
  });

  it("url-encodes the webhook id", async () => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
      webhookId: "a/b",
    });
    assert.match(calls[0].url, /\/webhooks\/a%2Fb$/);
  });

  // THE case this method exists to get right. A hook that is already gone is a
  // completed delete, and that is decided here from the upstream status — so
  // the router's own 404 ("no EasyPost key saved") is never confused with it.
  it("treats EasyPost's own 404 as success", async () => {
    const { impl } = stubFetch(
      jsonResponse({ error: { message: "The requested resource could not be found." } }, 404),
    );
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
      webhookId: "hook_gone",
    });
  });

  it("survives a 404 with an empty body", async () => {
    const { impl } = stubFetch({ ok: false, status: 404, text: async () => "" });
    await createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
      webhookId: "hook_gone",
    });
  });

  // 404 is the ONLY status forgiven. Everything else still maps as usual, so
  // an unconfirmed delete stays unconfirmed and Convex keeps the row.
  it("still raises on 401", async () => {
    const { impl } = stubFetch(jsonResponse({ error: { message: "unauthorized" } }, 401));
    await assert.rejects(
      createEasyPostClient({ apiKey: "bad", fetchImpl: impl }).deleteWebhook({
        webhookId: "hook_abc123",
      }),
      (err) => err.kind === "auth",
    );
  });

  it("still raises on 500", async () => {
    const { impl } = stubFetch(jsonResponse({ error: { message: "boom" } }, 500));
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
        webhookId: "hook_abc123",
      }),
      (err) => err.kind === "unknown",
    );
  });

  it("still raises on a timeout", async () => {
    const impl = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    await assert.rejects(
      createEasyPostClient({ apiKey: "k", fetchImpl: impl }).deleteWebhook({
        webhookId: "hook_abc123",
      }),
      (err) => err.kind === "timeout",
    );
  });
});
