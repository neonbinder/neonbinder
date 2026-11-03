import { describe, expect, it } from "vitest";
import {
  hiddenFrom20Plus,
  isZip,
  over20Options,
  paymentOptions,
  returnOptions,
  setupChecklist,
  setupLandedLine,
  setupStepName,
  shownSetupStatus,
  SETUP_STEPS,
  standardPicks,
  under20Options,
  type EbayPolicies,
  type EbaySettings,
  type EbaySetupStep,
  type EbaySetupStepStatus,
} from "./ebay-setup";

const EMPTY: EbaySettings = {
  fulfillmentPolicyUnder20Id: null,
  fulfillmentPolicy20PlusId: null,
  paymentPolicyId: null,
  returnPolicyId: null,
  location: null,
  bestOffer: true,
};

/** The account after Set me up: the seller's own shipping policies, and the payment and returns NB made. */
const MADE: EbayPolicies = {
  fulfillment: [
    { id: "ese", name: "My envelope", eseFit: true, eseOnly: true, freeShipping: false, summary: "" },
    { id: "free", name: "My free shipping", eseFit: false, eseOnly: false, freeShipping: true, summary: "" },
    { id: "trk", name: "My tracked", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
    { id: "mine", name: "My old policy", eseFit: false, eseOnly: false, freeShipping: false, summary: "" },
  ],
  payment: [{ id: "pay", name: "NB Payment" }],
  returns: [
    { id: "ret-old", name: "Old returns", summary: "" },
    { id: "ret", name: "NB Returns", summary: "" },
  ],
};
const CREATED = ["NB Payment", "NB Returns"];

describe("eBay setup helpers (NEO-415)", () => {
  it("$20 and up never offers a Standard Envelope-only policy", () => {
    expect(over20Options(MADE).map((o) => o.value)).toEqual(["free", "trk", "mine"]);
    expect(hiddenFrom20Plus(MADE)).toBe(1);
    expect(under20Options(MADE)[0].description).toBe("Takes Standard Envelope.");
  });

  it("after Set me up, the empty payment and returns slots take what it made; shipping is never picked for the collector", () => {
    expect(standardPicks(EMPTY, MADE, CREATED)).toEqual({ paymentPolicyId: "pay", returnPolicyId: "ret" });
    // Even a shipping policy whose name Set me up reported is never picked (NB makes none, NEO-423).
    const picks = standardPicks(EMPTY, MADE, [...CREATED, "My envelope", "My tracked"]);
    expect(picks).not.toHaveProperty("fulfillmentPolicyUnder20Id");
    expect(picks).not.toHaveProperty("fulfillmentPolicy20PlusId");
  });

  it("never changes a slot already picked, and never picks a policy it didn't make", () => {
    const settings = { ...EMPTY, returnPolicyId: "ret-old" };
    expect(standardPicks(settings, MADE, [])).toEqual({
      // The only payment policy there is.
      paymentPolicyId: "pay",
    });
  });

  it("the checklist ticks off what isn't missing, in the page's order", () => {
    expect(setupChecklist(["payment", "location"]).map((s) => [s.gap, s.done])).toEqual([
      ["location", false],
      ["shippingUnder20", true],
      ["shipping20Plus", true],
      ["payment", false],
      ["returns", true],
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
        { id: "d", name: "D", eseFit: true, eseOnly: false, freeShipping: false, summary: "USPS Ground Advantage $4.50" },
        { id: "e", name: "E", eseFit: true, eseOnly: true, freeShipping: false, summary: "eBay standard envelope, free" },
      ],
      payment: [{ id: "p", name: "Pay" }],
      returns: [
        { id: "r1", name: "R1", summary: "30 days, buyer pays return shipping" },
        { id: "r2", name: "R2", summary: "" },
      ],
    };
    // Standard Envelope is said once: the prefix only where the summary doesn't already name it.
    expect(under20Options(policies).map((o) => o.description)).toEqual([
      "Standard Envelope $1.00",
      undefined,
      "Takes Standard Envelope.",
      "Takes Standard Envelope. USPS Ground Advantage $4.50",
      "eBay standard envelope, free",
    ]);
    expect(over20Options(policies).map((o) => o.description)).toEqual([
      "Standard Envelope $1.00",
      undefined,
      undefined,
      "USPS Ground Advantage $4.50",
    ]);
    expect(paymentOptions(policies)).toEqual([{ value: "p", label: "Pay" }]);
    expect(returnOptions(policies).map((o) => [o.value, o.description])).toEqual([
      ["r1", "30 days, buyer pays return shipping"],
      ["r2", undefined],
    ]);
  });

  it("an account with no policies offers empty pickers and picks nothing", () => {
    const none: EbayPolicies = { fulfillment: [], payment: [], returns: [] };
    expect(under20Options(none)).toEqual([]);
    expect(over20Options(none)).toEqual([]);
    expect(hiddenFrom20Plus(none)).toBe(0);
    expect(standardPicks(EMPTY, none, CREATED)).toEqual({});
  });

  it("with several payment or return policies and none made, those slots stay for the collector", () => {
    const several: EbayPolicies = {
      ...MADE,
      payment: [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }],
      returns: [{ id: "r1", name: "One", summary: "" }, { id: "r2", name: "Two", summary: "" }],
    };
    const picks = standardPicks(EMPTY, several, []);
    expect(picks.paymentPolicyId).toBeUndefined();
    expect(picks.returnPolicyId).toBeUndefined();
  });

  it("the checklist has a step for every setup gap the server can name, and an empty missing list is all done", () => {
    expect(SETUP_STEPS.map((s) => s.gap)).toEqual(["location", "shippingUnder20", "shipping20Plus", "payment", "returns"]);
    expect(setupChecklist([]).every((s) => s.done)).toBe(true);
    expect(setupChecklist(SETUP_STEPS.map((s) => s.gap)).every((s) => !s.done)).toBe(true);
  });

  it("a ZIP with surrounding spaces still counts, and ZIP+4 needs its dash", () => {
    expect(isZip("  53703  ")).toBe(true);
    expect(isZip("537031234")).toBe(false);
    expect(isZip("")).toBe(false);
  });
});

