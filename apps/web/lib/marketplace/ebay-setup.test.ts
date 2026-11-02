import { describe, expect, it } from "vitest";
import {
  hiddenFrom20Plus,
  isZip,
  needsStandardPolicies,
  over20Options,
  paymentOptions,
  returnOptions,
  setupChecklist,
  SETUP_STEPS,
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

  it("pickers pass a policy's summary through and leave the description off when it has none", () => {
    const policies: EbayPolicies = {
      fulfillment: [
        { id: "a", name: "A", eseFit: true, eseOnly: false, freeShipping: false, summary: "Standard Envelope $1.00" },
        { id: "b", name: "B", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
        { id: "c", name: "C", eseFit: true, eseOnly: false, freeShipping: false, summary: "" },
      ],
      payment: [{ id: "p", name: "Pay" }],
      returns: [
        { id: "r1", name: "R1", summary: "30 days, buyer pays return shipping" },
        { id: "r2", name: "R2", summary: "" },
      ],
    };
    expect(under20Options(policies).map((o) => o.description)).toEqual([
      "Takes Standard Envelope. Standard Envelope $1.00",
      undefined,
      "Takes Standard Envelope.",
    ]);
    expect(over20Options(policies).map((o) => o.description)).toEqual(["Standard Envelope $1.00", undefined, undefined]);
    expect(paymentOptions(policies)).toEqual([{ value: "p", label: "Pay" }]);
    expect(returnOptions(policies).map((o) => [o.value, o.description])).toEqual([
      ["r1", "30 days, buyer pays return shipping"],
      ["r2", undefined],
    ]);
  });

  it("an account with no policies offers empty pickers and always needs Set me up", () => {
    const none: EbayPolicies = { fulfillment: [], payment: [], returns: [] };
    expect(under20Options(none)).toEqual([]);
    expect(over20Options(none)).toEqual([]);
    expect(hiddenFrom20Plus(none)).toBe(0);
    expect(needsStandardPolicies(none)).toBe(true);
    expect(standardPicks(EMPTY, none, CREATED)).toEqual({});
  });

  it("$20 and up falls back to the free-shipping policy when the tracked one is the only choice left, never to a Standard Envelope-only one", () => {
    const onlyFree: EbayPolicies = {
      ...MADE,
      fulfillment: MADE.fulfillment.filter((p) => p.id === "ese" || p.id === "free"),
    };
    expect(standardPicks(EMPTY, onlyFree, CREATED).fulfillmentPolicy20PlusId).toBe("free");
    const onlyEse: EbayPolicies = { ...MADE, fulfillment: MADE.fulfillment.filter((p) => p.id === "ese") };
    expect(standardPicks(EMPTY, onlyEse, CREATED).fulfillmentPolicy20PlusId).toBeUndefined();
  });

  it("with several payment or return policies and none made, those slots stay for the collector", () => {
    const several: EbayPolicies = {
      ...MADE,
      payment: [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }],
      returns: [{ id: "r1", name: "One", summary: "" }, { id: "r2", name: "Two", summary: "" }],
    };
    const picks = standardPicks(EMPTY, several, ["NB Standard Envelope (under $20)"]);
    expect(picks.paymentPolicyId).toBeUndefined();
    expect(picks.returnPolicyId).toBeUndefined();
  });

  it("the checklist has a step for every setup gap the server can name, and an empty missing list is all done", () => {
    expect(SETUP_STEPS.map((s) => s.gap)).toEqual(["shippingUnder20", "shipping20Plus", "payment", "returns", "location"]);
    expect(setupChecklist([]).every((s) => s.done)).toBe(true);
    expect(setupChecklist(SETUP_STEPS.map((s) => s.gap)).every((s) => !s.done)).toBe(true);
  });

  it("a ZIP with surrounding spaces still counts, and ZIP+4 needs its dash", () => {
    expect(isZip("  53703  ")).toBe(true);
    expect(isZip("537031234")).toBe(false);
    expect(isZip("")).toBe(false);
  });
});
