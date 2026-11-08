import { describe, expect, test } from "vitest";
import { foldBscTargets, type ListingCopy } from "./bscSheetPlan";
import { hasListingCondition, intakeRunReadiness, listingFloorCents, listingReadiness } from "./listingReadiness";
import type { Id } from "../_generated/dataModel";
import { encodeId } from "./convexIdCodec";

/** A well-formed id (the SKU builder checks), as `bscSheetPlan.test.ts` mints them. */
function idOf(table: number, seed: number): string {
  const bytes = new Uint8Array(16);
  bytes[0] = seed & 0xff;
  return encodeId(table, bytes);
}

describe("listingFloorCents: the copy's own price, else the common price", () => {
  test.each([
    [50, 25, 50],
    [0, 25, 0],
    [undefined, 25, 25],
    [null, 25, 25],
    [undefined, null, null],
    [undefined, undefined, null],
  ])("own %s, common %s -> %s", (own, common, out) => {
    expect(listingFloorCents(own, common)).toBe(out);
  });
});

describe("hasListingCondition", () => {
  test("any NB condition counts; none, or a blank, does not", () => {
    expect(hasListingCondition("Poor")).toBe(true);
    expect(hasListingCondition("Near Mint")).toBe(true);
    expect(hasListingCondition(undefined)).toBe(false);
    expect(hasListingCondition(null)).toBe(false);
    expect(hasListingCondition("")).toBe(false);
  });
});

describe("listingReadiness", () => {
  const base = { applies: true, condition: "Excellent", commonPriceCents: null } as const;

  test("the gate not applying is always ready", () => {
    expect(listingReadiness({ ...base, applies: false, condition: undefined })).toEqual({
      ready: true,
      needsPrice: false,
      needsCondition: false,
    });
  });

  test("no price anywhere needs a price", () => {
    expect(listingReadiness(base)).toEqual({ ready: false, needsPrice: true, needsCondition: false });
  });

  test("an override or a common price is a price", () => {
    expect(listingReadiness({ ...base, ownPriceCents: 10 }).ready).toBe(true);
    expect(listingReadiness({ ...base, commonPriceCents: 25 }).ready).toBe(true);
  });

  test("a condition the listing can't use is missing", () => {
    expect(listingReadiness({ ...base, commonPriceCents: 25, condition: undefined })).toEqual({
      ready: false,
      needsPrice: false,
      needsCondition: true,
    });
    expect(listingReadiness({ ...base, condition: "" })).toEqual({ ready: false, needsPrice: true, needsCondition: true });
  });

  test("a graded copy is never held to either", () => {
    expect(listingReadiness({ ...base, graded: true, condition: undefined }).ready).toBe(true);
  });
});

describe("the drain reads the same rule", () => {
  const copy = (extra: Partial<ListingCopy>): ListingCopy => ({
    copyId: idOf(10003, 1) as Id<"collectionCopies">,
    homeId: idOf(10002, 1) as Id<"collectionContainers">,
    card: { kind: "catalog", id: idOf(10001, 1) as Id<"cardChecklist"> },
    homeIsBox: true,
    graded: false,
    quantity: 1,
    condition: "Excellent",
    creationTime: 1,
    hasPhotos: false,
    ...extra,
  });

  test("a copy the gate calls ready gets a price in the fold; one it holds gets none", () => {
    const priced = foldBscTargets({ copies: [copy({ minPriceCents: 40 })], era: "modern", commonPriceCents: null });
    expect(priced.targets[0].priceCents).toBe(listingFloorCents(40, null));
    const common = foldBscTargets({ copies: [copy({})], era: "modern", commonPriceCents: 25 });
    expect(common.targets[0].priceCents).toBe(25);
    const none = foldBscTargets({ copies: [copy({})], era: "modern", commonPriceCents: null });
    expect(none.targets[0].priceCents).toBeNull();
    expect(listingReadiness({ applies: true, condition: "Excellent", commonPriceCents: null }).needsPrice).toBe(true);
  });

  test("a copy with no condition is the drain's no_condition, and the gate's needsCondition", () => {
    const fold = foldBscTargets({ copies: [copy({ condition: undefined })], era: "modern", commonPriceCents: 25 });
    expect(fold.problems.map((p) => p.reason)).toEqual(["no_condition"]);
    expect(listingReadiness({ applies: true, condition: undefined, commonPriceCents: 25 }).needsCondition).toBe(true);
  });
});

describe("intakeRunReadiness (NEO-452)", () => {
  const base = { applies: true, condition: "Excellent", commonPriceCents: null, hasVariant: true } as const;

  test("no set needs the set, and never says a price is missing: there is no common price to look up yet", () => {
    expect(intakeRunReadiness({ ...base, hasVariant: false })).toEqual({
      ready: false,
      needsSet: true,
      needsPrice: false,
      needsCondition: false,
    });
  });

  test("no set stays unready whether or not the gate applies or a price of its own is given", () => {
    for (const applies of [true, false]) {
      for (const ownPriceCents of [undefined, 0, 50]) {
        const out = intakeRunReadiness({ ...base, applies, ownPriceCents, hasVariant: false });
        expect(out).toMatchObject({ ready: false, needsSet: true, needsPrice: false });
      }
    }
  });

  test("no set still reports a missing condition", () => {
    expect(intakeRunReadiness({ ...base, hasVariant: false, condition: undefined })).toMatchObject({
      needsSet: true,
      needsPrice: false,
      needsCondition: true,
    });
  });

  test("with a set it answers as listingReadiness does, plus needsSet false", () => {
    const cases = [
      { ...base },
      { ...base, applies: false, condition: undefined },
      { ...base, ownPriceCents: 0 },
      { ...base, commonPriceCents: 25 },
      { ...base, condition: undefined },
      { ...base, condition: undefined, commonPriceCents: 25 },
      { ...base, graded: true, condition: undefined },
    ];
    for (const input of cases) {
      const { hasVariant: _hasVariant, ...listing } = input;
      expect(intakeRunReadiness(input)).toEqual({ ...listingReadiness(listing), needsSet: false });
    }
  });

  test("a set with no price on a listed box needs a price, so the screen can warn once a set is picked", () => {
    expect(intakeRunReadiness(base)).toEqual({ ready: false, needsSet: false, needsPrice: true, needsCondition: false });
  });

  test("a zero price of its own is a price", () => {
    expect(intakeRunReadiness({ ...base, ownPriceCents: 0 })).toMatchObject({ ready: true, needsPrice: false });
  });
});