describe("Set me up's ledger words", () => {
  const LABEL = { check: "Check your eBay account", payment: "NB Payment", returns: "NB Returns (30 days)" } as const;
  const steps = (statuses: Partial<Record<keyof typeof LABEL, EbaySetupStepStatus>>): EbaySetupStep[] =>
    (Object.keys(statuses) as Array<keyof typeof LABEL>).map((step) => ({ step, label: LABEL[step], status: statuses[step]! }));

  it("names a step by its label and state, in words", () => {
    expect(setupStepName("NB Payment", "done")).toBe("NB Payment, done");
    expect(setupStepName("NB Returns (30 days)", "failed")).toBe("NB Returns (30 days), eBay said no");
    expect(setupStepName("NB Payment", "had")).toBe("NB Payment, already on eBay");
    expect(setupStepName("NB Payment", "stopped")).toBe("NB Payment, not made");
  });

  it("the account check landing says how many are to make, or that there's nothing to make", () => {
    expect(setupLandedLine(steps({ check: "working" }), steps({ check: "done", payment: "working", returns: "waiting" }))).toBe(
      "Checked your eBay account. 2 to make.",
    );
    expect(setupLandedLine(steps({ check: "working" }), steps({ check: "done" }))).toBe("Checked your eBay account. You've got them all.");
  });

  it("a made policy counts what's made of what's to make; nothing landed says nothing", () => {
    const before = steps({ check: "done", payment: "working", returns: "waiting" });
    const after = steps({ check: "done", payment: "done", returns: "working" });
    expect(setupLandedLine(before, after)).toBe("Made NB Payment. 1 of 2 made.");
    expect(setupLandedLine(after, after)).toBe("");
  });

  it("a snag outranks a check mark landing in the same read", () => {
    const before = steps({ check: "done", payment: "working", returns: "waiting" });
    const after = steps({ check: "done", payment: "done", returns: "failed" });
    expect(setupLandedLine(before, after)).toBe("eBay said no to NB Returns (30 days).");
  });

  it("a failed account check says nothing (the error alert does)", () => {
    expect(setupLandedLine(steps({ check: "working" }), steps({ check: "failed" }))).toBe("");
  });

  it("once the press is over, a step left working reads failed and one left waiting reads not made", () => {
    expect(shownSetupStatus("working", true)).toBe("working");
    expect(shownSetupStatus("waiting", true)).toBe("waiting");
    expect(shownSetupStatus("working", false)).toBe("failed");
    expect(shownSetupStatus("waiting", false)).toBe("stopped");
    expect(shownSetupStatus("done", false)).toBe("done");
    expect(shownSetupStatus("had", false)).toBe("had");
  });
});
