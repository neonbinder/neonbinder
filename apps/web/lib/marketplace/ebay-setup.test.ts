import { describe, expect, it } from "vitest";
import {
  hiddenFrom20Plus,
  isZip,
  needsStandardPolicies,
  over20Options,
  setupChecklist,
  standardPicks,
  under20Options,
  type EbayPolicies,
  type EbaySettings,
} from "./ebay-setup";

const EMPTY: EbaySettings = {
  fulfillmentPolicyUnder20Id: null,
  fulfillmentPolicy20PlusId: null,
  paymentPolicyId: null,
  returnPolicyId: null,
  location: null,
  bestOffer: true,
};

const MADE: EbayPolicies = {
  fulfillment: [
    { id: "ese", name: "NB Standard Envelope (under $20)", eseFit: true, eseOnly: true, freeShipping: false, summary: "" },
    { id: "free", name: "NB Free Shipping", eseFit: false, eseOnly: false, freeShipping: true, summary: "" },
    { id: "trk", name: "NB Tracked (USPS Ground Advantage)", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
    { id: "mine", name: "My old policy", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
  ],
  payment: [{ id: "pay", name: "NB Payment" }],
  returns: [
    { id: "ret-old", name: "Old returns", summary: "" },
    { id: "ret", name: "NB Returns", summary: "" },
  ],
};
const CREATED = ["NB Standard Envelope (under $20)", "NB Tracked (USPS Ground Advantage)", "NB Free Shipping", "NB Payment", "NB Returns"];

describe("eBay setup helpers (NEO-415)", () => {
  it("$20 and up never offers a Standard Envelope-only policy", () => {
    expect(over20Options(MADE).map((o) => o.value)).toEqual(["free", "trk", "mine"]);
    expect(hiddenFrom20Plus(MADE)).toBe(1);
    expect(under20Options(MADE)[0].description).toBe("Takes Standard Envelope.");
  });

  it("Set me up is offered only when a slot has nothing that fits", () => {
    expect(needsStandardPolicies(MADE)).toBe(false);
    expect(needsStandardPolicies({ ...MADE, payment: [] })).toBe(true);
    expect(needsStandardPolicies({ ...MADE, fulfillment: MADE.fulfillment.filter((p) => !p.eseFit) })).toBe(true);
    expect(needsStandardPolicies({ ...MADE, fulfillment: MADE.fulfillment.filter((p) => p.eseOnly) })).toBe(true);
  });

  it("after Set me up, empty slots take what it made: tracked (not free) for $20 and up", () => {
    expect(standardPicks(EMPTY, MADE, CREATED)).toEqual({
      fulfillmentPolicyUnder20Id: "ese",
      fulfillmentPolicy20PlusId: "trk",
      paymentPolicyId: "pay",
      returnPolicyId: "ret",
    });
  });

  it("never changes a slot already picked, and never picks a policy it didn't make", () => {
    const settings = { ...EMPTY, fulfillmentPolicy20PlusId: "mine", returnPolicyId: "ret-old" };
    expect(standardPicks(settings, MADE, ["NB Standard Envelope (under $20)"])).toEqual({
      fulfillmentPolicyUnder20Id: "ese",
      // The only payment policy there is.
      paymentPolicyId: "pay",
    });
  });

  it("the checklist ticks off what isn't missing, in the page's order", () => {
    expect(setupChecklist(["payment", "location"]).map((s) => [s.gap, s.done])).toEqual([
      ["shippingUnder20", true],
      ["shipping20Plus", true],
      ["payment", false],
      ["returns", true],
      ["location", false],
    ]);
  });

  it("a ZIP is five digits, or ZIP+4", () => {
    expect(isZip("53703")).toBe(true);
    expect(isZip(" 53703-1234 ")).toBe(true);
    expect(isZip("5370")).toBe(false);
    expect(isZip("WI 53703")).toBe(false);
  });
});
