import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { checklistGateLine, intakeGateLine, useListingLock } from "./ListingGate";
import { stubListing } from "./stubListing";
import { CollectionStoreContext, type CollectionData, type CollectionStoreValue } from "../../data/store";
import { REAL_CAPABILITIES, type ListingGateView } from "../../data/types";

/**
 * NEO-370 — the screens' copy of the listing gate: `useListingLock` combines
 * the server's answer (`listingGate.forHome`) with what the copy will carry,
 * by the same rule the writers enforce (`lib/listingReadiness`).
 */
function lockWith(gate: ListingGateView | undefined, input: Partial<Parameters<typeof useListingLock>[0]> = {}) {
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: {} as CollectionData,
    actions: {},
    listing: stubListing({ useGate: () => gate }),
  } as CollectionStoreValue;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CollectionStoreContext.Provider value={value}>{children}</CollectionStoreContext.Provider>
  );
  return renderHook(() => useListingLock({ homeId: "box1", variantId: "v1", condition: "Excellent", ...input }), { wrapper })
    .result.current;
}

const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null };

afterEach(cleanup);

describe("useListingLock", () => {
  it("holds a listed box with no price anywhere", () => {
    expect(lockWith(HELD)).toMatchObject({ locked: true, needsPrice: true, needsCondition: false, syncing: true });
  });

  it("a price of the copy's own, even $0, or a common price lifts it", () => {
    expect(lockWith(HELD, { ownPriceCents: 0 }).locked).toBe(false);
    expect(lockWith({ ...HELD, commonPriceCents: 25 }).locked).toBe(false);
  });

  it("a missing condition holds it too; a graded copy is never held", () => {
    expect(lockWith({ ...HELD, commonPriceCents: 25 }, { condition: undefined })).toMatchObject({
      locked: true,
      needsCondition: true,
    });
    expect(lockWith(HELD, { graded: true, condition: undefined }).locked).toBe(false);
  });

  it("nothing is held while the gate loads, where it does not apply, or in a store with no listing", () => {
    expect(lockWith(undefined)).toMatchObject({ locked: false, syncing: false });
    expect(lockWith({ syncing: true, applies: false, commonPriceCents: null }).locked).toBe(false);
    const bare = renderHook(() => useListingLock({ homeId: "box1", variantId: "v1", condition: "Excellent" }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <CollectionStoreContext.Provider
          value={{ kind: "demo", capabilities: { ...REAL_CAPABILITIES, marketplaceListing: false }, data: {}, actions: {} } as never}
        >
          {children}
        </CollectionStoreContext.Provider>
      ),
    }).result.current;
    expect(bare.locked).toBe(false);
  });
});

describe("the gate's lines", () => {
  it("say what is missing and where to fix it, on each screen", () => {
    expect(checklistGateLine("Show box", { needsPrice: true, needsCondition: true })).toBe(
      "Price and condition first! Show box sells on your marketplaces, so set a common price above and pick a default condition in Profile → Settings before you stock it.",
    );
    expect(checklistGateLine("Show box", { needsPrice: false, needsCondition: true })).toBe(
      "Condition first! Show box sells on your marketplaces, so pick a default condition in Profile → Settings before you stock it.",
    );
    expect(intakeGateLine("Show box", { needsPrice: false, needsCondition: true })).toBe(
      "Condition first! Show box sells on your marketplaces, so pick a condition in Defaults before you send photos.",
    );
  });
});
