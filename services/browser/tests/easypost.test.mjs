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
