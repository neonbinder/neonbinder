import { describe, expect, it } from "vitest";
import { DemoRefusal, demoOps, initialCollectionState } from "./store";
import { priceText } from "./CardDetail";
import type { Copy } from "./data/types";

/** NEO-378 — the demo's common prices, and how a line reads its floor. */
describe("demoOps.setCommonPrice", () => {
  it("sets, changes and clears a variant's price, each time handing back the one it replaced", () => {
    let state = initialCollectionState();
    let r = demoOps.setCommonPrice(state, "v1", 0.25);
    expect(r.result).toBeNull();
    state = r.state;
    expect(state.commonPrices).toEqual({ v1: 0.25 });
    r = demoOps.setCommonPrice(state, "v1", 0.18);
    expect(r.result).toBe(0.25);
    state = r.state;
    r = demoOps.setCommonPrice(state, "v1", null);
    expect(r.result).toBe(0.18);
    expect(r.state.commonPrices).toEqual({});
  });

  it("refuses a price that is not dollars to the cent", () => {
    const state = initialCollectionState();
    expect(() => demoOps.setCommonPrice(state, "v1", -1)).toThrow(DemoRefusal);
    expect(() => demoOps.setCommonPrice(state, "v1", 0.255)).toThrow(DemoRefusal);
    // Float dollars that are whole cents are fine.
    expect(demoOps.setCommonPrice(state, "v1", 0.29).state.commonPrices).toEqual({ v1: 0.29 });
  });
});

describe("priceText", () => {
  const line = (patch: Partial<Copy>): Copy => ({
    id: "c1",
    cardId: "k1",
    homeId: "box1",
    homeKind: "box",
    upForTrade: false,
    quantity: 1,
    acquiredAt: "",
    notes: "",
    ...patch,
  });

  it("names a box line's own floor first, else the common price", () => {
    expect(priceText(line({ minPrice: 0.5 }), 0.25)).toBe("$0.50");
    expect(priceText(line({}), 0.25)).toBe("$0.25, common");
    expect(priceText(line({}), null)).toBeNull();
  });

  it("says nothing for a binder line", () => {
    expect(priceText(line({ homeKind: "binder", minPrice: 0.5 }), 0.25)).toBeNull();
  });
});
